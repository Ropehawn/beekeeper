-- Migration 6: Add R2 upload support columns to frame_photos
-- Adds mime_type and upload_confirmed_at to track the R2 presigned-URL upload lifecycle.
--
-- upload_confirmed_at = NULL  → photo record created by upload-url, upload not yet confirmed
-- upload_confirmed_at = <ts>  → confirm-upload has verified the file exists in R2
--
-- These columns are additive and nullable — all existing rows (base64 path) are unaffected.
-- The base64 analyze route never sets upload_confirmed_at; analyze-by-photoId requires it.

ALTER TABLE "frame_photos" ADD COLUMN "mime_type" TEXT;
ALTER TABLE "frame_photos" ADD COLUMN "upload_confirmed_at" TIMESTAMP(3);

-- Index to efficiently find unconfirmed uploads (e.g. for cleanup jobs)
CREATE INDEX "frame_photos_upload_confirmed_at_null_idx"
  ON "frame_photos"("created_at")
  WHERE "upload_confirmed_at" IS NULL;
