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
//   "provision" — register_new items only (Step 3)
//   "select_candidate" and "force_relink" — Steps 4 & 5, not yet implemented
//
// Auth: requireAuth + requireRole("queen", "worker") on all endpoints.

import { Router } from "express";
import { z } from "zod";
import { db, Prisma } from "@beekeeper/db";
import { logger } from "../lib/logger";
import { requireAuth, requireRole, AuthRequest } from "../middleware/auth";
import {
  persistProvisionNew,
  AssetIdConflictError,
  MacCollisionError,
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
    const { id } = req.params;

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
      select: { id: true, eventType: true, processedAt: true, payload: true },
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
      { eventId: id, dismissedBy: req.user!.id, reason: reason ?? null },
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
// Resolves a pending queue item. Currently supports one resolution type:
//
//   "provision" — only valid for register_new items. Creates a new SensorRegistry
//                 row, a ProvisioningEvent audit record, and marks the queue item
//                 processed — all in a single transaction.
//
// Resolution types "select_candidate" (needs_manual_review) and "force_relink"
// (hold_for_mac_conflict) are Steps 4 & 5 and are not yet implemented.
//
// Guard sequence (short-circuits early on failure):
//   1. Validate :id is a UUID
//   2. Check resolution type is "provision" — 400 otherwise (future types added here)
//   3. Full Zod validation of the provision body
//   4. assetId format check via isValidAssetId()
//   5. Load and verify the queue item (exists, correct event type, not yet processed)
//   6. Verify payload.action === 'register_new' — 409 if item is a different action type
//   7. Delegate to persistProvisionNew() — runs the 5-step DB transaction
//      Throws AssetIdConflictError → 409
//      Throws MacCollisionError    → 409
//      Unexpected error            → 500
//
// Returns:
//   201  { ok, resolution, createdRegistryId, assetId, processedAt }
//   400  invalid input or unsupported resolution type
//   404  item not found or wrong event type
//   409  already processed | assetId conflict | MAC conflict | wrong action type
//   500  unexpected error

router.post(
  "/review-queue/:id/resolve",
  requireAuth,
  requireRole("queen", "worker"),
  async (req: AuthRequest, res) => {
    const { id } = req.params;

    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid id format" });
    }

    // Pre-check resolution type before running the full Zod parse.
    // Keeps the error clear and makes it trivial to add new resolution types later.
    const resolutionType = req.body?.resolution;
    if (resolutionType !== "provision") {
      return res.status(400).json({
        error:     "Unsupported or missing resolution type",
        received:  resolutionType ?? null,
        supported: ["provision"],
      });
    }

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

    // This endpoint's "provision" resolution only applies to register_new items.
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
        hubId:                event.aggregateId,      // hub that reported the original observation
        currentMacAddress:    normalizedMac,
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
  },
);

export { router as sensorIdentityQueueRouter };
