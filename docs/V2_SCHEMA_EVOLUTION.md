# BeeKeeper V2 Schema Evolution Plan

**Date:** 2026-03-31
**Author:** Claude (reviewed by Michael Thom)
**Status:** Proposal — awaiting approval before any migration

---

## 1. V1 vs V2 Comparison

### Models that stay UNCHANGED

These V1 models are well-designed and need zero modifications:

| Model | Reason |
|-------|--------|
| `User` | Solid auth model. V2 adds relations only (no column changes). |
| `Account` | NextAuth OAuth — untouched. |
| `Session` | NextAuth sessions — untouched. |
| `VerificationToken` | NextAuth — untouched. |
| `Apiary` | Simple location record — good as-is. |
| `Hive` | Core identity — good as-is. V2 adds new relations only. |
| `HiveComponent` | Physical stack identity — good as-is. |
| `Inspection` | Human observation record — stays canonical. V2 adds relation to frame_observations. |
| `FeedingLog` | Append-only log — good as-is. |
| `HealthEvent` | Append-only log — good as-is. |
| `HarvestLog` | Append-only log — good as-is. |
| `Task` | Task management — good as-is. |
| `EmailLog` | Append-only log — good as-is. |
| `CameraDevice` | Phase 4 placeholder — untouched. |

### Models that are EXTENDED (new relations only, no column changes)

| Model | What changes |
|-------|-------------|
| `Frame` | Gets new relations: `observations`, `aiObservations`. Existing V1 columns (`frontHoney`, etc.) stay for backward compat. |
| `FramePhoto` | Gets new relation: `aiObservations`. Existing `aiAnalysisJson` stays (legacy). |
| `SensorDevice` | Gets new relation: `rawReadings` (replaces `readings` gradually). |

### Models that are DEPRECATED (not deleted, just superseded)

| Model | Superseded by | Deprecation plan |
|-------|--------------|-----------------|
| `SensorReading` | `SensorReadingRaw` + `SensorAnomaly` | Stop writing new rows. Keep table for historical queries. Remove from schema after 6 months. |
| `Receipt` | `ReceiptUpload` + `ReceiptAiExtraction` + `ReceiptReviewQueue` | Stop writing. Existing rows stay. Receipt route points to new flow. |
| `FinancialTransaction` | Stays canonical — but only written via approved review queue, never directly by AI. |
| `FinancialLineItem` | Stays canonical — same protection as above. |

### NEW V2 Models

| Model | Purpose | Category |
|-------|---------|----------|
| `DomainEvent` | Append-only event backbone | Infrastructure |
| `AuditLog` | Who did what, when, to which record | Infrastructure |
| `FrameObservation` | Human observations of a frame at a point in time | Observation |
| `FrameAiObservation` | AI analysis of a frame photo | Observation |
| `ReceiptUpload` | Raw file upload (no AI, no transaction) | Receipt pipeline |
| `ReceiptAiExtraction` | AI extraction result from a receipt | Receipt pipeline |
| `ReceiptReviewQueue` | Human review gate before canonical write | Receipt pipeline |
| `SensorReadingRaw` | Raw sensor data ingestion | Sensor pipeline |
| `SensorAnomaly` | Detected anomalies from sensor data | Sensor pipeline |
| `HiveAlert` | Actionable alerts (email-worthy) | Alerting |
| `InspectionRecommendation` | AI/rule-generated inspection suggestions | Recommendations |

> **Deferred:** `Permission` (fine-grained per-user, per-resource overrides) is not included in the V2 initial rollout. Current queen/worker/spectator roles are sufficient. Revisit when delegated receipt review approval or multi-apiary scoped access becomes a real need.

---

## 2. Detailed Model Design

### 2a. Event Backbone

**`DomainEvent`** — append-only log of everything that happened in the system.

```
domain_events
  id              UUID PK
  aggregate_type  TEXT NOT NULL    -- hive | inspection | receipt | sensor | user | task
  aggregate_id    UUID NOT NULL    -- the entity this event is about
  event_type      TEXT NOT NULL    -- hive.created | inspection.completed | receipt.uploaded | receipt.ai_extracted | receipt.approved | alert.triggered
  actor_id        UUID FK → users  -- who/what caused this (nullable for system events)
  actor_type      TEXT NOT NULL    -- user | system | ai | sensor
  payload         JSONB           -- event-specific data snapshot
  metadata        JSONB           -- request context (IP, user-agent, etc.)
  created_at      TIMESTAMPTZ     -- when it happened (immutable)
  processed_at    TIMESTAMPTZ     -- when background handlers finished (nullable)
```

