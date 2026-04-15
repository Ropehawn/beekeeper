-- Migration 8: Add treatment_logs table
-- Tracks hive treatments (mite treatments, other interventions).
-- endedAt is nullable — null means the treatment is still active.
-- All columns are nullable or have defaults — safe for tables with existing data.

CREATE TABLE treatment_logs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id         UUID        NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  logged_by       UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  applied_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  treatment_type  TEXT        NOT NULL,
  product_name    TEXT,
  dosage          TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX treatment_logs_hive_applied_idx ON treatment_logs (hive_id, applied_at DESC);
