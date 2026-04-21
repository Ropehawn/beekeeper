// apps/api/src/routes/sensor-identity-queue.ts
//
// Operator-facing review queue for unresolved Tachyon sensor identity outcomes.
//
// Background: when processSensorObservation() returns an action that cannot be
// safely auto-resolved (register_new, needs_manual_review, hold_for_mac_conflict),
// queueForReview() in sensor-registry-db.ts writes a domain_events row with:
//   eventType   = 'sensor.identity.review_queued'
//   processedAt = null            (null = pending human review)
//   aggregateId = hubId
//   payload     = { action, summary, observation, reconciliation, candidates, hubId }
//
// This file exposes three endpoints so operators can review, dismiss, and resolve items.
//
// Endpoints:
//   GET  /api/v1/sensor-identity/review-queue                 list pending items
//   POST /api/v1/sensor-identity/review-queue/:id/dismiss     dismiss one item
//   POST /api/v1/sensor-identity/review-queue/:id/resolve     resolve one item
//
// Resolution types implemented:
//   "provision"        — register_new items only (Step 3)
//   "select_candidate" — needs_manual_review items (Step 4)
//   "force_relink"     — hold_for_mac_conflict items (Step 5)
//
// Auth: requireAuth + requireRole("queen", "worker") on all endpoints.

import { Router } from "express";
import { z } from "zod";
import { db, Prisma } from "@beekeeper/db";
import { logger } from "../lib/logger";
import { requireAuth, requireRole, AuthRequest } from "../middleware/auth";
import {
  persistProvisionNew,
  persistSelectCandidate,
  persistForceRelink,
  AssetIdConflictError,
  MacCollisionError,
  RetiredRecordError,
  ConflictDriftedError,
} from "../lib/sensor-registry-db";
import { isValidAssetId } from "../../../../packages/domain/hardware/actions";

const router = Router();

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

// Shape of the JSONB payload written by queueForReview(). We own the writer
// so the shape is guaranteed — type-assert rather than runtime-validate.
interface QueueItemPayload {
  action:  "register_new" | "needs_manual_review" | "hold_for_mac_conflict";
  summary: string;
  observation: {
    assetId:            string | null;
    deviceIdentifier:   string | null;
    observedMacAddress: string | null;
    observedAt:         string;
  };
  reconciliation: {
    matchType:         string;
    reason:            string;
    crossTierConflict: boolean;
    relinkRequired:    boolean;
    observedMac:       string | null;
    previousMac:       string | null;
    matchedRecordId:   string | null;
  };
  candidates: Array<{
    id:               string;
    assetId:          string;
    deviceIdentifier: string;
    currentMac:       string | null;
    lifecycleStatus:  string;
    name:             string;
  }>;
  hubId: string;
}

// Clean response shape returned to clients.
// Typed projection of the domain_events row + payload — no raw DB fields exposed.
interface ReviewQueueItem {
  id:             string;           // domain_events.id — used in resolve/dismiss URLs
  createdAt:      string;           // ISO 8601 — when the observation arrived
  hubId:          string;           // which hub reported this
  action:         QueueItemPayload["action"];
  summary:        string;
  observation:    QueueItemPayload["observation"];
  reconciliation: QueueItemPayload["reconciliation"];
  candidates:     QueueItemPayload["candidates"];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Safe cast from Prisma.JsonValue → QueueItemPayload.
 *
 * Returns null if the value is null, a primitive, or an array — all of which
 * indicate a corrupted or unexpected payload. The list endpoint skips these
 * rows with a warning rather than 500ing the whole response.
 */
function toQueuePayload(raw: Prisma.JsonValue | null): QueueItemPayload | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as unknown as QueueItemPayload;
}

/**
 * Project a domain_events row + parsed payload into the clean response shape.
 * Uses row.aggregateId for hubId — that column is the canonical store;
 * payload.hubId is a convenience copy for the human-readable audit trail.
 */
