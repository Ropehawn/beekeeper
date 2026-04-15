-- Migration 9: Add alert_notification_log table
-- Records every alert notification email sent, per user + hive + rule.
-- Used to enforce per-rule cooldowns so users are not spammed when a
-- condition persists across multiple daily cron runs.
-- All columns nullable where appropriate — safe additive migration.

CREATE TABLE alert_notification_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id           UUID        NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  rule              TEXT        NOT NULL,   -- varroa_no_treatment | queen_absent | treatment_too_long | inspection_overdue | disease_flags
  severity          TEXT        NOT NULL,   -- critical | warning
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  recipient_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  email_log_id      UUID        REFERENCES email_log(id) ON DELETE SET NULL
);

-- Composite index supports the cooldown dedup query:
-- WHERE hive_id = ? AND rule = ? AND recipient_user_id = ? ORDER BY sent_at DESC LIMIT 1
CREATE INDEX alert_notif_dedup_idx
  ON alert_notification_log (hive_id, rule, recipient_user_id, sent_at DESC);
