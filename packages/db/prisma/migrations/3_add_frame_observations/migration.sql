-- Migration 3: add_frame_observations
-- Adds frame_observations and frame_ai_observations tables.
-- These are the first tables that persist per-frame composition data.
-- V1 Frame snapshot columns (front_honey, etc.) exist but are never written by the frontend.
-- FrameObservation is now the canonical write path.

-- Human-approved frame observations
-- One row per inspection event for a frame. Both sides (front/back) in a single row.
-- Nullable coverage columns: NULL = side not observed, 0 = observed, nothing found.
CREATE TABLE "frame_observations" (
    "id" UUID NOT NULL,
    "frame_id" UUID NOT NULL,
    "inspection_id" UUID,
    "observed_by" UUID NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "front_honey" INTEGER,
    "front_brood" INTEGER,
    "front_open" INTEGER,
    "front_pollen" INTEGER,
    "back_honey" INTEGER,
    "back_brood" INTEGER,
    "back_open" INTEGER,
    "back_pollen" INTEGER,
    "queen_spotted" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "frame_observations_pkey" PRIMARY KEY ("id")
);

-- AI-written observations, one row per photo analyzed. Never edited by humans.
-- 'side' indicates which face of the frame was in the photo.
CREATE TABLE "frame_ai_observations" (
    "id" UUID NOT NULL,
    "frame_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,
    "model_version" TEXT NOT NULL,
    "confidence" INTEGER,
    "side" TEXT NOT NULL,
    "honey" INTEGER NOT NULL DEFAULT 0,
    "brood" INTEGER NOT NULL DEFAULT 0,
    "open_comb" INTEGER NOT NULL DEFAULT 0,
    "pollen" INTEGER NOT NULL DEFAULT 0,
    "disease_flags" JSONB,
    "raw_response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "frame_ai_observations_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "frame_observations_frame_id_observed_at_idx" ON "frame_observations"("frame_id", "observed_at");
CREATE INDEX "frame_ai_observations_frame_id_created_at_idx" ON "frame_ai_observations"("frame_id", "created_at");
CREATE INDEX "frame_ai_observations_photo_id_idx" ON "frame_ai_observations"("photo_id");

-- Foreign keys
ALTER TABLE "frame_observations" ADD CONSTRAINT "frame_observations_frame_id_fkey" FOREIGN KEY ("frame_id") REFERENCES "frames"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "frame_observations" ADD CONSTRAINT "frame_observations_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "inspections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "frame_observations" ADD CONSTRAINT "frame_observations_observed_by_fkey" FOREIGN KEY ("observed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "frame_ai_observations" ADD CONSTRAINT "frame_ai_observations_frame_id_fkey" FOREIGN KEY ("frame_id") REFERENCES "frames"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "frame_ai_observations" ADD CONSTRAINT "frame_ai_observations_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "frame_photos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
