import { Router } from "express";
import { db, Prisma } from "@beekeeper/db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { isR2Configured, getPresignedDownloadUrl, headObject, fetchFileBuffer } from "../storage/r2";
import {
  callClaudeVision,
  ZERO_ANALYSIS,
} from "./_frame-analysis-helpers";
import { logger } from "../lib/logger";
import sharp from "sharp";

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

// ── GET /api/v1/frame-photos/:photoId/view-url ────────────────────────────────
// Returns a short-lived presigned GET URL so the browser can fetch the photo
// directly from R2 without proxying through the API.
//
// Only confirmed uploads (uploadConfirmedAt IS NOT NULL) are eligible.
// Open to all authenticated roles including spectators (read-only access).
//
// Returns: { photoId, url, expiresAt, side, mimeType }

router.get("/:photoId/view-url", requireAuth, async (req, res) => {
  if (!isR2Configured()) {
    return res.status(503).json({ error: "R2 storage not available" });
  }

  const photo = await db.framePhoto.findUnique({
    where: { id: req.params.photoId as string },
  });
  if (!photo) return res.status(404).json({ error: "Photo not found" });

  if (!photo.uploadConfirmedAt) {
    return res.status(422).json({
      error: "Photo upload not confirmed",
      detail: "Call confirm-upload before requesting a view URL. " +
              "The FramePhoto record exists but the file has not been verified in R2 storage.",
    });
  }

  const { url, expiresAt } = await getPresignedDownloadUrl(photo.storageKey, 3600);

  res.json({
    photoId:   photo.id,
    url,
    expiresAt,
    side:      photo.side,
    mimeType:  photo.mimeType,
  });
});

// ── POST /api/v1/frame-photos/:photoId/confirm-upload ─────────────────────────
// R2 upload flow — Step 3: verify the file exists in R2 and mark the FramePhoto confirmed.
//
// Must only be called after the client has successfully PUT the file to R2 using the
// presigned URL returned by POST /api/v1/frames/:frameId/photos/upload-url.
//
// Effect:
//   - HEAD request to R2 verifies the object exists
//   - Sets uploadConfirmedAt = now() on the FramePhoto row
//   - Updates fileSizeBytes with the real value reported by R2
//
// Returns: { photoId, storageKey, uploadConfirmedAt, fileSizeBytes }

router.post("/:photoId/confirm-upload", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const photo = await db.framePhoto.findUnique({
    where: { id: req.params.photoId as string },
  });
  if (!photo) return res.status(404).json({ error: "Photo not found" });

  // Idempotent: if already confirmed, return the existing state without re-checking R2.
  // This allows safe re-calls (e.g. if the client retried after a network error).
  if (photo.uploadConfirmedAt) {
    return res.json({
      photoId: photo.id,
      storageKey: photo.storageKey,
      uploadConfirmedAt: photo.uploadConfirmedAt,
      fileSizeBytes: photo.fileSizeBytes,
      alreadyConfirmed: true,
    });
  }

  // Verify the file exists in R2 before marking as confirmed.
  // Retries up to HEAD_RETRIES times with HEAD_RETRY_DELAY_MS between attempts to handle
  // the R2 PUT → HEAD eventual-consistency race (object may not be immediately visible).
  const HEAD_RETRIES = 3;
  const HEAD_RETRY_DELAY_MS = 500;

  let headResult: { exists: boolean; contentLength: number | null } = { exists: false, contentLength: null };
  for (let attempt = 1; attempt <= HEAD_RETRIES; attempt++) {
    try {
      headResult = await headObject(photo.storageKey);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "R2 HeadObject error");
      return res.status(502).json({
        error: "Could not verify upload in storage",
        detail: "R2 storage check failed — try again",
      });
    }
    if (headResult.exists) break;
    if (attempt < HEAD_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, HEAD_RETRY_DELAY_MS));
    }
  }

  if (!headResult.exists) {
    return res.status(422).json({
      error: "Upload not found in storage",
      detail: `The file was not found at the expected R2 key after ${HEAD_RETRIES} attempts. Ensure the PUT completed successfully before calling confirm-upload.`,
      storageKey: photo.storageKey,
    });
  }

  const uploadConfirmedAt = new Date();
  const updatedPhoto = await db.framePhoto.update({
    where: { id: photo.id },
    data: {
      uploadConfirmedAt,
      // Use the real R2-reported size if available; fall back to the client-declared value
      ...(headResult.contentLength != null && { fileSizeBytes: headResult.contentLength }),
    },
  });

  res.json({
    photoId: updatedPhoto.id,
    storageKey: updatedPhoto.storageKey,
    uploadConfirmedAt: updatedPhoto.uploadConfirmedAt,
    fileSizeBytes: updatedPhoto.fileSizeBytes,
  });
});

// ── POST /api/v1/frame-photos/:photoId/analyze ────────────────────────────────
// R2 upload flow — Step 4: fetch the photo from R2, call Claude Vision, store results.
//
// Requires: uploadConfirmedAt must be set on the FramePhoto row (confirm-upload called first).
// Returns 422 if the photo record exists but uploadConfirmedAt is null (still pending).
//
// Re-analysis: calling this endpoint on an already-analyzed photo is allowed.
//   Each call creates a NEW FrameAiObservation row (append-only).
//   Prior rows are preserved. The response includes previousAnalysisCount.
//
// Response shape is IDENTICAL to POST /api/v1/frames/:frameId/analyze (base64 route).
// Domain event payload is IDENTICAL to the base64 analyze path (analyzeSource = "r2").

