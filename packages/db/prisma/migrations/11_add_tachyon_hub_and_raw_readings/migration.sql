-- Migration 11: Add Tachyon hub registration and richer sensor readings table
-- Additive only — no existing columns modified, no data mutated.

-- ─── hubs table ───────────────────────────────────────────────────────────────
-- Each Tachyon per apiary is a hub. api_key_hash stores a SHA-256 of the raw
-- API key; the raw key is only shown once at registration time.

CREATE TABLE IF NOT EXISTS "hubs" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "apiary_id"       UUID,
  "name"            TEXT NOT NULL,
  "platform"        TEXT NOT NULL DEFAULT 'tachyon',
  "api_key_hash"    TEXT NOT NULL,
  "device_registry" JSONB NOT NULL DEFAULT '{"devices":[]}',
  "last_heartbeat"  TIMESTAMPTZ,
  "last_uptime_sec" INTEGER,
  "last_cpu_temp_c" REAL,
  "last_storage_free_gb" REAL,
  "firmware_version" TEXT,
  "is_active"       BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "hubs_api_key_hash_idx" ON "hubs" ("api_key_hash");
CREATE INDEX IF NOT EXISTS "hubs_apiary_id_idx" ON "hubs" ("apiary_id");

ALTER TABLE "hubs"
  ADD CONSTRAINT "hubs_apiary_id_fkey"
  FOREIGN KEY ("apiary_id") REFERENCES "apiaries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── sensor_readings_raw table ────────────────────────────────────────────────
-- Richer reading table per INTELLIGENCE_SPEC §6.1. Coexists with sensor_readings
-- (we never touch that table). Future Tachyon-sourced data writes here.

CREATE TABLE IF NOT EXISTS "sensor_readings_raw" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "hub_id"         UUID,
  "device_id"      UUID,
  "hive_id"        UUID,
  "device_mac"     TEXT,
  "vendor"         TEXT NOT NULL,
  "metric"         TEXT NOT NULL,
  "value"          DOUBLE PRECISION NOT NULL,
  "unit"           TEXT NOT NULL,
  "quality"        REAL,
  "battery_v"      REAL,
  "signal_rssi"    REAL,
  "raw_payload"    JSONB,
  "recorded_at"    TIMESTAMPTZ NOT NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "sensor_readings_raw_hive_metric_recorded_idx"
  ON "sensor_readings_raw" ("hive_id", "metric", "recorded_at");
CREATE INDEX IF NOT EXISTS "sensor_readings_raw_recorded_idx"
  ON "sensor_readings_raw" ("recorded_at");
CREATE INDEX IF NOT EXISTS "sensor_readings_raw_hub_recorded_idx"
  ON "sensor_readings_raw" ("hub_id", "recorded_at");

ALTER TABLE "sensor_readings_raw"
  ADD CONSTRAINT "sensor_readings_raw_hub_id_fkey"
  FOREIGN KEY ("hub_id") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sensor_readings_raw"
  ADD CONSTRAINT "sensor_readings_raw_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "sensor_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sensor_readings_raw"
  ADD CONSTRAINT "sensor_readings_raw_hive_id_fkey"
  FOREIGN KEY ("hive_id") REFERENCES "hives"("id") ON DELETE SET NULL ON UPDATE CASCADE;
