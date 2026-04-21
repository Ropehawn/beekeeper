-- Migration 17: add deployment_profile to sensor_devices and sensor_registry
-- Additive only — nullable column, no default required, no existing rows affected.

ALTER TABLE "sensor_devices"  ADD COLUMN IF NOT EXISTS "deployment_profile" TEXT;
ALTER TABLE "sensor_registry" ADD COLUMN IF NOT EXISTS "deployment_profile" TEXT;
