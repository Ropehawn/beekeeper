import { Router } from "express";
import { db, Prisma } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";

const router = Router();

// ── Domain event helper ───────────────────────────────────────────────────────

/**
 * Emits a domain event fire-and-forget.
 * Never throws — failures are logged explicitly but do not affect the caller.
 */
function emitDomainEvent(
  eventType: string,
  aggregateId: string,
  aggregateType: string,
  actorId: string,
  payload: Record<string, unknown>
): void {
  db.domainEvent
    .create({
      data: {
        id: crypto.randomUUID(),
        eventType,
        aggregateId,
        aggregateType,
        actorId,
        payload: payload as Prisma.InputJsonValue,
      },
    })
    .catch((err: unknown) => {
      logger.error(
        { eventType, err: err instanceof Error ? err.message : String(err) },
        "Failed to emit domain event"
      );
    });
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const frameObsSchema = z.object({
  frameId: z.string().uuid(),
  inspectionId: z.string().uuid().optional(),
  /**
   * Client-generated session key for grouping pre-save inspection media.
   * Recommended pattern: "{userId}-{hiveId}-{YYYY-MM-DD}"
   * After saveInspection() returns, POST /frame-observations/link-inspection
   * links all rows with this sessionId to the real Inspection row.
   */
  inspectionSessionId: z.string().max(255).optional(),
  frontHoney: z.number().int().min(0).max(100).optional(),
  frontBrood: z.number().int().min(0).max(100).optional(),
  frontOpen: z.number().int().min(0).max(100).optional(),
  frontPollen: z.number().int().min(0).max(100).optional(),
  backHoney: z.number().int().min(0).max(100).optional(),
  backBrood: z.number().int().min(0).max(100).optional(),
  backOpen: z.number().int().min(0).max(100).optional(),
  backPollen: z.number().int().min(0).max(100).optional(),
  queenSpotted: z.boolean().default(false),
  notes: z.string().optional(),
  /** UUIDs of FramePhoto rows that informed this observation (one per side, max 2). */
  sourcePhotoIds: z.array(z.string().uuid()).optional(),
  /** UUIDs of FrameAiObservation rows — parallel array to sourcePhotoIds. */
  sourceAiObservationIds: z.array(z.string().uuid()).optional(),
});

const linkInspectionSchema = z.object({
  /**
   * UUID of the real Inspection row. Must already exist in the database.
   * Only call this endpoint after saveInspection() has returned successfully.
   */
  inspectionId: z.string().uuid(),
  /**
   * The inspection_session_id value that was stamped on frame_photos and
   * frame_observations during the pre-save session.
   */
  sessionId: z.string().min(1).max(255),
});

// ── GET /api/v1/frame-observations?frameId=xxx&limit=N ────────────────────────
// Returns observations for a frame, newest first.

router.get("/", requireAuth, async (req, res) => {
  const frameId = req.query.frameId as string | undefined;
  if (!frameId) {
    return res.status(400).json({ error: "frameId query parameter is required" });
  }

  const limit = Math.min(parseInt((req.query.limit as string) || "10"), 50);

  const observations = await db.frameObservation.findMany({
    where: { frameId },
    orderBy: { observedAt: "desc" },
    take: limit,
    include: {
      observer: { select: { name: true } },
      inspection: { select: { id: true, inspectedAt: true } },
      sources: {
        include: {
          photo: {
            select: {
              id: true,
              side: true,
              uploadConfirmedAt: true,
              mimeType: true,
            },
          },
          aiObservation: {
            select: {
              id: true,
              side: true,
              confidence: true,
              honey: true,
              brood: true,
              openComb: true,
              pollen: true,
              imageQualityScore: true,
              diseaseFlags: true,
            },
          },
        },
      },
    },
  });

  // Flatten photos from sources for convenience
  const result = observations.map(obs => {
    const seenPhotoIds = new Set<string>();
    const photos: { photoId: string; side: string }[] = [];
    for (const src of obs.sources) {
      if (src.photo?.uploadConfirmedAt != null && !seenPhotoIds.has(src.photo.id)) {
        seenPhotoIds.add(src.photo.id);
        photos.push({ photoId: src.photo.id, side: src.photo.side });
      }
    }
    return { ...obs, photos };
  });

  res.json(result);
});

// ── POST /api/v1/frame-observations ──────────────────────────────────────────
// Creates a human-approved canonical observation for a frame.
// Called after the user reviews and applies AI analysis results (or enters manually).
//
// Provenance:
//   If sourcePhotoIds is provided, frame_observation_sources rows are created to link
//   this observation to the FramePhotos (and optionally FrameAiObservations) that
//   informed it. Best-effort — a provenance failure does NOT roll back the observation.
//
// Domain event emitted:
//   "frame.observation_recorded" — after observation is persisted.

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const body = frameObsSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const {
    frameId,
    inspectionId,
    inspectionSessionId,
    sourcePhotoIds,
    sourceAiObservationIds,
    ...rest
  } = body.data;

  const frame = await db.frame.findUnique({ where: { id: frameId } });
  if (!frame) return res.status(404).json({ error: "Frame not found" });

  const observation = await db.frameObservation.create({
    data: {
      id: crypto.randomUUID(),
      frameId,
      inspectionId: inspectionId || null,
      inspectionSessionId: inspectionSessionId || null,
      observedBy: req.user!.id,
      observedAt: new Date(),
      ...rest,
    },
  });

  // ── Provenance (best-effort) ──────────────────────────────────────────────
  // Create frame_observation_sources rows to link this observation to the
  // photos / AI observations that informed it. Non-fatal: if this block fails
  // (e.g. invalid photoId FK), the observation response is still returned.
  const provenanceCount = sourcePhotoIds?.length ?? 0;
  if (sourcePhotoIds && provenanceCount > 0) {
    const sourceCreates = sourcePhotoIds.map((photoId, i) =>
      db.frameObservationSource.create({
        data: {
          id: crypto.randomUUID(),
          observationId: observation.id,
          photoId,
          aiObservationId: sourceAiObservationIds?.[i] ?? null,
        },
      })
    );
    await Promise.all(sourceCreates).catch((err) => {
      logger.error(
        { observationId: observation.id, err: err instanceof Error ? err.message : String(err) },
        "Failed to store provenance links"
      );
    });
  }

  // ── Domain event (fire-and-forget) ────────────────────────────────────────
  emitDomainEvent(
    "frame.observation_recorded",
    frameId,
    "Frame",
    req.user!.id,
    {
      observationId: observation.id,
      frameId,
      inspectionId: inspectionId || null,
      inspectionSessionId: inspectionSessionId || null,
      hasProvenance: provenanceCount > 0,
      provenanceCount,
    }
  );

  // ── Architecture note ─────────────────────────────────────────────────────
  // FrameObservation is the canonical source for per-frame composition data
  // (honey, brood, open comb, pollen percentages). As of Phase 3, the inspection
  // frontend pre-populates sliders from the latest FrameObservation row via
  // prefillSlidersFromObservations() — Frame snapshot columns (front_honey,
  // back_honey, etc.) are no longer written and should be treated as legacy-only.
  //
  // The Frame snapshot columns remain in the database schema (additive-only policy)
  // but are no longer written by application code. Do not read them for display.
  // If lastInspectedAt is ever needed for display, derive it from:
  //   SELECT MAX(observed_at) FROM frame_observations WHERE frame_id = :id
  // ─────────────────────────────────────────────────────────────────────────────

  res.status(201).json(observation);
});

