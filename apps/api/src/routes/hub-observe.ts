// apps/api/src/routes/hub-observe.ts
//
// POST /api/v1/hubs/observe        — single observation
// POST /api/v1/hubs/observe/batch  — batch of up to 100 observations
//
// Tachyon sensor identity observation endpoint.
//
// Accepts sensor identity observations from an authenticated hub,
// runs each through the full domain pipeline (normalise → reconcile → decide →
// intend → summarise), and either persists a safe outcome immediately or
// queues an unresolved one for human review.
//
// Auth:  X-Hub-Key header (same key-based auth as all other hub routes).
//        requireHubKey is not exported from hubs.ts, so the pattern is copied
//        verbatim here — see comment on requireHubKey below.
//
// Single body (all fields optional/nullable):
//   { assetId?, deviceIdentifier?, observedMacAddress?, observedAt? }
//
// Batch body:
//   { observations: [ { assetId?, deviceIdentifier?, observedMacAddress?, observedAt? }, ... ] }
//   min 1 item, max 100 items.
//
// Action routing (both endpoints):
//   link_confirmed        → persistLinkConfirmed    (identity confirmed, no state change)
//   relink_mac            → persistRelinkMac        (MAC changed, safe to write)
//   needs_manual_review   → queueForReview          (ambiguous candidates)
//   hold_for_mac_conflict → queueForReview          (MAC owned by different record)
//   register_new          → queueForReview          (device not in registry)
//
// Single response:
//   200  { action, summary, registryId, manualReviewRequired, relinkRequired }
//   400  { error }                          — invalid input or malformed assetId
//   401  { error }                          — missing/invalid hub key
//   409  { error, conflictingRegistryId }   — MAC collision in persistRelinkMac
//   500  { error }                          — unexpected error
//
// Batch response (envelope always 200):
//   200  { results, count, successCount, errorCount }
//   Per-item success: { index, status:200, action, summary, registryId,
//                       manualReviewRequired, relinkRequired }
//   Per-item error:   { index, status:400|409|500, error, [conflictingRegistryId] }
//   400  { error }    — invalid batch body (fails before any item is processed)
//   401  { error }    — missing/invalid hub key

import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { db } from "@beekeeper/db";
import { logger } from "../lib/logger";
import {
  loadRegistryRecordsForHub,
  persistLinkConfirmed,
  persistRelinkMac,
  queueForReview,
  MacCollisionError,
} from "../lib/sensor-registry-db";
import { processSensorObservation } from "../../../../packages/domain/hardware/pipeline";
import { isValidAssetId } from "../../../../packages/domain/hardware/actions";
import type { AuthRequest } from "../middleware/auth";
import type { SensorIdentityObservation } from "../../../../packages/domain/hardware/types";

const router = Router();

// ── Hub key auth ──────────────────────────────────────────────────────────────
//
// requireHubKey is defined in hubs.ts but is not exported. The implementation
// is self-contained (hash header → DB lookup → attach req.hub), so it is
// reproduced here rather than reaching into hubs.ts internals.
// If the auth logic ever needs to change, update both copies (or export it).

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

interface HubRequest extends AuthRequest {
  hub?: { id: string; apiaryId: string | null; name: string };
}

async function requireHubKey(
  req:  HubRequest,
  res:  import("express").Response,
  next: import("express").NextFunction,
) {
  const rawKey = req.header("x-hub-key");
  if (!rawKey || rawKey.length < 24) {
    return res.status(401).json({ error: "Missing or malformed X-Hub-Key header" });
  }

  const hash = sha256(rawKey);
  const hub  = await db.hub.findUnique({
    where:  { apiKeyHash: hash },
    select: { id: true, apiaryId: true, name: true, isActive: true },
  });

  if (!hub || !hub.isActive) {
    return res.status(401).json({ error: "Invalid or inactive hub key" });
  }

  req.hub = { id: hub.id, apiaryId: hub.apiaryId, name: hub.name };
  next();
}

// ── Validation schema ─────────────────────────────────────────────────────────
//
// All four observation fields are optional on the wire and default to null so
// the domain layer always receives string | null (never undefined).
//
// Empty strings are accepted here and normalised to null by the pipeline's
// normalizeObservation() stage — we do not double-normalise to avoid
// divergence with the domain spec.
//
// assetId format is validated separately after parsing: a present,
// non-empty value that fails isValidAssetId() gets a 400 immediately so the
// operator sees a clear signal rather than an opaque register_new action.