function toReviewQueueItem(
  row: { id: string; createdAt: Date; aggregateId: string; payload: Prisma.JsonValue | null },
  p:   QueueItemPayload,
): ReviewQueueItem {
  return {
    id:             row.id,
    createdAt:      row.createdAt.toISOString(),
    hubId:          row.aggregateId,
    action:         p.action,
    summary:        p.summary,
    observation:    p.observation,
    reconciliation: p.reconciliation,
    candidates:     p.candidates,
  };
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const ACTION_VALUES = [
  "register_new",
  "needs_manual_review",
  "hold_for_mac_conflict",
] as const;

// GET query params
const listQuerySchema = z.object({
  // Coerce from query-string string → integer. Default 50, max 100.
  limit:  z.coerce.number().int().min(1).max(100).default(50),
  // Optional filter by pipeline action — restricts to a single outcome type
  action: z.enum(ACTION_VALUES).optional(),
  // Optional filter by hub — maps to domain_events.aggregate_id (direct column)
  hubId:  z.string().uuid().optional(),
});

// POST /dismiss body
const dismissBodySchema = z.object({
  // Optional human-readable reason for dismissal — stored in payload for audit.
  // Not required so operators can dismiss quickly from a UI without a modal.
  reason: z.string().max(500).optional(),
});

// POST /resolve — "provision" body
//
// Enum values mirror the domain types in packages/domain/hardware/types.ts.
// Validated here so the route rejects unknown strings before touching the DB.
const VENDOR_VALUES    = ["tachyon", "unifi_protect", "sensorpush", "ecowitt", "mokosmart", "fanstel", "generic"] as const;
const MODEL_VALUES     = ["sc833f", "s05t", "bme280", "hx711", "inmp441", "generic"] as const;
const TRANSPORT_VALUES = ["ble", "gpio", "csi", "cloud", "manual"] as const;
const ROLE_VALUES      = ["primary_environment", "thermal_map", "weight", "audio", "entrance_camera", "apiary_camera", "ambient_weather", "unknown"] as const;

// Standard colon-separated MAC — XX:XX:XX:XX:XX:XX (case-insensitive).
// Normalised to uppercase before DB write.
const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

const LOCATION_ROLE_VALUES = [
  "apiary_ambient", "hive_exterior", "entrance", "inner_cover",
  "brood_box_upper", "brood_box_lower", "honey_super",
  "base_scale", "under_hive", "audio_probe", "custom",
] as const;

const provisionBodySchema = z.object({
  resolution:        z.literal("provision"),
  assetId:           z.string().min(1).max(50),
  name:              z.string().min(1).max(255),
  vendor:            z.enum(VENDOR_VALUES),
  model:             z.enum(MODEL_VALUES),
  transport:         z.enum(TRANSPORT_VALUES),
  role:              z.enum(ROLE_VALUES),
  // hiveId and currentMacAddress are optional — a freshly provisioned sensor
  // may not yet have a hive assignment or a confirmed MAC.
  hiveId:            z.string().uuid().nullable().optional().default(null),
  currentMacAddress: z.string().regex(MAC_RE, "must be a valid MAC address (XX:XX:XX:XX:XX:XX)")
                       .nullable().optional().default(null),
  // Physical placement within the hive — optional, can be set later via assign UI
  locationRole:      z.enum(LOCATION_ROLE_VALUES).nullable().optional().default(null),
  locationNote:      z.string().max(500).nullable().optional().default(null),
});

// POST /resolve — "select_candidate" body
//
// Minimal: the operator supplies only the registryId they are selecting.
// All other context (observed MAC, deviceIdentifier, relinkRequired, previousMac)
// is reconstructed from the queue item's stored payload — it was captured by
// queueForReview() at observation time and is the authoritative source.
const selectCandidateBodySchema = z.object({
  resolution: z.literal("select_candidate"),
  // UUID of the registry record the operator has chosen from the candidates list.
  registryId: z.string().uuid(),
});

// POST /resolve — "force_relink" body
//
// No operator-supplied fields beyond resolution type. The contested MAC,
// target record, and hub context are derived entirely from the queue item's
// stored reconciliation payload. Allowing the operator to override these
// would open a confused-deputy path where the MAC is forced onto an arbitrary
// record rather than the one the pipeline matched.
const forceRelinkBodySchema = z.object({
  resolution: z.literal("force_relink"),
});

// ---------------------------------------------------------------------------
// GET /api/v1/sensor-identity/review-queue
// ---------------------------------------------------------------------------
//
// Returns pending (processedAt IS NULL) sensor identity review items.
// Ordered oldest-first so operators work through the backlog in arrival order.
//
// Filters:
//   ?limit=N       — page size (1–100, default 50)
//   ?action=…      — restrict to one outcome type
//   ?hubId=<uuid>  — restrict to one hub (uses aggregate_id column directly)
//
// Items with malformed payloads are silently skipped with a warning log.
// They do not cause the endpoint to fail — a future sweep job can clean them.

router.get(
  "/review-queue",
  requireAuth,
  requireRole("queen", "worker"),
  async (req: AuthRequest, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error:   "Invalid query parameters",
        details: parsed.error.flatten(),
      });
    }

    const { limit, action, hubId } = parsed.data;

    const rows = await db.domainEvent.findMany({
      where: {
        eventType:   "sensor.identity.review_queued",
        processedAt: null,
        // hubId maps to aggregateId — a direct column, no JSON traversal needed
        ...(hubId  ? { aggregateId: hubId }                              : {}),
        // action lives inside the JSONB payload — use Prisma's path filter
        // which generates: WHERE payload->'action' = '"register_new"'
        ...(action ? { payload: { path: ["action"], equals: action } }  : {}),
      },
      orderBy: { createdAt: "asc" },
      take:    limit,
      select: {
        id:          true,
        createdAt:   true,
        aggregateId: true,
        payload:     true,
      },
    });

    const items: ReviewQueueItem[] = [];
    for (const row of rows) {
      const p = toQueuePayload(row.payload);
      if (p === null) {
        // Unexpected — queueForReview always writes a well-formed object.
        // Skip rather than 500 the whole list; a sweep can fix orphaned rows.
        logger.warn(
          { eventId: row.id },
          "sensor-identity-queue: skipping item with unparseable payload",
        );
        continue;
      }
      items.push(toReviewQueueItem(row, p));
    }

    return res.json({ items, count: items.length });
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/sensor-identity/review-queue/:id/dismiss
// ---------------------------------------------------------------------------
//
// Marks a single pending queue item as dismissed without provisioning or linking.
// Use this when the observation was noise (visitor device, stale BLE advert,
// physically decommissioned sensor, etc.) and no registry action is needed.
//
// Writes:
//   domain_events.processed_at = NOW()
//   domain_events.payload      = { ...original, dismissedBy, dismissedAt, dismissReason? }
//
// The original observation/reconciliation/candidates data is preserved intact.
// Dismissal metadata is appended — not merged into a separate column — so the
// complete context is available in a single payload read.
//
// Returns:
//   200 { ok: true, id, processedAt }
//   400 invalid id or body
//   404 item not found or wrong event type
//   409 already processed (already dismissed or resolved)

