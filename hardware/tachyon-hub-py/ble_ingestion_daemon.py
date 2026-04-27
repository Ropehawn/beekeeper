#!/usr/bin/env python3
"""
BeeKeeper BLE Ingestion Daemon
Continuously scans for BLE sensors, batches readings, and uploads to the
BeeKeeper API every upload cycle.

Supported sensors:
  - Fanstel SC833F  (iBeacon, company ID 0x0634)
  - BeeKeeper C6    (custom v0x02–v0x04, company ID 0xFFFF + "BK" signature)

Runs as a systemd service on the Tachyon hub.
"""

import asyncio
import json
import struct
import sys
import time
import logging
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

CONFIG_PATH = Path.home() / "beekeeper-ai" / "hub-config.json"
DEVICE_CACHE_PATH = Path.home() / "beekeeper-ai" / "device_cache.json"

# Fanstel SC833F
FANSTEL_COMPANY_ID = 0x0634

# BeeKeeper C6 — company ID 0xFFFF (R&D) + "BK" signature
BEEKEEPER_COMPANY_ID = 0xFFFF
BEEKEEPER_SIG = b"BK"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("ble-daemon")


def parse_bk_c6_payload(data: bytes) -> dict | None:
    """
    Parse a BeeKeeper C6 manufacturer-specific data payload.

    bleak strips the 2-byte company ID before delivering to the callback, so
    `data` here starts at the "BK" signature (bytes 0-1), not at the company ID.

    Wire layout after company-ID strip (matches ble-scanner.js with off -= 2):
      [0-1]   "BK" signature
      [2]     protocol version (0x02 / 0x03 / 0x04)
      [3]     node type
      [4-5]   temperature × 100 °C  (int16 LE, 0x7FFF = invalid)
      [6-7]   humidity × 100 %RH    (uint16 LE, 0xFFFF = invalid)
      [8-10]  pressure Pa           (uint24 LE, 0xFFFFFF = invalid)
      [11-14] weight grams / raw HX711 counts (int32 LE, 0x7FFFFFFF = invalid)
      [15]    battery %             (0xFF = USB/unknown)
      [16]    flags (b0=BME, b1=HX711, b2=calibrated, b3=first-boot, b4=mic)
    v0x03+:
      [17]    audio RMS magnitude   (dB below FS, 0xFF = invalid)
      [18]    audio peak magnitude  (dB below FS, 0xFF = invalid)
    v0x04+:
      [19]    FFT band low     100–200 Hz  (0xFF = invalid)
      [20]    FFT band mid-low 200–400 Hz  (queen piping fundamental)
      [21]    FFT band mid-high 400–800 Hz
      [22]    FFT band high    800–2000 Hz
      [23]    reserved

    Returns a dict of metric → value, or None if payload is too short / invalid.
    """
    if len(data) < 17:
        return None
    if data[0:2] != BEEKEEPER_SIG:
        return None

    proto_ver = data[2]
    flags     = data[16]

    bme_present    = bool(flags & 0x01)
    hx_present     = bool(flags & 0x02)
    hx_calibrated  = bool(flags & 0x04)
    mic_present    = bool(flags & 0x10)

    readings = {}

    if bme_present:
        temp_raw  = struct.unpack_from("<h", data, 4)[0]   # int16 LE
        hum_raw   = struct.unpack_from("<H", data, 6)[0]   # uint16 LE
        press_raw = data[8] | (data[9] << 8) | (data[10] << 16)

        if temp_raw  != 0x7FFF:   readings["temperature_c"] = temp_raw  / 100.0
        if hum_raw   != 0xFFFF:   readings["humidity_pct"]  = hum_raw   / 100.0
        if press_raw != 0xFFFFFF: readings["pressure_pa"]   = float(press_raw)

    if hx_present:
        weight_raw = struct.unpack_from("<i", data, 11)[0]  # int32 LE
        if weight_raw != 0x7FFFFFFF:
            key = "weight_g" if hx_calibrated else "hx711_raw_counts"
            readings[key] = float(weight_raw)

    battery = data[15]
    if battery != 0xFF:
        readings["battery_pct"] = float(battery)

    if mic_present and proto_ver >= 0x03 and len(data) >= 19:
        rms_mag  = data[17]
        peak_mag = data[18]
        if rms_mag  != 0xFF: readings["audio_rms_dbfs"]  = float(-rms_mag)
        if peak_mag != 0xFF: readings["audio_peak_dbfs"] = float(-peak_mag)

        if proto_ver >= 0x04 and len(data) >= 23:
            bands = {
                "audio_band_low_dbfs":     data[19],
                "audio_band_midlow_dbfs":  data[20],
                "audio_band_midhigh_dbfs": data[21],
                "audio_band_high_dbfs":    data[22],
            }
            for metric, mag in bands.items():
                if mag != 0xFF:
                    readings[metric] = float(-mag)

    return readings if readings else None


