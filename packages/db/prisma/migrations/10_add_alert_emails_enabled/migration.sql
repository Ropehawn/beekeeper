-- Migration 10: add alert_emails_enabled to users
-- Additive column with DEFAULT TRUE covers all existing rows with no data loss.

ALTER TABLE "users"
  ADD COLUMN "alert_emails_enabled" BOOLEAN NOT NULL DEFAULT TRUE;