Design notes:
- **Never updated, never deleted.** This is the audit trail.
- `aggregate_type + aggregate_id` lets you reconstruct entity history.
- `actor_type` distinguishes human vs AI vs system vs sensor actions.
- `processed_at` lets workers mark events as handled without deleting them.
- Index on `(aggregate_type, aggregate_id, created_at)` for entity history queries.
- Index on `(event_type, created_at)` for event stream processing.

### 2b. Audit Log

**`AuditLog`** — structured record of mutations to canonical tables.

```
audit_log
  id              UUID PK
  table_name      TEXT NOT NULL    -- which table was modified
  record_id       UUID NOT NULL    -- PK of the modified record
  action          TEXT NOT NULL    -- create | update | delete | approve | reject
  actor_id        UUID FK → users
  old_values      JSONB           -- previous state (null for create)
  new_values      JSONB           -- new state (null for delete)
  created_at      TIMESTAMPTZ
```

Design notes:
- Separate from DomainEvent because this is specifically about data mutations, not business events.
- `old_values` / `new_values` enable full undo capability.
- `action: approve | reject` tracks review queue decisions.

### 2c. Frame Observation Separation

**Current V1 problem:** Frame coverage data (`frontHoney`, `backBrood`, etc.) is stored directly on the `Frame` record. Each update overwrites the previous state. No history, no attribution, no AI vs human distinction.

**V2 solution:** Keep `Frame` as physical identity. Add `FrameObservation` for human observations and `FrameAiObservation` for AI analysis. The `Frame` record's existing columns become "current snapshot" (derived from latest observation).

**`FrameObservation`** — what a human saw on a frame during an inspection.

```
frame_observations
  id              UUID PK
  frame_id        UUID FK → frames
  inspection_id   UUID FK → inspections (nullable — standalone observations allowed)
  observed_by     UUID FK → users
  observed_at     TIMESTAMPTZ NOT NULL
  side            TEXT NOT NULL         -- front | back
  honey           INT DEFAULT 0        -- 0-100%
  brood           INT DEFAULT 0
  open_comb       INT DEFAULT 0
  pollen          INT DEFAULT 0
  queen_spotted   BOOLEAN DEFAULT false
  notes           TEXT
  created_at      TIMESTAMPTZ
```

**`FrameAiObservation`** — what Claude Vision detected in a frame photo.

```
frame_ai_observations
  id              UUID PK
  frame_id        UUID FK → frames
  photo_id        UUID FK → frame_photos
  model_version   TEXT NOT NULL         -- claude-sonnet-4-20250514
  confidence      INT                   -- 0-100 overall
  side            TEXT NOT NULL         -- front | back
  honey           INT DEFAULT 0
  brood           INT DEFAULT 0
  open_comb       INT DEFAULT 0
  pollen          INT DEFAULT 0
  disease_flags   JSONB                 -- [{type: "varroa", confidence: 82, region: "top-left"}]
  raw_response    JSONB                 -- full AI response for debugging
  created_at      TIMESTAMPTZ
```

Design notes:
- `FramePhoto.aiAnalysisJson` (V1) stays for backward compat but new code writes to `FrameAiObservation`.
- Neither observation type overwrites `Frame` directly. A service derives current frame state from latest observations.
- `Frame.frontHoney` etc. can be updated by a "materialize" step OR left as legacy and the UI reads from observations.

### 2d. Receipt Pipeline (Raw → AI → Review → Canonical)

**Current V1 problem:** `Receipt` model mixes upload metadata, AI analysis, and transaction linkage in one record. AI writes `aiAnalysisJson` directly. No review gate.

**V2 solution:** Split into 4 stages.

**Stage 1: `ReceiptUpload`** — raw file, no AI, no transaction.

```
receipt_uploads
  id              UUID PK
  storage_key     TEXT NOT NULL       -- R2 path
  file_size_bytes INT
  mime_type       TEXT
  original_name   TEXT                -- user's filename
  uploaded_by     UUID FK → users
  uploaded_at     TIMESTAMPTZ
  status          TEXT DEFAULT 'pending'  -- pending | processing | extracted | failed
  created_at      TIMESTAMPTZ
```

**Stage 2: `ReceiptAiExtraction`** — AI's interpretation (never touches canonical tables).

```
receipt_ai_extractions
  id              UUID PK
  upload_id       UUID FK → receipt_uploads
  model_version   TEXT NOT NULL
  confidence      INT                 -- 0-100
  extracted_data  JSONB NOT NULL      -- {vendor, date, total, tax, line_items[], ...}
  raw_response    JSONB               -- full AI response for debugging
  extraction_ms   INT                 -- how long the AI call took
  created_at      TIMESTAMPTZ
```

**Stage 3: `ReceiptReviewQueue`** — human approval gate.

