-- HiveHealthAnalysis: caches LLM-generated health analyses per hive.
-- Keyed by cacheKey (hash of recent inspection/photo/varroa state) to avoid
-- redundant LLM calls; falls back to fresh computation when inputs change.

CREATE TABLE IF NOT EXISTS "hive_health_analyses" (
  "id"             UUID PRIMARY KEY,
  "hive_id"        UUID NOT NULL,
  "severity_score" INTEGER NOT NULL,
  "label"          TEXT NOT NULL,
  "summary"        TEXT NOT NULL,
  "analysis_json"  JSONB NOT NULL,
  "model_version"  TEXT NOT NULL,
  "cache_key"      TEXT NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "hive_health_analyses_hive_id_created_at_idx"
  ON "hive_health_analyses"("hive_id", "created_at");
