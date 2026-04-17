#!/usr/bin/env python3
"""
BeeKeeper BLE Ingestion Daemon
Continuously scans for Fanstel SC833F sensors, batches readings,
and uploads to the BeeKeeper API every upload cycle.

Runs as a systemd service on the Tachyon hub.
"""

import asyncio
import json
import struct
import time
import logging
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

CONFIG_PATH = Path.home() / "beekeeper-ai" / "hub-config.json"
DEVICE_CACHE_PATH = Path.home() / "beekeeper-ai" / "device_cache.json"
FANSTEL_COMPANY_ID = 0x0634

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("ble-daemon")

class BLEIngestionDaemon:
    def __init__(self):
        self.config = json.loads(CONFIG_PATH.read_text())
        self.readings_buffer = []
        self.scan_interval = self.config.get("scanIntervalSec", 60)
        self.upload_interval = self.config.get("uploadIntervalSec", 300)
        self.last_upload = time.time()
        self.mac_to_device_id = {}  # MAC (upper) → sensor_devices.id (UUID)
        self.last_cache_refresh = 0
        self.cache_refresh_interval = 600  # refresh device map every 10 min
        log.info(f"Hub: {self.config['hubName']} ({self.config['hubId']})")
        log.info(f"API: {self.config['apiUrl']}")
        log.info(f"Scan every {self.scan_interval}s, upload every {self.upload_interval}s")
        self.refresh_device_cache()

    def scan_ble(self, timeout=10):
        """Synchronous BLE scan using bleak."""
        from bleak import BleakScanner

        found = {}

        def callback(device, adv_data):
            for cid, data in adv_data.manufacturer_data.items():
                if cid == FANSTEL_COMPANY_ID and len(data) >= 21 and data[0] == 0x02 and data[1] == 0x15:
                    major = struct.unpack('>H', data[18:20])[0]
                    minor = struct.unpack('>H', data[20:22])[0]
                    key = device.address
                    if key not in found or adv_data.rssi > found[key]["rssi"]:
                        found[key] = {
                            "mac": device.address,
                            "rssi": adv_data.rssi,
                            "temp_c": major,
                            "humidity_pct": minor,
                        }

        async def _scan():
            scanner = BleakScanner(detection_callback=callback)
            await scanner.start()
            await asyncio.sleep(timeout)
            await scanner.stop()

        loop = asyncio.new_event_loop()
        loop.run_until_complete(_scan())
        loop.close()
        return found

    def refresh_device_cache(self):
        """Fetch MAC → device_id map from API. Falls back to local cache file."""
        url = f"{self.config['apiUrl']}/api/v1/hubs/devices"
        req = urllib.request.Request(url, headers={"X-Hub-Key": self.config["apiKey"]})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
                self.mac_to_device_id = {k.upper(): v for k, v in data.get("macMap", {}).items()}
                # Persist to local cache for offline resilience
                DEVICE_CACHE_PATH.write_text(json.dumps(self.mac_to_device_id, indent=2))
                self.last_cache_refresh = time.time()
                log.info(f"Device cache refreshed: {len(self.mac_to_device_id)} mappings")
        except Exception as e:
            log.warning(f"Failed to refresh device cache from API: {e}")
            # Fall back to local cache
            if DEVICE_CACHE_PATH.exists():
                self.mac_to_device_id = json.loads(DEVICE_CACHE_PATH.read_text())
                log.info(f"Using local device cache: {len(self.mac_to_device_id)} mappings")

    def buffer_readings(self, sensors):
        """Convert scan results to API-ready readings and buffer them."""
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        # Refresh device cache periodically
        if time.time() - self.last_cache_refresh > self.cache_refresh_interval:
            self.refresh_device_cache()

        for mac, s in sensors.items():
            mac_upper = s["mac"].upper()
            device_id = self.mac_to_device_id.get(mac_upper)

            base = {
                "deviceMac": s["mac"],
                "vendor": "tachyon_ble_sc833f",
                "signalRssi": s["rssi"],
                "recordedAt": now,
            }
            if device_id:
                base["deviceId"] = device_id

            self.readings_buffer.append({**base, "metric": "temperature_c", "value": s["temp_c"], "unit": "°C"})
            self.readings_buffer.append({**base, "metric": "humidity_pct", "value": s["humidity_pct"], "unit": "%"})

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

    def run(self):
        """Main loop: scan → buffer → upload."""
        log.info("Starting BLE ingestion daemon")

        while True:
            try:
                # Scan
                sensors = self.scan_ble(timeout=10)
                if sensors:
                    log.info(f"Scan: {len(sensors)} sensors — " +
                             ", ".join(f"{s['mac'][-5:]} {s['temp_c']}°C/{s['humidity_pct']}%" for s in sensors.values()))
                    self.buffer_readings(sensors)
                else:
                    log.warning("Scan: no Fanstel sensors found")

                # Upload if interval elapsed
                if time.time() - self.last_upload >= self.upload_interval:
                    self.upload_readings()

            except KeyboardInterrupt:
                log.info("Shutting down...")
                # Final upload
                if self.readings_buffer:
                    log.info(f"Final upload of {len(self.readings_buffer)} buffered readings")
                    self.upload_readings()
                break
            except Exception as e:
                log.error(f"Error in main loop: {e}")

            time.sleep(self.scan_interval)


if __name__ == "__main__":
    daemon = BLEIngestionDaemon()
    daemon.run()
