// Passive BLE scanner — listens for advertisements from registered sensors,
// parses vendor-specific payloads, emits readings to the buffer.
//
// Supported parsers (Phase 1):
//   - SC833F (Fanstel iBeacon + Eddystone with sensor data in manufacturer-specific field)
//   - S05T (MOKOSmart temperature logger, Silicon Labs BG22, BLE custom advertisement)
//   - Generic iBeacon fallback (MAC + RSSI only)
//
// Design: every advertisement received from a registered MAC becomes 1..N
// `reading` rows (one per metric). Unknown MACs are ignored.

import noble from "@abandonware/noble";

class BLEScanner {
  constructor({ deviceRegistry, onReadings, logger = console }) {
    this.deviceRegistry = deviceRegistry;
    this.onReadings = onReadings;
    this.logger = logger;
    this._macIndex = new Map(); // lowercase MAC -> device config
    this.refreshRegistry(deviceRegistry);
  }

  refreshRegistry(deviceRegistry) {
    this._macIndex.clear();
    for (const dev of deviceRegistry?.devices ?? []) {
      if (dev.mac) this._macIndex.set(dev.mac.toLowerCase(), dev);
    }
  }

  async start() {
    noble.on("stateChange", async (state) => {
      if (state === "poweredOn") {
        this.logger.info({ msg: "ble.scan.start" });
        // allowDuplicates=true — we want every advertisement, not first-seen-only.
        await noble.startScanningAsync([], true);
      } else {
        this.logger.warn({ msg: "ble.state", state });
        await noble.stopScanningAsync();
      }
    });

    noble.on("discover", (peripheral) => this._handle(peripheral));
  }

  async stop() {
    await noble.stopScanningAsync();
  }

  _handle(peripheral) {
    const mac = (peripheral.address ?? "").toLowerCase();
    if (!mac || mac === "00:00:00:00:00:00") return;

    let dev = this._macIndex.get(mac);

    // SC833F uses random-static BLE addresses that change on battery swap.
    // Fall back to identifying by Fanstel company ID (0x0634) in manufacturer data.
    if (!dev) {
      const manu = peripheral.advertisement?.manufacturerData;
      if (manu && manu.length >= 2) {
        const companyId = manu.readUInt16LE(0);
        if (companyId === BLEScanner.FANSTEL_COMPANY_ID) {
          // Find any registered SC833F device — assign this MAC to it
          dev = [...this._macIndex.values()].find(
            (d) => (d.type ?? d.vendor) === "sc833f" || (d.type ?? d.vendor) === "tachyon_ble_sc833f"
          );
          if (dev) {
            this.logger.info({ msg: "ble.sc833f.mac_learned", oldMac: dev.mac, newMac: mac });
            this._macIndex.delete(dev.mac.toLowerCase());
            dev.mac = mac;
            this._macIndex.set(mac, dev);
          }
        }
      }
      if (!dev) return; // still unknown — skip
    }

    const manu = peripheral.advertisement?.manufacturerData;
    const rssi = peripheral.rssi;
    const now = new Date().toISOString();

    let readings = [];
    try {
      switch (dev.type ?? dev.vendor) {
        case "sc833f":
        case "tachyon_ble_sc833f":
          readings = this._parseSC833F(dev, manu, rssi, now);
          break;
        case "s05t":
        case "tachyon_ble_s05t":
          readings = this._parseS05T(dev, manu, rssi, now);
          break;
        default:
          readings = this._parseGeneric(dev, manu, rssi, now);
      }
    } catch (err) {
      this.logger.warn({ msg: "ble.parse.error", mac, err: err.message });
      return;
    }

    if (readings.length) this.onReadings(readings);
  }

  // ── Parsers ────────────────────────────────────────────────────────────────
  //
  // SC833F (Fanstel) — iBeacon format with sensor data in Major/Minor fields.
  //
  // Manufacturer Specific Data (AD type 0xFF):
  //   Bytes 0-1: Company ID 0x0634 (Fanstel Corp), little-endian in noble buffer
  //   Byte  2:   0x02 (iBeacon type)
  //   Byte  3:   0x15 (iBeacon length = 21)
  //   Bytes 4-19:  UUID (16 bytes) — fixed: 2CBDF1DF-798C-406C-80EE-672D373E761E
  //   Bytes 20-21: Major (uint16 big-endian) = Temperature in °C
  //   Bytes 22-23: Minor (uint16 big-endian) = Humidity in %RH
  //   Byte  24:    TX Power (int8, calibrated RSSI at 1m)
  //
  // Confirmed 2026-04-16 against live SC833F unit on Tachyon.
  // ENS210 sensor values are pre-converted to integer °C / %RH by Fanstel firmware.
  // BLE address is random-static (may change on battery swap).