```
receipt_review_queue
  id              UUID PK
  upload_id       UUID FK → receipt_uploads
  extraction_id   UUID FK → receipt_ai_extractions
  status          TEXT DEFAULT 'pending'  -- pending | approved | rejected | edited
  reviewed_by     UUID FK → users (nullable)
  reviewed_at     TIMESTAMPTZ (nullable)
  edited_data     JSONB               -- human corrections (null if approved as-is)
  reject_reason   TEXT
  transaction_id  UUID FK → financial_transactions (nullable — set on approve)
  created_at      TIMESTAMPTZ
```

**Stage 4:** On approve → write to existing `FinancialTransaction` + `FinancialLineItem`. These canonical tables are never written by AI directly.

Design notes:
- Multiple AI extractions per upload are allowed (re-scan with different model).
- `edited_data` captures what the human changed, preserving the AI's original extraction.
- `transaction_id` links back to canonical table only after approval.
- Old `Receipt` table stays in schema with `@deprecated` comment. No data deleted.

### 2e. Sensor Pipeline (Raw → Anomaly → Alert → Recommendation)

**Current V1 problem:** `SensorReading` is a flat time-series table with no anomaly detection, alerting, or recommendation layer.

**V2 solution:** Keep raw readings separate from derived intelligence.

**`SensorReadingRaw`** — high-frequency raw ingestion (replaces V1 `SensorReading`).

```
sensor_readings_raw
  id              UUID PK
  device_id       UUID FK → sensor_devices
  temp_f          FLOAT
  humidity        FLOAT
  lux             FLOAT
  weight          FLOAT
  battery_pct     INT                 -- NEW: battery monitoring
  signal_rssi     INT                 -- NEW: signal strength
  raw_payload     JSONB               -- vendor-specific raw data
  recorded_at     TIMESTAMPTZ NOT NULL
  ingested_at     TIMESTAMPTZ DEFAULT now()

  @@index([device_id, recorded_at])
```

**`SensorAnomaly`** — detected deviations from normal patterns.

```
sensor_anomalies
  id              UUID PK
  device_id       UUID FK → sensor_devices
  hive_id         UUID FK → hives (nullable — device may not be assigned)
  anomaly_type    TEXT NOT NULL       -- temp_spike | temp_drop | humidity_high | weight_drop | battery_low | signal_lost
  severity        TEXT NOT NULL       -- info | warning | critical
  metric          TEXT NOT NULL       -- temp_f | humidity | weight | battery_pct
  expected_value  FLOAT
  actual_value    FLOAT
  deviation_pct   FLOAT               -- how far from normal
  window_start    TIMESTAMPTZ         -- analysis window
  window_end      TIMESTAMPTZ
  reading_id      UUID FK → sensor_readings_raw (the triggering reading)
  resolved_at     TIMESTAMPTZ
  created_at      TIMESTAMPTZ
```

**`HiveAlert`** — actionable notifications generated from anomalies or rules.

```
hive_alerts
  id              UUID PK
  hive_id         UUID FK → hives
  alert_type      TEXT NOT NULL       -- low_feeder | temp_critical | inspection_overdue | swarm_risk | disease_detected | weight_anomaly
  source_type     TEXT NOT NULL       -- sensor | inspection | ai | schedule | rule
  source_id       UUID                -- FK to anomaly, inspection, observation, etc.
  severity        TEXT NOT NULL       -- info | warning | critical
  title           TEXT NOT NULL
  message         TEXT
  status          TEXT DEFAULT 'active'  -- active | acknowledged | resolved | dismissed
  acknowledged_by UUID FK → users (nullable)
  acknowledged_at TIMESTAMPTZ
  resolved_at     TIMESTAMPTZ
  email_sent      BOOLEAN DEFAULT false
  email_log_id    UUID FK → email_log (nullable)
  created_at      TIMESTAMPTZ
```

**`InspectionRecommendation`** — AI/rule-generated suggestions.

```
inspection_recommendations
  id              UUID PK
  hive_id         UUID FK → hives
  source_type     TEXT NOT NULL       -- ai | rule | sensor_pattern
  source_id       UUID                -- what generated this
  recommendation  TEXT NOT NULL       -- human-readable suggestion
  reasoning       TEXT                -- why this was recommended
  priority        TEXT DEFAULT 'medium'  -- low | medium | high | urgent
  status          TEXT DEFAULT 'pending' -- pending | accepted | dismissed | completed
  acted_on_by     UUID FK → users (nullable)
  acted_on_at     TIMESTAMPTZ
  expires_at      TIMESTAMPTZ         -- recommendations go stale
  created_at      TIMESTAMPTZ
```

### 2f. Finer-Grained Permissions

**Current V1:** Three roles (queen/worker/spectator) hardcoded in middleware.

**V2:** Keep role-based access as the default. Add `Permission` table for overrides.

**`Permission`** — per-user, per-resource permission overrides.

