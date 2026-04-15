-- Migration 4: add_frame_ai_observation_v2_columns
-- Additive only. No existing columns are altered or dropped.
--
-- Changes to frame_ai_observations:
--   - Separate raw Anthropic envelope (raw_response) from parsed output (normalized_response)
--   - Add frame_visible_pct, image_quality_score, image_quality_issues for image quality tracking
--
-- New table frame_observation_sources:
--   - Provenance link from a FrameObservation to the photos / AI observations that informed it
--   - Created atomically with the FrameObservation so the link is never lost

-- ── frame_ai_observations additions ──────────────────────────────────────────

-- What fraction of the full frame side appears in this photo (0-100).
-- Distinct from coverage percentages: a photo can show 60% of a fully-drawn frame
-- while the coverage values describe what is on that visible 60%.
ALTER TABLE "frame_ai_observations" ADD COLUMN "frame_visible_pct" INTEGER;

-- Overall image quality score from Claude (0-100).
ALTER TABLE "frame_ai_observations" ADD COLUMN "image_quality_score" INTEGER;

-- Array of quality issue flags as JSONB.
-- Allowed values: blurry | too_dark | too_bright | glare | partial_frame | wrong_subject | obstructed
ALTER TABLE "frame_ai_observations" ADD COLUMN "image_quality_issues" JSONB;

-- The parsed FrameAnalysisResult object (structured AI output, server-normalised).
-- raw_response stores the actual Anthropic API message envelope (model, usage, content[]).
-- These two columns now serve distinct purposes:
--   raw_response        → what Claude returned verbatim (for auditing / debugging)
--   normalized_response → what the route stored after clamping / validation
ALTER TABLE "frame_ai_observations" ADD COLUMN "normalized_response" JSONB;

-- ── frame_observation_sources (provenance) ────────────────────────────────────
-- Links a FrameObservation to the FramePhotos and FrameAiObservations that informed it.
-- Typically one source per frame side (up to two per observation: front + back).
-- ai_observation_id is nullable: a photo link can exist without an AI analysis link
-- (e.g. user manually entered values after uploading a photo they did not analyze).

CREATE TABLE "frame_observation_sources" (
    "id"                UUID         NOT NULL,
    "observation_id"    UUID         NOT NULL,
    "photo_id"          UUID         NOT NULL,
    "ai_observation_id" UUID,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "frame_observation_sources_pkey" PRIMARY KEY ("id")
);

-- Primary lookup: which photos informed this observation?
CREATE INDEX "frame_observation_sources_observation_id_idx"
    ON "frame_observation_sources"("observation_id");

-- Reverse lookup: which observations was this photo used in?
CREATE INDEX "frame_observation_sources_photo_id_idx"
    ON "frame_observation_sources"("photo_id");

-- Foreign keys
ALTER TABLE "frame_observation_sources"
    ADD CONSTRAINT "frame_observation_sources_observation_id_fkey"
    FOREIGN KEY ("observation_id") REFERENCES "frame_observations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "frame_observation_sources"
    ADD CONSTRAINT "frame_observation_sources_photo_id_fkey"
    FOREIGN KEY ("photo_id") REFERENCES "frame_photos"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "frame_observation_sources"
    ADD CONSTRAINT "frame_observation_sources_ai_observation_id_fkey"
    FOREIGN KEY ("ai_observation_id") REFERENCES "frame_ai_observations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
