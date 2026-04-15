// Local SQLite buffer for store-and-forward during network outages.
// Retention: 7 days, rolling oldest-drop.

import Database from "better-sqlite3";
import path from "node:path";

class Buffer {
  constructor(dataDir) {
    const dbPath = path.join(dataDir, "readings.sqlite");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS readings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        device_mac  TEXT,
        hive_id     TEXT,
        vendor      TEXT NOT NULL,
        metric      TEXT NOT NULL,
        value       REAL NOT NULL,
        unit        TEXT NOT NULL,
        quality     REAL,
        battery_v   REAL,
        signal_rssi REAL,
        raw_payload TEXT,
        recorded_at TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_recorded_at ON readings (recorded_at);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO readings (device_mac, hive_id, vendor, metric, value, unit, quality, battery_v, signal_rssi, raw_payload, recorded_at)
      VALUES (@deviceMac, @hiveId, @vendor, @metric, @value, @unit, @quality, @batteryV, @signalRssi, @rawPayload, @recordedAt)
    `);

    this.drainStmt = this.db.prepare(`SELECT * FROM readings ORDER BY id ASC LIMIT ?`);
    this.deleteStmt = this.db.prepare(`DELETE FROM readings WHERE id <= ?`);
    this.countStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM readings`);
    this.prune7dStmt = this.db.prepare(`DELETE FROM readings WHERE recorded_at < datetime('now', '-7 days')`);
  }

  insert(reading) {
    this.insertStmt.run({
      deviceMac: reading.deviceMac ?? null,
      hiveId: reading.hiveId ?? null,
      vendor: reading.vendor,
      metric: reading.metric,
      value: reading.value,
      unit: reading.unit,
      quality: reading.quality ?? null,
      batteryV: reading.batteryV ?? null,
      signalRssi: reading.signalRssi ?? null,
      rawPayload: reading.rawPayload ? JSON.stringify(reading.rawPayload) : null,
      recordedAt: new Date(reading.recordedAt ?? Date.now()).toISOString(),
    });
  }

  insertMany(readings) {
    const tx = this.db.transaction((rows) => {
      for (const r of rows) this.insert(r);
    });
    tx(readings);
  }

  drain(batchSize) {
    const rows = this.drainStmt.all(batchSize);
    if (!rows.length) return { batch: [], lastId: 0 };
    return {
      batch: rows.map((r) => ({
        deviceMac: r.device_mac ?? undefined,
        hiveId: r.hive_id ?? undefined,
        vendor: r.vendor,
        metric: r.metric,
        value: r.value,
        unit: r.unit,
        quality: r.quality ?? undefined,
        batteryV: r.battery_v ?? undefined,
        signalRssi: r.signal_rssi ?? undefined,
        rawPayload: r.raw_payload ? JSON.parse(r.raw_payload) : undefined,
        recordedAt: r.recorded_at,
      })),
      lastId: rows[rows.length - 1].id,
    };
  }

  acknowledge(lastId) {
    this.deleteStmt.run(lastId);
  }

  pending() {
    return this.countStmt.get().n;
  }

  pruneOld() {
    return this.prune7dStmt.run().changes;
  }
}

export { Buffer };