```
permissions
  id              UUID PK
  user_id         UUID FK → users
  resource_type   TEXT NOT NULL       -- hive | apiary | financials | sensors | cameras | users
  resource_id     UUID                -- specific entity (nullable = all of that type)
  action          TEXT NOT NULL       -- read | write | admin | approve
  granted         BOOLEAN DEFAULT true -- true = allow, false = deny
  granted_by      UUID FK → users
  expires_at      TIMESTAMPTZ         -- temporary access
  created_at      TIMESTAMPTZ

  @@unique([user_id, resource_type, resource_id, action])
```

Design notes:
- **Does NOT replace roles.** Roles remain the primary access control.
- Permissions are checked AFTER roles: role grants baseline, permissions add exceptions.
- Example: a worker gets `approve` on `receipts` → they can review AI extractions.
- Example: a spectator gets `read` on `hive` with specific `resource_id` → limited hive access.
- `granted: false` allows explicit deny (deny wins over allow).
- `expires_at` enables temporary access grants.

---

## 3. Migration Safety Plan

### Principles
1. **All migrations are additive.** No DROP, no DELETE, no ALTER TYPE destructive.
2. **New tables only in migration 3.** No existing table modifications.
3. **New relations added to existing models** via nullable FK columns in a separate migration 4.
4. **Old models are never removed.** They get `@deprecated` comments.
5. **Each migration is tested locally** before `prisma migrate deploy`.

### Migration Sequence

| Migration | Name | Contents | Risk |
|-----------|------|----------|------|
| **3** | `add_v2_event_backbone` | `domain_events`, `audit_log_v2` tables | **Zero** — new tables only |
| **4** | `add_v2_frame_observations` | `frame_observations`, `frame_ai_observations` tables | **Zero** — new tables only |
| **5** | `add_v2_receipt_pipeline` | `receipt_uploads`, `receipt_ai_extractions`, `receipt_review_queue` tables | **Zero** — new tables only |
| **6** | `add_v2_sensor_pipeline` | `sensor_readings_raw`, `sensor_anomalies`, `hive_alerts`, `inspection_recommendations` tables | **Zero** — new tables only |

> **Removed:** `add_v2_relations` — produced zero SQL. All FK columns and constraints live on the new V2 tables created in migrations 3-6. The reverse-side Prisma relation fields on existing models (User, Hive, Frame, etc.) are schema-only and are included in whichever migration creates the referencing table.
>
> **Deferred:** `add_v2_permissions` — deferred until delegated receipt approval or multi-apiary scoped access becomes a real need.

### Rollback Plan

Every migration is a new table with no dependencies on existing data. Rollback = `DROP TABLE IF EXISTS <new_table>` (manual, not via Prisma). No existing behavior is affected until application code is updated to use the new tables.

### Data Migration (Optional, Post-Deploy)

After V2 schema is stable and code is using it:
1. Backfill `frame_observations` from existing `Frame.frontHoney/backHoney/...` + `Inspection` data.
2. Backfill `receipt_uploads` from existing `Receipt` records.
3. Backfill `sensor_readings_raw` from existing `SensorReading` records.
4. These are **read-only copies**, not moves. Original data stays in V1 tables.

---

## 4. Summary Table

| V1 Model | V2 Status | Action |
|----------|-----------|--------|
| User | **Keep** | Add relations to new models |
| Account | **Keep** | No change |
| Session | **Keep** | No change |
| VerificationToken | **Keep** | No change |
| Apiary | **Keep** | No change |
| Hive | **Keep** | Add relations to alerts, recommendations |
| HiveComponent | **Keep** | No change |
| Frame | **Keep** | Add relations to observations |
| Inspection | **Keep** | Add relation to frame_observations |
| FeedingLog | **Keep** | No change |
| HealthEvent | **Keep** | No change |
| HarvestLog | **Keep** | No change |
| FramePhoto | **Keep** | Add relation to ai_observations |
| FinancialTransaction | **Keep** | Protected — only written via approved review queue |
| FinancialLineItem | **Keep** | Protected — same as above |
| Receipt | **Deprecate** | Keep in schema, stop using. Superseded by receipt pipeline |
| Task | **Keep** | No change |
| EmailLog | **Keep** | No change |
| SensorDevice | **Keep** | Add relation to raw readings |
| SensorReading | **Deprecate** | Keep in schema, stop using. Superseded by sensor pipeline |
| CameraDevice | **Keep** | No change |
| — | **NEW** | DomainEvent, AuditLog, FrameObservation, FrameAiObservation |
| — | **NEW** | ReceiptUpload, ReceiptAiExtraction, ReceiptReviewQueue |
| — | **NEW** | SensorReadingRaw, SensorAnomaly, HiveAlert, InspectionRecommendation |
| Permission | **Deferred** | Not in V2 initial rollout. Revisit for delegated receipt approval or multi-apiary access. |
