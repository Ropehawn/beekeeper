-- Camera captures from per-hive CSI cameras (Arducam IMX519).
-- Stored in R2; this table is the index + metadata.
--
-- Each row represents a single still or burst-frame capture. ML inference
-- (bee count, varroa detection) writes back into the same row when ready,
-- so we don't need a separate predictions table for v1. The
-- "pending_inference_idx" partial index lets the inference worker cheaply
-- find unprocessed rows.

CREATE TABLE "camera_captures" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "hub_id"          UUID NOT NULL,
  "hive_id"         UUID,
  "camera_index"    INTEGER NOT NULL,
  "captured_at"     TIMESTAMPTZ NOT NULL,
  "storage_key"     TEXT NOT NULL,
  "file_size_bytes" INTEGER NOT NULL,
  "width"           INTEGER,
  "height"          INTEGER,
  "format"          TEXT NOT NULL DEFAULT 'jpeg',
  "capture_phase"   TEXT NOT NULL DEFAULT 'scheduled',
  "meta_json"       JSONB,
  "bee_count"       INTEGER,
  "varroa_count"    INTEGER,
  "inference_json"  JSONB,
  "inferred_at"     TIMESTAMPTZ,
  "inference_model" TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "camera_captures_hub_id_fkey"
    FOREIGN KEY ("hub_id") REFERENCES "hubs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "camera_captures_hive_id_fkey"
    FOREIGN KEY ("hive_id") REFERENCES "hives"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "camera_captures_hub_captured_idx"
  ON "camera_captures"("hub_id", "captured_at" DESC);

CREATE INDEX "camera_captures_hive_captured_idx"
  ON "camera_captures"("hive_id", "captured_at" DESC);

-- Partial index: only rows pending ML inference (cheap scan worker).
CREATE INDEX "camera_captures_pending_inference_idx"
  ON "camera_captures"("created_at") WHERE "inferred_at" IS NULL;