const observeSchema = z.object({
  assetId:            z.string().nullable().optional().default(null),
  deviceIdentifier:   z.string().nullable().optional().default(null),
  observedMacAddress: z.string().nullable().optional().default(null),
  observedAt:         z.string().nullable().optional().default(null),
});

// ── Batch validation schema ───────────────────────────────────────────────────
//
// Wraps the per-item observeSchema in an array.
// min(1) rejects empty batches; max(100) is the hard cap per request.

const batchObserveSchema = z.object({
  observations: z
    .array(observeSchema)
    .min(1, "observations must not be empty")
    .max(100, "observations must not exceed 100 items"),
});

// ── Per-item batch result type ────────────────────────────────────────────────

type BatchItemResult =
  | {
      index:                number;
      status:               200;
      action:               string;
      summary:              string;
      registryId:           string | null;
      manualReviewRequired: boolean;
      relinkRequired:       boolean;
    }
  | {
      index:                  number;
      status:                 400 | 409 | 500;
      error:                  string;
      conflictingRegistryId?: string;
    };

// ── POST /observe ─────────────────────────────────────────────────────────────

router.post("/observe", requireHubKey, async (req: HubRequest, res) => {
  // ── Parse & validate ───────────────────────────────────────────────────────
  const parsed = observeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error:   "Invalid input",
      details: parsed.error.flatten(),
    });
  }

  const { assetId, deviceIdentifier, observedMacAddress, observedAt } = parsed.data;

  // Reject non-null assetId values that don't match the BK-XXX-NNNN format.
  // Empty strings pass through — normalizeObservation() will convert them to
  // null so they don't pollute the registry lookup.
  if (assetId !== null && assetId.trim().length > 0 && !isValidAssetId(assetId.trim())) {
    return res.status(400).json({ error: "assetId format is invalid" });
  }

  const hubId  = req.hub!.id;
  const nowISO = new Date().toISOString();

  // Use the hub-reported timestamp when present and non-empty; fall back to
  // server time. A missing observedAt is normal (not an error) — some hub
  // firmware versions do not populate it.
  const effectiveObservedAt =
    observedAt !== null && observedAt.trim().length > 0
      ? observedAt.trim()
      : nowISO;

  // Build the observation object once. The pipeline will normalise all fields
  // (trim, uppercase MAC, "" → null) internally — we pass raw values here.
  const observation: SensorIdentityObservation = {
    assetId,
    deviceIdentifier,
    observedMacAddress,
    observedAt: effectiveObservedAt,
  };

  try {
    // ── Load registry snapshot ─────────────────────────────────────────────
    // Scoped to this hub; excludes retired records.
    const records = await loadRegistryRecordsForHub(hubId);

    // ── Run full domain pipeline ───────────────────────────────────────────
    // Pure function: normalise → reconcile → decide → intend → summarise.
    // Never throws; always returns a SensorProcessingResult.
    const result = processSensorObservation(
      records,
      observation,
      null,    // actorId — automated observation, no human actor
      nowISO,
    );

    const { action, summary, linkIntent, reconciliation } = result;

    // ── Persist or queue ───────────────────────────────────────────────────
    switch (action) {
      case "link_confirmed":
        // linkIntent is guaranteed non-null when action is link_confirmed:
        // buildSafeIntent returns non-null iff matchedRecord != null,
        // !manualReviewRequired, and !crossTierConflict — all true here.
        await persistLinkConfirmed(linkIntent!, summary, hubId);
        break;

      case "relink_mac":
        // linkIntent is guaranteed non-null (same guards as link_confirmed,
        // plus relinkRequired === true and crossTierConflict === false).
        // May throw MacCollisionError (belt-and-suspenders race guard).
        await persistRelinkMac(
          linkIntent!,
          reconciliation.previousMac,
          summary,
          hubId,
        );
        break;

      case "needs_manual_review":
      case "hold_for_mac_conflict":
      case "register_new":
        // No matchedRecord or conflict blocks auto-resolution.
        // Write to DomainEvent queue for human review.
        await queueForReview(result, observation, hubId);
        break;
    }

    // ── Success response ───────────────────────────────────────────────────
    return res.status(200).json({
      action,
      summary,
      registryId:           linkIntent?.registryId ?? null,
      manualReviewRequired: result.requiresManualReview,
      relinkRequired:       result.shouldRelink,
    });

  } catch (err) {
    // MacCollisionError: belt-and-suspenders race guard inside persistRelinkMac.
    // The pipeline's crossTierConflict check is the primary guard (suspenders);
    // the in-transaction findFirst is the belt. If both fire simultaneously,
    // the transaction throws here — return 409 so the hub can retry or alert.
    if (err instanceof MacCollisionError) {
      return res.status(409).json({
        error:                  err.message,
        conflictingRegistryId:  err.conflictingRegistryId,
      });
    }

    logger.error(
      { err: (err as Error).message, stack: (err as Error).stack, hubId },
      "hub-observe: unexpected error during sensor observation",
    );
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /observe/batch ───────────────────────────────────────────────────────
//
// Processes up to 100 sensor identity observations in a single request.
// Each item is processed independently — one failure does not abort the batch.
//
// The registry snapshot is loaded once before the loop and shared across all
// items. This matches the single-item route's snapshot-at-request-time
// semantics. Individual DB writes run per-item inside their own transactions.
//
// The envelope response is always HTTP 200; per-item status codes appear in
// each result object. Callers should inspect results[n].status to determine
// whether each observation was processed successfully.

router.post("/observe/batch", requireHubKey, async (req: HubRequest, res) => {
  // ── Parse & validate ───────────────────────────────────────────────────────
  const parsed = batchObserveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error:   "Invalid input",
      details: parsed.error.flatten(),
    });
  }

  const { observations } = parsed.data;
  const hubId  = req.hub!.id;
  const nowISO = new Date().toISOString();

  // ── Load registry snapshot once for the entire batch ──────────────────────
  // Scoped to this hub; excludes retired records. A failure here aborts the
  // whole request — there is no meaningful per-item fallback without the registry.
  const records = await loadRegistryRecordsForHub(hubId).catch((err) => {
    logger.error(
      { err: (err as Error).message, hubId },
      "hub-observe: failed to load registry snapshot for batch",
    );
    return null;
  });
  if (records === null) {
    return res.status(500).json({ error: "Internal server error" });
  }

  const results: BatchItemResult[] = [];
  let successCount = 0;
  let errorCount   = 0;

  for (let i = 0; i < observations.length; i++) {
    const { assetId, deviceIdentifier, observedMacAddress, observedAt } =
      observations[i];

    // ── Per-item assetId format check ────────────────────────────────────────
    // Same logic as the single-item route: a non-null, non-empty assetId that
    // fails the BK-XXX-NNNN pattern is rejected immediately rather than falling
    // through to an opaque register_new result.
    if (assetId !== null && assetId.trim().length > 0 && !isValidAssetId(assetId.trim())) {
      results.push({ index: i, status: 400, error: "assetId format is invalid" });
      errorCount++;
      continue;
    }

    const effectiveObservedAt =
      observedAt !== null && observedAt.trim().length > 0
        ? observedAt.trim()
        : nowISO;

    const observation: SensorIdentityObservation = {
      assetId,
      deviceIdentifier,
      observedMacAddress,
      observedAt: effectiveObservedAt,
    };

    try {
      // ── Run full domain pipeline (pure, never throws) ──────────────────────
      const result = processSensorObservation(records, observation, null, nowISO);
      const { action, summary, linkIntent, reconciliation } = result;

      // ── Persist or queue ───────────────────────────────────────────────────
      switch (action) {
        case "link_confirmed":
          await persistLinkConfirmed(linkIntent!, summary, hubId);
          break;

        case "relink_mac":
          await persistRelinkMac(
            linkIntent!,
            reconciliation.previousMac,
            summary,
            hubId,
          );
          break;

        case "needs_manual_review":
        case "hold_for_mac_conflict":
        case "register_new":
          await queueForReview(result, observation, hubId);
          break;
      }

      results.push({
        index:                i,
        status:               200,
        action,
        summary,
        registryId:           linkIntent?.registryId ?? null,
        manualReviewRequired: result.requiresManualReview,
        relinkRequired:       result.shouldRelink,
      });
      successCount++;

    } catch (err) {
      if (err instanceof MacCollisionError) {
        results.push({
          index:                 i,
          status:                409,
          error:                 err.message,
          conflictingRegistryId: err.conflictingRegistryId,
        });
      } else {
        logger.error(
          {
            err:   (err as Error).message,
            stack: (err as Error).stack,
            index: i,
            hubId,
          },
          "hub-observe: unexpected error processing batch item",
        );
        results.push({ index: i, status: 500, error: "Internal server error" });
      }
      errorCount++;
    }
  }

  logger.info(
    { hubId, count: observations.length, successCount, errorCount },
    "hub-observe: batch observation processed",
  );

  return res.status(200).json({
    results,
    count:        observations.length,
    successCount,
    errorCount,
  });
});

export { router as hubObserveRouter };
