-- Migration 7: Add varroa_counts table
-- Records per-hive varroa mite counts from alcohol wash, sugar roll, or sticky board.
-- All columns are additive; no existing tables are altered.
--
-- mite_count   — raw mites found in the sample or on the board
-- bee_sample   — number of bees in the sample (alcohol wash / sugar roll)
-- days_on_board — number of days the sticky board was in place
-- Derived values (mites_per_100_bees, mites_per_day, status) are computed at
-- read time by the API — not stored — to keep the schema free of derived data.

CREATE TABLE "varroa_counts" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "hive_id"        UUID         NOT NULL,
  "counted_by"     UUID         NOT NULL,
  "counted_at"     TIMESTAMP(3) NOT NULL,
  "method"         TEXT         NOT NULL,
  "mite_count"     INTEGER      NOT NULL,
  "bee_sample"     INTEGER,
  "days_on_board"  INTEGER,
  "notes"          TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "varroa_counts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "varroa_counts"
  ADD CONSTRAINT "varroa_counts_hive_id_fkey"
  FOREIGN KEY ("hive_id") REFERENCES "hives"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "varroa_counts"
  ADD CONSTRAINT "varroa_counts_counted_by_fkey"
  FOREIGN KEY ("counted_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Index for efficient per-hive queries ordered by date
CREATE INDEX "varroa_counts_hive_id_counted_at_idx"
  ON "varroa_counts"("hive_id", "counted_at" DESC);