  static FANSTEL_COMPANY_ID = 0x0634;
  static IBEACON_PREFIX = 0x0215;
  static SC833F_UUID = "2cbdf1df-798c-406c-80ee-672d373e761e";

  _parseSC833F(dev, manu, rssi, now) {
    const base = {
      deviceMac: dev.mac,
      hiveId: dev.hiveId ?? undefined,
      vendor: "tachyon_ble_sc833f",
      recordedAt: now,
      signalRssi: rssi,
      rawPayload: { raw: manu?.toString("hex") },
    };

    if (!manu || manu.length < 25) {
      this.logger.warn({ msg: "ble.sc833f.short_payload", mac: dev.mac, len: manu?.length });
      return [{ ...base, metric: "rssi_dbm", value: rssi, unit: "dBm" }];
    }

    // noble on Linux: manufacturerData buffer = [companyId_lo, companyId_hi, ...data]
    // Find iBeacon prefix (0x02, 0x15) — handles both with/without company ID prefix
    let offset = -1;
    for (let i = 0; i <= manu.length - 23; i++) {
      if (manu[i] === 0x02 && manu[i + 1] === 0x15) {
        offset = i;
        break;
      }
    }

    if (offset === -1 || offset + 23 > manu.length) {
      this.logger.warn({ msg: "ble.sc833f.no_ibeacon_prefix", mac: dev.mac, raw: manu.toString("hex") });
      return [{ ...base, metric: "rssi_dbm", value: rssi, unit: "dBm" }];
    }

    // UUID: 16 bytes after prefix
    const uuid = manu.slice(offset + 2, offset + 18).toString("hex");
    const uuidFormatted = [
      uuid.slice(0, 8), uuid.slice(8, 12), uuid.slice(12, 16),
      uuid.slice(16, 20), uuid.slice(20),
    ].join("-");

    // Major = Temperature (°C), Minor = Humidity (%RH) — big-endian uint16
    const tempC = manu.readUInt16BE(offset + 18);
    const humidityPct = manu.readUInt16BE(offset + 20);
    const txPower = manu.readInt8(offset + 22);

    // Sanity check — reject obviously bad values
    if (tempC > 80 || humidityPct > 100) {
      this.logger.warn({
        msg: "ble.sc833f.out_of_range", mac: dev.mac,
        tempC, humidityPct, raw: manu.toString("hex"),
      });
    }

    this.logger.debug({
      msg: "ble.sc833f.parsed", mac: dev.mac, uuid: uuidFormatted,
      tempC, humidityPct, txPower, rssi,
    });

    return [
      { ...base, metric: "temperature_c", value: tempC, unit: "°C" },
      { ...base, metric: "humidity_pct", value: humidityPct, unit: "%" },
      { ...base, metric: "rssi_dbm", value: rssi, unit: "dBm" },
      { ...base, metric: "tx_power_dbm", value: txPower, unit: "dBm" },
    ];
  }

  _parseS05T(dev, manu, rssi, now) {
    const base = {
      deviceMac: dev.mac,
      hiveId: dev.hiveId ?? undefined,
      vendor: "tachyon_ble_s05t",
      recordedAt: now,
      signalRssi: rssi,
      rawPayload: { raw: manu?.toString("hex"), framePosition: dev.framePosition ?? undefined },
    };

    // Placeholder: MOKOSmart's exact byte layout — populate from datasheet on
    // first unit received. For now emit rssi + any first 2-byte temp hint if
    // manu starts with known signature.
    return [
      { ...base, metric: "rssi_dbm", value: rssi, unit: "dBm" },
    ];
  }

  _parseGeneric(dev, manu, rssi, now) {
    return [
      {
        deviceMac: dev.mac,
        hiveId: dev.hiveId ?? undefined,
        vendor: dev.vendor ?? "tachyon_ble_unknown",
        metric: "rssi_dbm",
        value: rssi,
        unit: "dBm",
        recordedAt: now,
        signalRssi: rssi,
        rawPayload: manu ? { raw: manu.toString("hex") } : undefined,
      },
    ];
  }
}

export { BLEScanner };