router.post("/:photoId/analyze", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "AI analysis not available",
      detail: "ANTHROPIC_API_KEY is not configured on this server",
    });
  }

  const photo = await db.framePhoto.findUnique({
    where: { id: req.params.photoId as string },
    include: { frame: true },
  });
  if (!photo) return res.status(404).json({ error: "Photo not found" });

  // Guard: refuse to analyze a pending (unconfirmed) upload.
  // uploadConfirmedAt is set by confirm-upload after a successful R2 HeadObject.
  if (!photo.uploadConfirmedAt) {
    return res.status(422).json({
      error: "Upload not confirmed",
      detail: "Call POST /api/v1/frame-photos/:photoId/confirm-upload before analyzing. " +
              "The FramePhoto record exists but the file has not been verified in R2 storage.",
    });
  }

  // Count prior analyses so the caller knows if this is a re-analysis
  const previousAnalysisCount = await db.frameAiObservation.count({
    where: { photoId: photo.id },
  });

  // ── Fetch image from R2 ───────────────────────────────────────────────────
  let imageBuffer: Buffer;
  try {
    imageBuffer = await fetchFileBuffer(photo.storageKey);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "R2 fetch error");
    return res.status(502).json({
      error: "Could not retrieve photo from storage",
      detail: "R2 fetch failed — the object may have been deleted or storage is unavailable",
    });
  }

  const modelVersion = process.env.ANTHROPIC_MODEL || "claude-opus-4-5";
  // Use stored mimeType if available; default to image/jpeg for legacy base64-path rows
  let mimeType = photo.mimeType || "image/jpeg";

  // ── Resize if too large for Claude Vision (5MB base64 limit ≈ 3.75MB raw) ──
  // Claude's base64 limit is 5MB. Base64 inflates ~33%, so keep raw under 3.5MB.
  const MAX_RAW_BYTES = 3.5 * 1024 * 1024;
  if (imageBuffer.length > MAX_RAW_BYTES) {
    logger.info(
      { originalBytes: imageBuffer.length, photoId: photo.id },
      "Image exceeds Claude Vision size limit — resizing"
    );
    try {
      imageBuffer = await sharp(imageBuffer)
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      mimeType = "image/jpeg"; // sharp outputs jpeg after conversion
    } catch (resizeErr) {
      logger.error(
        { err: resizeErr instanceof Error ? resizeErr.message : String(resizeErr) },
        "Image resize failed"
      );
      return res.status(422).json({
        error: "Image could not be processed",
        detail: "The photo failed to resize for AI analysis — try a smaller image",
      });
    }
  }

  const imageBase64 = imageBuffer.toString("base64");

  // ── Claude Vision call (shared helper) ───────────────────────────────────
  const { rawAnthropicMessage, analysisData, normalizedResult } = await callClaudeVision(
    apiKey,
    imageBase64,
    mimeType,
    modelVersion
  );

  // Guard: if Claude Vision threw or returned unparseable output, normalizedResult is null.
  // Return 503 rather than silently persisting a zero-filled FrameAiObservation row.
  // The UI catch block will show the "Analysis failed" toast at this point.
  if (normalizedResult === null) {
    return res.status(503).json({
      error: "AI analysis failed",
      detail: "Claude Vision could not analyze this image — please try again",
    });
  }

  // ── Persist FrameAiObservation ────────────────────────────────────────────
  const aiObsId = crypto.randomUUID();
  await db.frameAiObservation.create({
    data: {
      id: aiObsId,
      frameId: photo.frameId,
      photoId: photo.id,
      modelVersion,
      confidence: analysisData.confidence,
      side: photo.side,
      honey: analysisData.honey,
      brood: analysisData.brood,
      openComb: analysisData.open_comb,
      pollen: analysisData.pollen,
      frameVisiblePct: analysisData.frame_visible_pct || null,
      imageQualityScore: analysisData.image_quality_score || null,
      imageQualityIssues:
        analysisData.image_quality_issues.length > 0
          ? (analysisData.image_quality_issues as unknown as Prisma.InputJsonValue)
          : undefined,
      diseaseFlags:
        analysisData.disease_flags.length > 0
          ? (analysisData.disease_flags as unknown as Prisma.InputJsonValue)
          : undefined,
      rawResponse: rawAnthropicMessage !== null
        ? (rawAnthropicMessage as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      normalizedResponse: normalizedResult !== null
        ? (normalizedResult as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
  });

  // ── Domain event (fire-and-forget) ────────────────────────────────────────
  // Identical payload shape to POST /api/v1/frames/:frameId/analyze (base64 route).
  // analyzeSource = "r2" distinguishes this path in event consumers / dashboards.
  emitDomainEvent(
    "frame.photo_analyzed",
    photo.frameId,
    "Frame",
    req.user!.id,
    {
      photoId: photo.id,
      aiObservationId: aiObsId,
      frameId: photo.frameId,
      side: photo.side,
      confidence: analysisData.confidence,
      modelVersion,
      imageQualityScore: analysisData.image_quality_score || null,
      frameVisiblePct: analysisData.frame_visible_pct || null,
      inspectionSessionId: photo.inspectionSessionId || null,
      analyzeSource: "r2",
    }
  );

  res.json({
    photoId: photo.id,
    side: photo.side,
    honey: analysisData.honey,
    brood: analysisData.brood,
    open_comb: analysisData.open_comb,
    pollen: analysisData.pollen,
    frame_visible_pct: analysisData.frame_visible_pct,
    image_quality_score: analysisData.image_quality_score,
    image_quality_issues: analysisData.image_quality_issues,
    confidence: analysisData.confidence,
    disease_flags: analysisData.disease_flags,
    notes: analysisData.notes,
    previousAnalysisCount,
  });
});

export { router as framePhotoActionsRouter };
