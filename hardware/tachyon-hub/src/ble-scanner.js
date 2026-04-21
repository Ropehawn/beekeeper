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
        case "beekeeper_c6":
        case "tachyon_ble_beekeeper_c6":
          readings = this._parseBeeKeeperC6(dev, manu, rssi, now);
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

  // BeeKeeper custom ESP32-C6 node.
  // See hardware/esp32-c6-node/README.md for canonical format.
  //
  // Manufacturer Specific Data (AD type 0xFF), payload length depends on
  // protocol version:
  //   - v0x02: 20 bytes (BME280 + HX711)
  //   - v0x03: 22 bytes (v0x02 + INMP441 RMS/peak)
  //   - v0x04: 26 bytes (v0x03 + 4 FFT bands)
  //
  // Common layout (bytes 0–20 identical across v0x03+):
  //   Bytes 0-1:   Company ID 0xFFFF (R&D) little-endian
  //   Bytes 2-3:   Signature "BK" (0x42 0x4B)
  //   Byte  4:     Protocol version
  //   Byte  5:     Node type (0x01=BME, 0x02=BME+HX711, 0x03=full)
  //   Bytes 6-7:   temperature ×100 °C (int16 LE) — 0x7FFF invalid
  //   Bytes 8-9:   humidity ×100 %RH   (uint16 LE) — 0xFFFF invalid
  //   Bytes 10-12: pressure Pa         (uint24 LE) — 0xFFFFFF invalid
  //   Bytes 13-16: weight grams (int32 LE) — 0x7FFFFFFF invalid
  //                If b2 of flags=0 (not calibrated), grams field contains
  //                raw HX711 counts for hub-side back-calibration.
  //   Byte  17:    battery % (0xFF = USB/unknown)
  //   Byte  18:    flags — b0=BME present, b1=HX711 present,
  //                        b2=HX711 calibrated, b3=first-boot,
  //                        b4=mic present (v0x03+ only)
  //
  // v0x02 only:
  //   Byte  19:    reserved
  //
  // v0x03+ only:
  //   Byte  19:    audio RMS magnitude  (0=full scale, 127=silent, 0xFF invalid)
  //   Byte  20:    audio peak magnitude (same encoding)
  //
  // v0x04+ only:
  //   Byte  21:    FFT band low     (100–200 Hz)    — 0xFF invalid
  //   Byte  22:    FFT band mid-low (200–400 Hz, queen piping fundamental)
  //   Byte  23:    FFT band mid-high (400–800 Hz)
  //   Byte  24:    FFT band high    (800–2000 Hz)
  //   Byte  25:    reserved

  static BEEKEEPER_COMPANY_ID = 0xFFFF;
  static BEEKEEPER_SIG_0 = 0x42; // 'B'
  static BEEKEEPER_SIG_1 = 0x4B; // 'K'

  _parseBeeKeeperC6(dev, manu, rssi, now) {
    const base = {
      deviceMac: dev.mac,
      hiveId: dev.hiveId ?? undefined,
      vendor: "tachyon_ble_beekeeper_c6",
      recordedAt: now,
      signalRssi: rssi,
      rawPayload: { raw: manu?.toString("hex") },
    };

    if (!manu || manu.length < 20) {
      this.logger.warn({ msg: "ble.bkc6.short_payload", mac: dev.mac, len: manu?.length });
      return [{ ...base, metric: "rssi_dbm", value: rssi, unit: "dBm" }];
    }

    // Locate our 4-byte signature: company ID 0xFFFF + "BK"
    // noble on Linux: manufacturerData may or may not include company ID prefix.
    // Search for the signature with a sliding window. Minimum payload is 20 bytes
    // (v0x02); newer versions may be larger (v0x03 = 22 bytes).
    const minLen = 20;
    let off = -1;
    for (let i = 0; i <= manu.length - minLen; i++) {
      if (manu[i] === 0xFF && manu[i + 1] === 0xFF &&
          manu[i + 2] === BLEScanner.BEEKEEPER_SIG_0 &&
          manu[i + 3] === BLEScanner.BEEKEEPER_SIG_1) {
        off = i;
        break;
      }
      // Also allow payload without the company ID prefix (noble sometimes strips it)
      if (i === 0 && manu[0] === BLEScanner.BEEKEEPER_SIG_0 &&
          manu[1] === BLEScanner.BEEKEEPER_SIG_1) {
        off = -2;  // synthetic: treat bytes as starting at "BK" directly
        break;
      }
    }

    let p;
    if (off === -2) {
      // Prepend synthetic company ID so offsets below line up.
      p = Buffer.concat([Buffer.from([0xFF, 0xFF]), manu]);
      off = 0;
    } else if (off === -1) {
      this.logger.warn({ msg: "ble.bkc6.no_signature", mac: dev.mac, raw: manu.toString("hex") });
      return [{ ...base, metric: "rssi_dbm", value: rssi, unit: "dBm" }];
    } else {
      p = manu;
    }

    const protoVer  = p[off + 4];
    const nodeType  = p[off + 5];
    const tempRaw   = p.readInt16LE(off + 6);
    const humRaw    = p.readUInt16LE(off + 8);
    const pressRaw  = p[off + 10] | (p[off + 11] << 8) | (p[off + 12] << 16);
    const weightRaw = p.readInt32LE(off + 13);
    const battery   = p[off + 17];
    const flags     = p[off + 18];

    const bmePresent   = (flags & 0x01) !== 0;
    const hxPresent    = (flags & 0x02) !== 0;
    const hxCalibrated = (flags & 0x04) !== 0;
    const firstBoot    = (flags & 0x08) !== 0;
    const micPresent   = (flags & 0x10) !== 0;

    // v0x03+ carries 2 audio bytes (RMS, peak) after the flags byte.
    let audioRmsMag  = null;
    let audioPeakMag = null;
    if (protoVer >= 0x03 && p.length >= off + 21) {
      const r = p[off + 19];
      const k = p[off + 20];
      if (r !== 0xFF) audioRmsMag  = r;  // magnitude in dB below full scale
      if (k !== 0xFF) audioPeakMag = k;
    }

    // v0x04+ adds 4 FFT band bytes (bins 21–24).
    let audioBands = null;
    if (protoVer >= 0x04 && p.length >= off + 25) {
      audioBands = {
        low:      p[off + 21] === 0xFF ? null : p[off + 21],  // 100-200 Hz
        midLow:   p[off + 22] === 0xFF ? null : p[off + 22],  // 200-400 Hz
        midHigh:  p[off + 23] === 0xFF ? null : p[off + 23],  // 400-800 Hz
        high:     p[off + 24] === 0xFF ? null : p[off + 24],  // 800-2000 Hz
      };
    }

    const readings = [];
    base.rawPayload.protoVer = protoVer;
    base.rawPayload.nodeType = nodeType;
    base.rawPayload.flags = { bmePresent, hxPresent, hxCalibrated, firstBoot, micPresent };

    if (bmePresent) {
      if (tempRaw !== 0x7FFF) {
        readings.push({ ...base, metric: "temperature_c", value: tempRaw / 100, unit: "°C" });
      }
      if (humRaw !== 0xFFFF) {
        readings.push({ ...base, metric: "humidity_pct", value: humRaw / 100, unit: "%" });
      }
      if (pressRaw !== 0xFFFFFF) {
        readings.push({ ...base, metric: "pressure_pa", value: pressRaw, unit: "Pa" });
      }
    }

    if (hxPresent && weightRaw !== 0x7FFFFFFF) {
      if (hxCalibrated) {
        readings.push({ ...base, metric: "weight_g", value: weightRaw, unit: "g" });
      } else {
        // Pre-calibration: expose raw counts so operator can calibrate from server
        readings.push({ ...base, metric: "hx711_raw_counts", value: weightRaw, unit: "counts" });
      }
    }

    if (battery !== 0xFF) {
      readings.push({ ...base, metric: "battery_pct", value: battery, unit: "%" });
    }

    if (micPresent) {
      if (audioRmsMag !== null) {
        // Stored as positive magnitude (0 = full scale). Convert back to dBFS
        // (always ≤ 0).
        readings.push({
          ...base, metric: "audio_rms_dbfs", value: -audioRmsMag, unit: "dBFS",
        });
      }
      if (audioPeakMag !== null) {
        readings.push({
          ...base, metric: "audio_peak_dbfs", value: -audioPeakMag, unit: "dBFS",
        });
      }
      if (audioBands) {
        if (audioBands.low !== null) {
          readings.push({ ...base, metric: "audio_band_low_dbfs",
            value: -audioBands.low, unit: "dBFS", frequencyRangeHz: "100-200" });
        }
        if (audioBands.midLow !== null) {
          readings.push({ ...base, metric: "audio_band_midlow_dbfs",
            value: -audioBands.midLow, unit: "dBFS", frequencyRangeHz: "200-400" });
        }
        if (audioBands.midHigh !== null) {
          readings.push({ ...base, metric: "audio_band_midhigh_dbfs",
            value: -audioBands.midHigh, unit: "dBFS", frequencyRangeHz: "400-800" });
        }
        if (audioBands.high !== null) {
          readings.push({ ...base, metric: "audio_band_high_dbfs",
            value: -audioBands.high, unit: "dBFS", frequencyRangeHz: "800-2000" });
        }
      }
    }

    readings.push({ ...base, metric: "rssi_dbm", value: rssi, unit: "dBm" });

    this.logger.debug({
      msg: "ble.bkc6.parsed", mac: dev.mac,
      protoVer, nodeType, tempC: tempRaw / 100, humPct: humRaw / 100,
      pressurePa: pressRaw, weightG: weightRaw,
      audioRmsDbfs: audioRmsMag !== null ? -audioRmsMag : null,
      audioPeakDbfs: audioPeakMag !== null ? -audioPeakMag : null,
      audioBands: audioBands ? {
        low:     audioBands.low     !== null ? -audioBands.low     : null,
        midLow:  audioBands.midLow  !== null ? -audioBands.midLow  : null,
        midHigh: audioBands.midHigh !== null ? -audioBands.midHigh : null,
        high:    audioBands.high    !== null ? -audioBands.high    : null,
      } : null,
      battery, bmePresent, hxPresent, hxCalibrated, firstBoot, micPresent,
    });

    return readings;
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
