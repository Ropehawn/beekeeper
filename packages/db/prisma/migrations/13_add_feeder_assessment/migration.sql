-- Feeder assessment: track per-inspection feeder remaining + last refilled date.
-- All fields nullable; null = "not recorded" (not equivalent to "empty").
-- Additive only; no backfill.

ALTER TABLE "inspections" ADD COLUMN IF NOT EXISTS "feeder_remaining" TEXT;
ALTER TABLE "inspections" ADD COLUMN IF NOT EXISTS "feeder_type" TEXT;
ALTER TABLE "inspections" ADD COLUMN IF NOT EXISTS "last_fed_date" TIMESTAMP(3);
