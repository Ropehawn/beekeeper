-- Migration 5: add_domain_events_and_session_linkage
-- Additive only. No existing columns are altered or dropped.
--
-- 1. domain_events  — fire-and-forget event backbone for async processing and audit.
-- 2. audit_log_v2   — immutable audit trail. Schema-only in this phase; no application
--                     writes yet. No FK on actor_id — records must survive user deletion.
-- 3. inspection_session_id — TEXT (non-FK) grouping key added to frame_photos and
--                     frame_observations. Lets pre-save inspection media be linked to the
--                     real Inspection row after saveInspection() returns.

-- ── domain_events ──────────────────────────────────────────────────────────
-- event_type examples: "frame.photo_analyzed" | "frame.observation_recorded" | "frame.inspection_linked"
-- aggregate_type:      "Frame" | "FrameObservation"
-- actor_id:            nullable; no FK — events must survive user deletion.
-- processed_at:        set by async consumers when they acknowledge the event.

CREATE TABLE "domain_events" (
    "id"             UUID         NOT NULL,
    "event_type"     TEXT         NOT NULL,
    "aggregate_id"   UUID         NOT NULL,
    "aggregate_type" TEXT         NOT NULL,
    "actor_id"       UUID,
    "payload"        JSONB,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at"   TIMESTAMP(3),

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- Consumers polling for work: only unprocessed events in insertion order.
CREATE INDEX "domain_events_unprocessed_idx"
    ON "domain_events"("created_at") WHERE "processed_at" IS NULL;

-- Event sourcing: all events for a given entity.
CREATE INDEX "domain_events_aggregate_id_idx"
    ON "domain_events"("aggregate_id");

-- Filtering by event type with time range.
CREATE INDEX "domain_events_event_type_created_at_idx"
    ON "domain_events"("event_type", "created_at");

-- Composite: all events for a given aggregate_type/aggregate_id combination over time.
-- Covers queries like "all Frame events for frame X since date Y".
CREATE INDEX "domain_events_aggregate_type_id_created_at_idx"
    ON "domain_events"("aggregate_type", "aggregate_id", "created_at");

-- ── audit_log_v2 ───────────────────────────────────────────────────────────
-- Schema-only in Phase 2A. No application writes added yet.
-- actor_id has no FK — audit records must survive user deletion.
-- resource_id is UUID typed at the application level but stored as UUID column
-- so it can reference any resource type without a polymorphic FK.

CREATE TABLE "audit_log_v2" (
    "id"            UUID         NOT NULL,
    "action"        TEXT         NOT NULL,
    "actor_id"      UUID,
    "resource_type" TEXT         NOT NULL,
    "resource_id"   UUID         NOT NULL,
    "payload"       JSONB,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_v2_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_v2_actor_id_created_at_idx"
    ON "audit_log_v2"("actor_id", "created_at");

CREATE INDEX "audit_log_v2_resource_idx"
    ON "audit_log_v2"("resource_type", "resource_id");

-- ── inspection_session_id ──────────────────────────────────────────────────
-- TEXT (not UUID, not FK). Client-generated stable key for grouping frame photos
-- and observations captured during an inspection session before the Inspection
-- row exists in the database.
--
-- Recommended client key pattern: "{userId}-{hiveId}-{YYYY-MM-DD}"
-- Uniqueness is per user per hive per calendar day — sufficient for the use case.
--
-- After saveInspection() returns the real Inspection UUID, the frontend calls
-- POST /api/v1/frame-observations/link-inspection with { inspectionId, sessionId }.
-- That endpoint runs updateMany on both tables where:
--   inspection_session_id = :sessionId AND inspection_id IS NULL
--
-- Partial indexes (WHERE inspection_id IS NULL) make that update fast by covering
-- only the rows that still need linking.

ALTER TABLE "frame_photos"       ADD COLUMN "inspection_session_id" TEXT;
ALTER TABLE "frame_observations" ADD COLUMN "inspection_session_id" TEXT;

CREATE INDEX "frame_photos_session_unlinked_idx"
    ON "frame_photos"("inspection_session_id") WHERE "inspection_id" IS NULL;

CREATE INDEX "frame_observations_session_unlinked_idx"
    ON "frame_observations"("inspection_session_id") WHERE "inspection_id" IS NULL;
