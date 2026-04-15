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
    if (!mac) return;

    const dev = this._macIndex.get(mac);
    if (!dev) return; // unknown MAC — skip

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
  // SC833F broadcasts as iBeacon/Eddystone. Fanstel provides a factory firmware
  // where sensor data is packed in manufacturer-specific data. Exact byte layout
  // depends on firmware revision — placeholder parser that extracts what we can
  // from the raw bytes + fills from `peripheral.advertisement.serviceData`. Real
  // parser will be finalized against actual hardware once SC833F units arrive.

  _parseSC833F(dev, manu, rssi, now) {
    const base = {
      deviceMac: dev.mac,
      hiveId: dev.hiveId ?? undefined,
      vendor: "tachyon_ble_sc833f",
      recordedAt: now,
      signalRssi: rssi,
      rawPayload: { raw: manu?.toString("hex") },
    };

    // Placeholder: without firmware docs finalized, we emit rssi-only and let
    // the first live SC833F unit tell us the actual byte layout in
    // `raw_payload` so we can iterate.
    return [
      { ...base, metric: "rssi_dbm", value: rssi, unit: "dBm" },
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
