-- Migration 16: Add location_role and location_note to sensor_devices and sensor_registry.
-- Additive only — two nullable TEXT columns per table. No existing rows modified,
-- no defaults required. Existing sensor records retain NULL for both columns.

ALTER TABLE "sensor_devices"
  ADD COLUMN IF NOT EXISTS "location_role" TEXT,
  ADD COLUMN IF NOT EXISTS "location_note" TEXT;

ALTER TABLE "sensor_registry"
  ADD COLUMN IF NOT EXISTS "location_role" TEXT,
  ADD COLUMN IF NOT EXISTS "location_note" TEXT;