// ── POST /api/v1/frame-observations/link-inspection ──────────────────────────
// Links all pre-save frame observations and photos for a session to a real Inspection.
//
// Contract:
//   Must only be called after saveInspection() has returned a persisted Inspection UUID.
//   The inspectionId must exist in the database — enforced by the FK on frame_observations.
//
// Effect:
//   Sets inspection_id = :inspectionId on all frame_observations and frame_photos rows
//   where inspection_session_id = :sessionId AND inspection_id IS NULL.
//   Rows where inspection_id is already set are left untouched (idempotent for re-calls).
//
// Returns:
//   { inspectionId, sessionId, observationsLinked: N, photosLinked: N }
//   If sessionId matches no rows, both counts are 0 — not an error.
//
// Domain event emitted:
//   "frame.inspection_linked"

router.post("/link-inspection", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const body = linkInspectionSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const { inspectionId, sessionId } = body.data;

  // Verify the inspection exists before attempting FK writes.
  // updateMany would succeed with count=0 if no rows match, but would throw a
  // FK violation if rows do match and inspectionId is invalid.
  const inspection = await db.inspection.findUnique({
    where: { id: inspectionId },
    select: { id: true },
  });
  if (!inspection) {
    return res.status(404).json({ error: "Inspection not found" });
  }

  const [obsResult, photoResult] = await Promise.all([
    db.frameObservation.updateMany({
      where: { inspectionSessionId: sessionId, inspectionId: null },
      data: { inspectionId },
    }),
    db.framePhoto.updateMany({
      where: { inspectionSessionId: sessionId, inspectionId: null },
      data: { inspectionId },
    }),
  ]);

  // ── Domain event (fire-and-forget) ────────────────────────────────────────
  emitDomainEvent(
    "frame.inspection_linked",
    inspectionId,
    "Inspection",
    req.user!.id,
    {
      inspectionId,
      sessionId,
      observationsLinked: obsResult.count,
      photosLinked: photoResult.count,
    }
  );

  res.json({
    inspectionId,
    sessionId,
    observationsLinked: obsResult.count,
    photosLinked: photoResult.count,
  });
});

export { router as frameObservationsRouter };
