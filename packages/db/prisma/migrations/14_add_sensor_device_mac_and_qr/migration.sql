-- Migration 14: Add current_mac and provisioned_at to sensor_devices for Tachyon BLE sensors.
-- Additive only — no existing columns modified, no data mutated.
--
-- current_mac: the BLE MAC address currently bound to this sensor device.
--   Mutable — changes on battery swap (relink). Indexed for fast daemon lookups.
-- provisioned_at: when this sensor was physically provisioned (QR code assigned).
-- The existing device_id column holds the permanent QR sensor code (e.g., "T7K2M").

ALTER TABLE "sensor_devices"
  ADD COLUMN IF NOT EXISTS "current_mac" TEXT,
  ADD COLUMN IF NOT EXISTS "provisioned_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "sensor_devices_current_mac_idx"
  ON "sensor_devices" ("current_mac") WHERE "current_mac" IS NOT NULL;

-- Make device_id unique — it holds the permanent QR sensor code
CREATE UNIQUE INDEX IF NOT EXISTS "sensor_devices_device_id_key"
  ON "sensor_devices" ("device_id");

-- Index for querying readings by device
CREATE INDEX IF NOT EXISTS "sensor_readings_raw_device_recorded_idx"
  ON "sensor_readings_raw" ("device_id", "metric", "recorded_at");