router.post(
  "/review-queue/:id/dismiss",
  requireAuth,
  requireRole("queen", "worker"),
  async (req: AuthRequest, res) => {
    const id = req.params.id as string;

    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid id format" });
    }

    const parsed = dismissBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error:   "Invalid input",
        details: parsed.error.flatten(),
      });
    }

    const { reason } = parsed.data;

    // Load the item — confirm it exists, is the right event type, and is pending.
    const event = await db.domainEvent.findUnique({
      where:  { id },
      select: { id: true, eventType: true, processedAt: true, payload: true, aggregateId: true },
    });

    if (!event || event.eventType !== "sensor.identity.review_queued") {
      return res.status(404).json({ error: "Queue item not found" });
    }

    if (event.processedAt !== null) {
      return res.status(409).json({ error: "Queue item has already been processed" });
    }

    const now = new Date();

    // Spread existing payload and append dismissal fields.
    // Guards against the payload being null/primitive (defensive — should never
    // occur for items of this event type, but keeps the type system happy).
    const base: Record<string, Prisma.JsonValue> =
      event.payload !== null &&
      typeof event.payload === "object" &&
      !Array.isArray(event.payload)
        ? (event.payload as Record<string, Prisma.JsonValue>)
        : {};

    const updatedPayload: Prisma.InputJsonValue = {
      ...base,
      dismissedBy:  req.user!.id,
      dismissedAt:  now.toISOString(),
      // omit dismissReason key entirely when no reason supplied — cleaner payload
      ...(reason !== undefined ? { dismissReason: reason } : {}),
    };

    await db.domainEvent.update({
      where: { id },
      data:  {
        processedAt: now,
        payload:     updatedPayload,
      },
    });

    logger.info(
      {
        resolution:  "dismiss",
        queueItemId: id,
        hubId:       event.aggregateId,
        dismissedBy: req.user!.id,
        reason:      reason ?? null,
      },
      "sensor-identity-queue: item dismissed",
    );

    return res.json({
      ok:          true,
      id,
      processedAt: now.toISOString(),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/sensor-identity/review-queue/:id/resolve
// ---------------------------------------------------------------------------
//
// Resolves a pending queue item. Supports two resolution types:
//
//   "provision"        — register_new items only. Creates a new SensorRegistry
//                        row, ProvisioningEvent audit record, and seals the
//                        queue item — all in a single transaction.
//
//   "select_candidate" — needs_manual_review items only. Operator picks which
//                        candidate registry record the observation belongs to.
//                        Runs link_confirmed or relink_mac logic (determined
//                        by reconciliation.relinkRequired stored in the payload)
//                        and seals the queue item — all in a single transaction.
//
//   "force_relink"     — hold_for_mac_conflict items only. Operator confirms the
//                        contested MAC belongs to the matched record (A). Revokes
//                        the MAC from whoever currently holds it (B, if any),
//                        assigns it to A, writes audit events for both records,
//                        and seals the queue item — all in a single transaction.
//
// Guard sequence — provision:
//   1. Validate :id UUID
//   2. Pre-check resolution type — 400 if unsupported
//   3. Zod validation of provision body
//   4. assetId format check (isValidAssetId)
//   5. Load queue item — 404 if missing/wrong type
//   6. processedAt null check — 409 if already processed
//   7. payload.action === 'register_new' — 409 otherwise
//   8. persistProvisionNew() — 5-step transaction
//      AssetIdConflictError → 409 | MacCollisionError → 409 | other → 500
//
// Guard sequence — select_candidate:
//   1. Validate :id UUID
//   2. Pre-check resolution type — 400 if unsupported
//   3. Zod validation of select_candidate body
//   4. Load queue item — 404 if missing/wrong type
//   5. processedAt null check — 409 if already processed
//   6. payload.action === 'needs_manual_review' — 409 otherwise
//   7. body.registryId in payload.candidates — 409 if not a candidate
//   8. persistSelectCandidate() — transaction (relinkRequired path or confirm path)
//      MacCollisionError → 409 | other → 500
//
// Guard sequence — force_relink:
//   1. Validate :id UUID
//   2. Pre-check resolution type — 400 if unsupported
//   3. Zod validation of force_relink body (no fields beyond resolution type)
//   4. Load queue item — 404 if missing/wrong type
//   5. processedAt null check — 409 if already processed
//   6. payload.action === 'hold_for_mac_conflict' — 409 otherwise
//   7. payload.reconciliation.matchedRecordId non-null — 500 if violated
//   8. payload.reconciliation.observedMac non-null — 500 if violated
//   9. persistForceRelink() — transaction (revoke B's MAC, assign to A, audit both, seal)
//      RetiredRecordError → 409 | other → 500
//
// Returns (provision):
//   201  { ok, resolution, createdRegistryId, assetId, processedAt }
// Returns (select_candidate):
//   200  { ok, resolution, selectedRegistryId, relinkPerformed, processedAt }
// Returns (force_relink):
//   200  { ok, resolution, targetRegistryId, revokedFromRegistryId, processedAt }
// Errors (all):
//   400  invalid input or unsupported resolution type
//   404  item not found or wrong event type
//   409  already processed | conflict | wrong action type | retired record
//   500  unexpected error | pipeline invariant violation

router.post(
  "/review-queue/:id/resolve",
  requireAuth,
  requireRole("queen", "worker"),
  async (req: AuthRequest, res) => {
    const id = req.params.id as string;

    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid id format" });
    }

    // Pre-check resolution type before running the full Zod parse.
    // Keeps the error clear and makes it trivial to add new resolution types later.
    const resolutionType = req.body?.resolution;
    if (
      resolutionType !== "provision" &&
      resolutionType !== "select_candidate" &&
      resolutionType !== "force_relink"
    ) {
      return res.status(400).json({
        error:     "Unsupported or missing resolution type",
        received:  resolutionType ?? null,
        supported: ["provision", "select_candidate", "force_relink"],
      });
    }

    // ── provision path ───────────────────────────────────────────────────────
    if (resolutionType === "provision") {
      const parsed = provisionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error:   "Invalid input",
          details: parsed.error.flatten(),
        });
      }

      const body = parsed.data;

      // assetId format validation — reject non-BK-XXX-NNNN strings immediately
      // rather than letting them fall through to a DB error.
      if (!isValidAssetId(body.assetId)) {
        return res.status(400).json({ error: "assetId format is invalid" });
      }

      // Normalize MAC to uppercase so it is stored consistently with how the
      // pipeline normalises MACs in normalizeObservation().
      const normalizedMac =
        body.currentMacAddress !== null
          ? body.currentMacAddress.toUpperCase().trim()
          : null;

      // Load the queue item — confirm it exists, is the right type, and is pending.
      const event = await db.domainEvent.findUnique({
        where:  { id },
        select: { id: true, eventType: true, processedAt: true, payload: true, aggregateId: true },
      });

      if (!event || event.eventType !== "sensor.identity.review_queued") {
        return res.status(404).json({ error: "Queue item not found" });
      }

      if (event.processedAt !== null) {
        return res.status(409).json({ error: "Queue item has already been processed" });
      }

      const queuePayload = toQueuePayload(event.payload);
      if (queuePayload === null) {
        // Should never happen for items written by queueForReview(), but guard anyway.
        logger.error({ eventId: id }, "sensor-identity-queue: queue item has malformed payload");
        return res.status(500).json({ error: "Queue item has malformed payload" });
      }

      // This resolution only applies to register_new items.
      // needs_manual_review and hold_for_mac_conflict have different resolution paths.
      if (queuePayload.action !== "register_new") {
        return res.status(409).json({
          error:        "resolution 'provision' only applies to register_new queue items",
          actualAction: queuePayload.action,
        });
      }

      // Spread existing payload for the transaction's payload-merge step.
      const existingPayload: Record<string, unknown> =
        event.payload !== null &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};

      // deviceIdentifier is not in the request body — it comes from the original
      // observation context captured by queueForReview(). Fall back to assetId
      // when the hub reported no identifier (e.g. MAC-only observation).
      const deviceIdentifier =
        queuePayload.observation.deviceIdentifier ?? body.assetId;

      try {
        const newRegistryId = await persistProvisionNew({
          assetId:              body.assetId,
          deviceIdentifier,
          name:                 body.name,
          vendor:               body.vendor,
          model:                body.model,
          transport:            body.transport,
          role:                 body.role,
          hiveId:               body.hiveId ?? null,
          hubId:                event.aggregateId,
          currentMacAddress:    normalizedMac,
          locationRole:         body.locationRole ?? null,
          locationNote:         body.locationNote ?? null,
          actorId:              req.user!.id,
          queueItemId:          id,
          existingQueuePayload: existingPayload,
        });

        logger.info(
          { eventId: id, registryId: newRegistryId, assetId: body.assetId, actorId: req.user!.id },
          "sensor-identity-queue: register_new resolved via provision",
        );

        return res.status(201).json({
          ok:                true,
          resolution:        "provision",
          createdRegistryId: newRegistryId,
          assetId:           body.assetId,
          processedAt:       new Date().toISOString(),
        });

      } catch (err) {
        if (err instanceof AssetIdConflictError) {
          return res.status(409).json({
            error:                 `assetId '${body.assetId}' is already in use`,
            conflictingRegistryId: err.conflictingRegistryId,
          });
        }
        if (err instanceof MacCollisionError) {
          return res.status(409).json({
            error:                 `MAC address '${normalizedMac}' is already in use`,
            conflictingRegistryId: err.conflictingRegistryId,
          });
        }
        logger.error(
          { err: (err as Error).message, stack: (err as Error).stack, eventId: id },
          "sensor-identity-queue: unexpected error during provision resolve",
        );
        return res.status(500).json({ error: "Internal server error" });
      }
    }

    // ── select_candidate path ─────────────────────────────────────────────────
    if (resolutionType === "select_candidate") {
    const parsedSC = selectCandidateBodySchema.safeParse(req.body);
    if (!parsedSC.success) {
      return res.status(400).json({
        error:   "Invalid input",
        details: parsedSC.error.flatten(),
      });
    }

    const scBody = parsedSC.data;

    // Load the queue item — confirm it exists, is the right type, and is pending.
    const scEvent = await db.domainEvent.findUnique({
      where:  { id },
      select: { id: true, eventType: true, processedAt: true, payload: true, aggregateId: true },
    });

    if (!scEvent || scEvent.eventType !== "sensor.identity.review_queued") {
      return res.status(404).json({ error: "Queue item not found" });
    }

    if (scEvent.processedAt !== null) {
      return res.status(409).json({ error: "Queue item has already been processed" });
    }

    const scPayload = toQueuePayload(scEvent.payload);
    if (scPayload === null) {
      logger.error({ eventId: id }, "sensor-identity-queue: queue item has malformed payload");
      return res.status(500).json({ error: "Queue item has malformed payload" });
    }

    // This resolution only applies to needs_manual_review items (ambiguous_match).
    // register_new uses "provision"; hold_for_mac_conflict uses "force_relink".
    if (scPayload.action !== "needs_manual_review") {
      return res.status(409).json({
        error:        "resolution 'select_candidate' only applies to needs_manual_review queue items",
        actualAction: scPayload.action,
      });
    }

    // Verify the supplied registryId is in the item's candidates list.
    // The candidates are exactly the records the pipeline couldn't choose between.
    // Selecting a registryId not in that set is an operator error — they may be
    // targeting a device that was not part of this ambiguous observation at all.
    const candidate = scPayload.candidates.find(c => c.id === scBody.registryId);
    if (!candidate) {
      return res.status(409).json({
        error:      "registryId is not a candidate for this queue item",
        registryId: scBody.registryId,
      });
    }

    // Determine whether a MAC relink is required.
    // All three conditions must hold:
    //   - reconciliation flagged it (some identifier-tier matched but MAC differs)
    //   - no cross-tier conflict (another record does not own the observed MAC)
    //   - the observation actually carries a MAC to write
    //
    // For needs_manual_review (ambiguous_match) the domain guarantees
    // crossTierConflict === false, but we read it from the stored payload
    // rather than hard-coding so the logic stays correct if that ever changes.
    const recon = scPayload.reconciliation;
    const relinkRequired =
      recon.relinkRequired &&
      !recon.crossTierConflict &&
      recon.observedMac !== null;

    // Preserve existing payload for the transaction's spread-and-append step.
    const scExistingPayload: Record<string, unknown> =
      scEvent.payload !== null &&
      typeof scEvent.payload === "object" &&
      !Array.isArray(scEvent.payload)
        ? (scEvent.payload as Record<string, unknown>)
        : {};

    try {
      await persistSelectCandidate({
        registryId:           scBody.registryId,
        // Pass the raw observedMac — persistSelectCandidate guards on
        // relinkRequired && observedMacAddress !== null internally.
        observedMacAddress:   recon.observedMac,
        deviceIdentifier:     scPayload.observation.deviceIdentifier,
        previousMac:          recon.previousMac,
        relinkRequired,
        actorId:              req.user!.id,
        queueItemId:          id,
        hubId:                scEvent.aggregateId,
        existingQueuePayload: scExistingPayload,
      });

      logger.info(
        {
          eventId:        id,
          registryId:     scBody.registryId,
          relinkRequired,
          actorId:        req.user!.id,
        },
        "sensor-identity-queue: needs_manual_review resolved via select_candidate",
      );

      return res.status(200).json({
        ok:                 true,
        resolution:         "select_candidate",
        selectedRegistryId: scBody.registryId,
        relinkPerformed:    relinkRequired,
        processedAt:        new Date().toISOString(),
      });

    } catch (err) {
      if (err instanceof MacCollisionError) {
        return res.status(409).json({
          error:                 `MAC address '${recon.observedMac}' is already in use`,
          conflictingRegistryId: err.conflictingRegistryId,
        });
      }
      logger.error(
        { err: (err as Error).message, stack: (err as Error).stack, eventId: id },
        "sensor-identity-queue: unexpected error during select_candidate resolve",
      );
      return res.status(500).json({ error: "Internal server error" });
    }
    } // end select_candidate

    // ── force_relink path ─────────────────────────────────────────────────────
    // resolutionType === "force_relink" here — the pre-check guarantees the value
    // is one of the three supported types; provision and select_candidate both
    // return before reaching this point.

    const parsedFR = forceRelinkBodySchema.safeParse(req.body);
    if (!parsedFR.success) {
      return res.status(400).json({
        error:   "Invalid input",
        details: parsedFR.error.flatten(),
      });
    }

    // Load the queue item — confirm it exists, is the right type, and is pending.
    const frEvent = await db.domainEvent.findUnique({
      where:  { id },
      select: { id: true, eventType: true, processedAt: true, payload: true, aggregateId: true },
    });

    if (!frEvent || frEvent.eventType !== "sensor.identity.review_queued") {
      return res.status(404).json({ error: "Queue item not found" });
    }

    if (frEvent.processedAt !== null) {
      return res.status(409).json({ error: "Queue item has already been processed" });
    }

    const frPayload = toQueuePayload(frEvent.payload);
    if (frPayload === null) {
      logger.error({ eventId: id }, "sensor-identity-queue: queue item has malformed payload");
      return res.status(500).json({ error: "Queue item has malformed payload" });
    }

    // This resolution only applies to hold_for_mac_conflict items.
    // register_new uses "provision"; needs_manual_review uses "select_candidate".
    if (frPayload.action !== "hold_for_mac_conflict") {
      return res.status(409).json({
        error:        "resolution 'force_relink' only applies to hold_for_mac_conflict queue items",
        actualAction: frPayload.action,
      });
    }

    // Pipeline invariants: hold_for_mac_conflict guarantees both fields are
    // non-null — crossTierConflict requires a non-null observedMac, and the
    // action only fires after a single higher-tier record matched. Surface 500
    // rather than silently proceeding if either is missing; the payload is corrupt.
    const matchedRecordId = frPayload.reconciliation.matchedRecordId;
    const contestedMac    = frPayload.reconciliation.observedMac;

    if (matchedRecordId === null || contestedMac === null) {
      logger.error(
        { eventId: id, matchedRecordId, contestedMac },
        "sensor-identity-queue: hold_for_mac_conflict item is missing required reconciliation fields",
      );
      return res.status(500).json({ error: "Queue item is missing required reconciliation fields" });
    }

    // Preserve existing payload for the transaction's spread-and-append step.
    const frExistingPayload: Record<string, unknown> =
      frEvent.payload !== null &&
      typeof frEvent.payload === "object" &&
      !Array.isArray(frEvent.payload)
        ? (frEvent.payload as Record<string, unknown>)
        : {};

    try {
      const { targetRegistryId, revokedFromRegistryId } = await persistForceRelink({
        matchedRegistryId:    matchedRecordId,
        contestedMac,
        previousMacOnA:       frPayload.reconciliation.previousMac,
        deviceIdentifier:     frPayload.observation.deviceIdentifier,
        actorId:              req.user!.id,
        queueItemId:          id,
        hubId:                frEvent.aggregateId,
        existingQueuePayload: frExistingPayload,
      });

      logger.info(
        {
          eventId:               id,
          targetRegistryId,
          revokedFromRegistryId,
          contestedMac,
          actorId:               req.user!.id,
        },
        "sensor-identity-queue: hold_for_mac_conflict resolved via force_relink",
      );

      return res.status(200).json({
        ok:                    true,
        resolution:            "force_relink",
        targetRegistryId,
        revokedFromRegistryId,
        processedAt:           new Date().toISOString(),
      });

    } catch (err) {
      if (err instanceof RetiredRecordError) {
        return res.status(409).json({
          error:      err.message,
          registryId: err.registryId,
        });
      }
      if (err instanceof ConflictDriftedError) {
        return res.status(409).json({
          error:        err.message,
          registryId:   err.registryId,
          contestedMac: err.contestedMac,
        });
      }
      logger.error(
        { err: (err as Error).message, stack: (err as Error).stack, eventId: id },
        "sensor-identity-queue: unexpected error during force_relink resolve",
      );
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

export { router as sensorIdentityQueueRouter };
