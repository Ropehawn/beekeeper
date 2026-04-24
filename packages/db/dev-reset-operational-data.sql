-- ============================================================================
--  dev-reset-operational-data.sql
--
--  🛑 DEV / STAGING ONLY — DO NOT RUN AGAINST PRODUCTION 🛑
--
--  DELETES all operational data:
--    hives, inspections, feeding_logs, health_events, harvest_logs, tasks,
--    treatment_logs, varroa_counts, frame_photos, frame_observations,
--    hive_health_analyses, camera_devices, alert_notification_log,
--    sensor_devices, sensor_readings, sensor_readings_raw, sensor_registry,
--    provisioning_events, domain_events
--
--  PRESERVES: users, auth, apiaries, hubs, financial_transactions, receipts,
--             schema, migrations, email_log
--
--  ── Why this script has a hard guard ─────────────────────────────────────
--  On 2026-04-23 this script ran against production (when still named
--  reset-operational-data.sql, without a guard), wiping sensor_devices and
--  breaking device→hive linkage on all live ingestion. The daemon kept
--  writing sensor_readings_raw but dashboards went blind. Recovery is
--  cheap (re-provision) but the accident must never repeat.
--
--  ── How to run (dev/staging) ─────────────────────────────────────────────
--    psql "$DATABASE_URL" \
--      -c "SET app.allow_operational_reset=true;" \
--      -f packages/db/dev-reset-operational-data.sql
--
--  Without the SET, the script aborts before touching any table.
-- ============================================================================

-- ── Hard guard: aborts unless the caller opted in for this session ────────
-- current_setting(..., true) returns NULL if the setting is unset, rather
-- than raising. Any value other than the literal string 'true' aborts.
DO $$
BEGIN
  IF current_setting('app.allow_operational_reset', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      USING MESSAGE = 'Refusing to reset operational data. Set app.allow_operational_reset=true explicitly if you truly want this.',
            HINT    = 'See the comment block at the top of this file.';
  END IF;
END $$;

BEGIN;

-- ── Step 1: Frame observation provenance ──────────────────────────────────────
-- Must precede frame_photos and frame_ai_observations (no cascade from those).
DELETE FROM frame_observation_sources;
DELETE FROM frame_ai_observations;
DELETE FROM frame_observations;
DELETE FROM frame_photos;

-- ── Step 2: Hive-level analytics and device linkage ───────────────────────────
-- hive_health_analyses and camera_devices have no cascade from hives.
-- alert_notification_log does cascade from hives but we clear it first
-- to avoid depending on cascade order.
DELETE FROM hive_health_analyses;
DELETE FROM alert_notification_log;
DELETE FROM camera_devices;

-- ── Step 3: Sensor data ───────────────────────────────────────────────────────
-- sensor_readings has FK to sensor_devices (no cascade) — must precede devices.
-- sensor_readings_raw FK to hives/hubs/devices is SetNull — safe to delete directly.
-- provisioning_events cascades from sensor_registry — clear explicitly for certainty.
DELETE FROM sensor_readings;
DELETE FROM sensor_readings_raw;
DELETE FROM provisioning_events;
DELETE FROM sensor_registry;
DELETE FROM sensor_devices;

-- ── Step 4: Hive operational logs ─────────────────────────────────────────────
-- These FK to hives with no cascade — must precede the hives delete.
DELETE FROM tasks;
DELETE FROM treatment_logs;
DELETE FROM varroa_counts;
DELETE FROM feeding_logs;
DELETE FROM health_events;
DELETE FROM harvest_logs;
DELETE FROM inspections;

-- ── Step 5: Hives ─────────────────────────────────────────────────────────────
-- Cascade handles: hive_components → frames, varroa_counts, treatment_logs,
-- alert_notification_log. We already cleared those above; cascade is a backstop.
DELETE FROM hives;

-- ── Step 6: Event bus ─────────────────────────────────────────────────────────
-- domain_events references frame/inspection aggregate IDs now gone.
-- No FK constraints so this is safe at any point.
DELETE FROM domain_events;

COMMIT;

-- ── Verification ──────────────────────────────────────────────────────────────
-- Run these after the transaction commits to confirm the reset succeeded.

SELECT 'hives'            AS "table", COUNT(*) AS remaining FROM hives
UNION ALL
SELECT 'inspections',       COUNT(*) FROM inspections
UNION ALL
SELECT 'feeding_logs',      COUNT(*) FROM feeding_logs
UNION ALL
SELECT 'health_events',     COUNT(*) FROM health_events
UNION ALL
SELECT 'harvest_logs',      COUNT(*) FROM harvest_logs
UNION ALL
SELECT 'tasks',             COUNT(*) FROM tasks
UNION ALL
SELECT 'sensor_devices',    COUNT(*) FROM sensor_devices
UNION ALL
SELECT 'sensor_registry',   COUNT(*) FROM sensor_registry
UNION ALL
SELECT 'sensor_readings',   COUNT(*) FROM sensor_readings
UNION ALL
SELECT 'sensor_readings_raw', COUNT(*) FROM sensor_readings_raw
UNION ALL
SELECT 'hive_health_analyses', COUNT(*) FROM hive_health_analyses
UNION ALL
SELECT 'camera_devices',    COUNT(*) FROM camera_devices
UNION ALL
SELECT 'domain_events',     COUNT(*) FROM domain_events
UNION ALL
SELECT 'users_preserved',   COUNT(*) FROM users
UNION ALL
SELECT 'apiaries_preserved', COUNT(*) FROM apiaries
UNION ALL
SELECT 'hubs_preserved',    COUNT(*) FROM hubs
ORDER BY "table";