class BLEIngestionDaemon:
    def __init__(self):
        self.config = json.loads(CONFIG_PATH.read_text())
        self.readings_buffer = []
        self.scan_interval = self.config.get("scanIntervalSec", 60)
        self.upload_interval = self.config.get("uploadIntervalSec", 300)
        self.heartbeat_interval = self.config.get("heartbeatIntervalSec", 300)  # 5 min
        self.last_upload = time.time()
        self.last_heartbeat = 0  # force first heartbeat on startup
        self.boot_time = time.time()
        self.mac_to_device_id = {}  # MAC (upper) → sensor_devices.id (UUID)
        self.last_cache_refresh = 0
        self.cache_refresh_interval = 600  # refresh device map every 10 min
        log.info(f"Hub: {self.config['hubName']} ({self.config['hubId']})")
        log.info(f"API: {self.config['apiUrl']}")
        log.info(
            f"Scan every {self.scan_interval}s, "
            f"upload every {self.upload_interval}s, "
            f"heartbeat every {self.heartbeat_interval}s"
        )
        self.refresh_device_cache()

    def scan_ble(self, timeout=10):
        """Synchronous BLE scan using bleak. Returns dict of mac → sensor dict."""
        from bleak import BleakScanner

        found = {}

        def callback(device, adv_data):
            for cid, data in adv_data.manufacturer_data.items():

                # ── Fanstel SC833F (iBeacon) ───────────────────────────────
                if (cid == FANSTEL_COMPANY_ID and len(data) >= 21
                        and data[0] == 0x02 and data[1] == 0x15):
                    major = struct.unpack(">H", data[18:20])[0]
                    minor = struct.unpack(">H", data[20:22])[0]
                    key = device.address
                    if key not in found or adv_data.rssi > found[key]["rssi"]:
                        found[key] = {
                            "mac":          device.address,
                            "rssi":         adv_data.rssi,
                            "sensor_type":  "sc833f",
                            "temperature_c": float(major),
                            "humidity_pct":  float(minor),
                        }

                # ── BeeKeeper C6 (custom BK payload) ──────────────────────
                elif (cid == BEEKEEPER_COMPANY_ID and len(data) >= 2
                      and data[0:2] == BEEKEEPER_SIG):
                    metrics = parse_bk_c6_payload(data)
                    if metrics is None:
                        continue
                    key = device.address
                    if key not in found or adv_data.rssi > found[key]["rssi"]:
                        found[key] = {
                            "mac":         device.address,
                            "rssi":        adv_data.rssi,
                            "sensor_type": "beekeeper_c6",
                            **metrics,
                        }

        # asyncio.run() creates and manages a fresh event loop each call,
        # avoiding the DBus connection state corruption that occurs when the
        # same loop is closed and a new one is opened in the same process.
        async def _scan():
            async with BleakScanner(detection_callback=callback):
                await asyncio.sleep(timeout)

        asyncio.run(_scan())
        return found

    def refresh_device_cache(self):
        """Fetch MAC → device_id map from API. Falls back to local cache file."""
        url = f"{self.config['apiUrl']}/api/v1/hubs/devices"
        req = urllib.request.Request(url, headers={"X-Hub-Key": self.config["apiKey"]})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
                self.mac_to_device_id = {k.upper(): v for k, v in data.get("macMap", {}).items()}
                DEVICE_CACHE_PATH.write_text(json.dumps(self.mac_to_device_id, indent=2))
                self.last_cache_refresh = time.time()
                log.info(f"Device cache refreshed: {len(self.mac_to_device_id)} mappings")
        except Exception as e:
            log.warning(f"Failed to refresh device cache from API: {e}")
            if DEVICE_CACHE_PATH.exists():
                self.mac_to_device_id = json.loads(DEVICE_CACHE_PATH.read_text())
                log.info(f"Using local device cache: {len(self.mac_to_device_id)} mappings")

    def buffer_readings(self, sensors):
        """Convert scan results to API-ready readings and buffer them."""
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        if time.time() - self.last_cache_refresh > self.cache_refresh_interval:
            self.refresh_device_cache()

        for mac, s in sensors.items():
            mac_upper = s["mac"].upper()
            device_id = self.mac_to_device_id.get(mac_upper)
            sensor_type = s["sensor_type"]
            vendor = (
                "tachyon_ble_sc833f"     if sensor_type == "sc833f"
                else "tachyon_ble_beekeeper_c6"
            )

            base = {
                "deviceMac":  s["mac"],
                "vendor":     vendor,
                "signalRssi": s["rssi"],
                "recordedAt": now,
            }
            if device_id:
                base["deviceId"] = device_id

            # Emit one reading row per metric (matching Node.js hub pattern)
            METRIC_UNITS = {
                "temperature_c":          "°C",
                "humidity_pct":           "%",
                "pressure_pa":            "Pa",
                "weight_g":               "g",
                "hx711_raw_counts":       "counts",
                "battery_pct":            "%",
                "audio_rms_dbfs":         "dBFS",
                "audio_peak_dbfs":        "dBFS",
                "audio_band_low_dbfs":    "dBFS",
                "audio_band_midlow_dbfs": "dBFS",
                "audio_band_midhigh_dbfs":"dBFS",
                "audio_band_high_dbfs":   "dBFS",
            }
            for metric, unit in METRIC_UNITS.items():
                if metric in s:
                    self.readings_buffer.append(
                        {**base, "metric": metric, "value": s[metric], "unit": unit}
                    )

    def send_heartbeat(self):
        """POST /api/v1/hubs/heartbeat with diagnostics so the API knows we're alive.
        Quiet on success, logs at WARNING on failure (heartbeat failure is
        worth knowing about but never fatal — if the API is down we keep
        scanning and try again next cycle)."""
        url = f"{self.config['apiUrl']}/api/v1/hubs/heartbeat"
        payload = {
            "uptimeSec": int(time.time() - self.boot_time),
        }
        # Best-effort CPU temp (Linux thermal zone 0). Skip if not readable.
        try:
            with open("/sys/class/thermal/thermal_zone0/temp") as f:
                payload["cpuTempC"] = int(f.read().strip()) / 1000.0
        except Exception:
            pass
        # Best-effort free disk space on the home filesystem.
        try:
            import shutil
            free_bytes = shutil.disk_usage(str(Path.home())).free
            payload["storageFreeGb"] = round(free_bytes / (1024 ** 3), 2)
        except Exception:
            pass

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "X-Hub-Key": self.config["apiKey"],
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp.read()
                self.last_heartbeat = time.time()
        except Exception as e:
            log.warning(f"Heartbeat failed: {e}")

    def upload_readings(self):
        """Upload buffered readings to the BeeKeeper API."""
        if not self.readings_buffer:
            return

        payload = json.dumps({"readings": self.readings_buffer}).encode()
        url = f"{self.config['apiUrl']}/api/v1/hubs/ingest"

        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Hub-Key": self.config["apiKey"],
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read())
                log.info(f"Uploaded {result.get('accepted', 0)} readings to API")
                self.readings_buffer.clear()
                self.last_upload = time.time()
        except urllib.error.HTTPError as e:
            body = e.read().decode() if e.fp else ""
            log.error(f"Upload failed: HTTP {e.code} — {body[:200]}")
        except Exception as e:
            log.error(f"Upload failed: {e}")

    # Consecutive scan failures before we give up and let systemd restart us
    # with a fresh BlueZ connection. At scan_interval=60s, 3 failures = ~3 min
    # of in-process retries, which is enough to ride through a bluetoothd
    # restart but short enough to not sit dead for hours if something is truly
    # broken. Prior incident (Apr 21-22) had the daemon error-looping for
    # 16+ hours with no recovery.
    MAX_CONSECUTIVE_SCAN_FAILURES = 3

    @staticmethod
    def _is_dbus_error(exc) -> bool:
        """
        Heuristic: does this exception look like a BlueZ/D-Bus disconnect
        rather than a transient scan hiccup? We want to be conservative —
        false positives just mean we exit and systemd restarts us (cheap);
        false negatives mean we sit in a broken state (expensive).
        """
        msg = str(exc)
        markers = (
            "D-Bus", "DBus", "dbus",
            "AccessDenied",
            "org.freedesktop",
            "org.bluez",
            "ServiceUnknown",
            "NotConnected",
            "not connected",
            "Connection reset",
        )
        return any(m in msg for m in markers)

    def run(self):
        """Main loop: scan → buffer → upload. Exits after MAX_CONSECUTIVE_SCAN_FAILURES
        so systemd can respawn with a clean D-Bus/BlueZ connection."""
        log.info("Starting BLE ingestion daemon")
        consecutive_failures = 0

        while True:
            try:
                sensors = self.scan_ble(timeout=10)

                # Successful scan — clear failure streak and announce recovery if any.
                if consecutive_failures > 0:
                    log.info(
                        f"Recovered after {consecutive_failures} consecutive "
                        f"scan failure(s) — BlueZ connection is healthy"
                    )
                    consecutive_failures = 0

                if sensors:
                    sc833f_count = sum(1 for s in sensors.values() if s["sensor_type"] == "sc833f")
                    c6_count     = sum(1 for s in sensors.values() if s["sensor_type"] == "beekeeper_c6")
                    log.info(
                        f"Scan: {len(sensors)} sensors "
                        f"(SC833F={sc833f_count}, C6={c6_count}) — "
                        + ", ".join(
                            f"{s['mac'][-5:]}={s.get('temperature_c','?')}°C"
                            for s in sensors.values()
                        )
                    )
                    self.buffer_readings(sensors)
                else:
                    log.warning("Scan: no sensors found")

                if time.time() - self.last_upload >= self.upload_interval:
                    self.upload_readings()

                if time.time() - self.last_heartbeat >= self.heartbeat_interval:
                    self.send_heartbeat()

            except KeyboardInterrupt:
                log.info("Shutting down...")
                if self.readings_buffer:
                    log.info(f"Final upload of {len(self.readings_buffer)} buffered readings")
                    self.upload_readings()
                break
            except Exception as e:
                consecutive_failures += 1
                tag = " [D-Bus/BlueZ]" if self._is_dbus_error(e) else ""
                log.error(
                    f"Scan failed (#{consecutive_failures}/"
                    f"{self.MAX_CONSECUTIVE_SCAN_FAILURES}){tag}: {e}"
                )
                if consecutive_failures >= self.MAX_CONSECUTIVE_SCAN_FAILURES:
                    log.error(
                        f"Reached {self.MAX_CONSECUTIVE_SCAN_FAILURES} consecutive "
                        f"failures — exiting so systemd can respawn us with a "
                        f"fresh BlueZ connection."
                    )
                    sys.exit(1)

            time.sleep(self.scan_interval)


if __name__ == "__main__":
    daemon = BLEIngestionDaemon()
    daemon.run()
