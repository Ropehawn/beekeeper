-- Migration 15: Add sensor_registry and provisioning_events tables.
-- Additive only — no existing columns modified, no data mutated.
--
-- sensor_registry
--   Stable administrative identity record for each physical sensor device.
--   One row per device. Survives firmware reflashes, MAC address changes,
--   and re-provisioning cycles. Referenced by processSensorObservation()
--   (packages/domain/hardware/pipeline.ts) as the reconciliation snapshot.
--   Distinct from sensor_devices (UniFi/SensorPush polling path).
--
-- provisioning_events
--   Append-only audit trail for sensor lifecycle transitions.
--   Written by the pipeline adapter (sensor-registry-db.ts) when observations
--   are confirmed (identity_confirmed), MAC-relinked (mac_updated), or queued
--   for review (unresolved outcomes write to domain_events instead).
--   Never updated after creation — immutable audit log.

-- ─── sensor_registry ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "sensor_registry" (
  "id"                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- BeeKeeper stable asset identity e.g. "BK-SEN-000241". Printed on QR label.
  -- Globally unique. Survives firmware reflash, MAC changes, re-provisioning.
  "asset_id"             TEXT        NOT NULL,
  -- Vendor/native device identifier — BLE name, serial, QR code, etc.
  "device_identifier"    TEXT        NOT NULL,
  "vendor"               TEXT        NOT NULL,   -- tachyon | sensorpush | ecowitt | generic …
  "model"                TEXT        NOT NULL,   -- sc833f | s05t | hx711 | bme280 | generic …
  "transport"            TEXT        NOT NULL,   -- ble | gpio | csi | cloud | manual
  -- Always 'sensor' for rows in this table. Stored for domain type alignment.
  "kind"                 TEXT        NOT NULL DEFAULT 'sensor',
  "name"                 TEXT        NOT NULL,
  -- Lifecycle stage: discovered | pending | provisioned | assigned |
  --                  unassigned | retired | unknown
  "lifecycle_status"     TEXT        NOT NULL DEFAULT 'discovered',
  -- Current BLE/transport MAC address. Nullable — changes on firmware reflash.
  -- The UNIQUE constraint allows multiple NULLs (Postgres treats each NULL as
  -- distinct), achieving partial-index semantics without raw DDL.
  -- Application layer adds an in-transaction pre-flight check on relink_mac.
  "current_mac_address"  TEXT,
  "hub_id"               UUID,
  "hive_id"              UUID,
  -- Device role: primary_environment | thermal_map | weight | audio |
  --              entrance_camera | apiary_camera | ambient_weather | unknown
  "role"                 TEXT        NOT NULL DEFAULT 'unknown',
  "polling_interval_sec" INTEGER,
  "firmware_version"     TEXT,
  "notes"                TEXT,
  "label_printed"        BOOLEAN     NOT NULL DEFAULT FALSE,
  "provisioned_at"       TIMESTAMPTZ,
  "assigned_at"          TIMESTAMPTZ,
  "retired_at"           TIMESTAMPTZ,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- asset_id: stable QR-label identity — globally unique
CREATE UNIQUE INDEX IF NOT EXISTS "sensor_registry_asset_id_key"
  ON "sensor_registry" ("asset_id");

-- current_mac_address: nullable unique.
-- Multiple NULLs permitted; non-null values must be unique across the table.
CREATE UNIQUE INDEX IF NOT EXISTS "sensor_registry_current_mac_address_key"
  ON "sensor_registry" ("current_mac_address");

-- loadRegistryRecordsForHub filters on lifecycle_status != 'retired'
CREATE INDEX IF NOT EXISTS "sensor_registry_lifecycle_status_idx"
  ON "sensor_registry" ("lifecycle_status");

-- loadRegistryRecordsForHub scopes by hub_id
CREATE INDEX IF NOT EXISTS "sensor_registry_hub_id_idx"
  ON "sensor_registry" ("hub_id");

CREATE INDEX IF NOT EXISTS "sensor_registry_hive_id_idx"
  ON "sensor_registry" ("hive_id");

-- FK: hub_id → hubs.id  — SET NULL so registry records survive hub deletion
ALTER TABLE "sensor_registry"
  ADD CONSTRAINT "sensor_registry_hub_id_fkey"
  FOREIGN KEY ("hub_id") REFERENCES "hubs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- FK: hive_id → hives.id — SET NULL so registry records survive hive deletion
ALTER TABLE "sensor_registry"
  ADD CONSTRAINT "sensor_registry_hive_id_fkey"
  FOREIGN KEY ("hive_id") REFERENCES "hives"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── provisioning_events ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "provisioning_events" (
  "id"          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "registry_id" UUID        NOT NULL,
  -- Event kind: discovered | claimed | provisioned | assigned | reassigned |
  --             unassigned | mac_updated | firmware_updated | retired |
  --             reactivated | identity_confirmed
  "event_type"  TEXT        NOT NULL,
  -- Actor who triggered the transition. NULL for automated reconciliation.
  -- No FK to users — intentional: events must outlive user records.
  "actor_id"    UUID,
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "payload"     JSONB
);

-- FK: registry_id → sensor_registry.id — CASCADE so events are deleted with the record
ALTER TABLE "provisioning_events"
  ADD CONSTRAINT "provisioning_events_registry_id_fkey"
  FOREIGN KEY ("registry_id") REFERENCES "sensor_registry"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Primary audit query pattern: all events for a given sensor, ordered by time
CREATE INDEX IF NOT EXISTS "provisioning_events_registry_id_occurred_at_idx"
  ON "provisioning_events" ("registry_id", "occurred_at");

-- Secondary query pattern: all events of a given type, ordered by time
CREATE INDEX IF NOT EXISTS "provisioning_events_event_type_occurred_at_idx"
  ON "provisioning_events" ("event_type", "occurred_at");
