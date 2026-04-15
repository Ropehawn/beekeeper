import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { isR2Configured, getPresignedUploadUrl } from "../storage/r2";

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/jpg", "image/webp"] as const;
type AllowedMimeType = typeof ALLOWED_MIME_TYPES[number];

// Schema for the R2 upload-url route
const uploadUrlSchema = z.object({
  side: z.enum(["front", "back"]),
  mimeType: z.enum(["image/jpeg", "image/png", "image/jpg", "image/webp"]),
  /**
   * Declared file size in bytes. Validated client-side; stored in FramePhoto
   * as fileSizeBytes until confirm-upload overwrites it with the real R2 value.
   * Must be > 0 and <= 10 MB.
   */
  fileSizeBytes: z
    .number()
    .int()
    .min(1, "fileSizeBytes must be at least 1")
    .max(10 * 1024 * 1024, "fileSizeBytes must not exceed 10 MB (10485760)"),
  inspectionId: z.string().uuid().optional(),
  /**
   * Client-generated session key for grouping pre-save inspection media.
   * After saveInspection() returns, POST /frame-observations/link-inspection
   * links all rows with this sessionId to the real Inspection row.
   */
  inspectionSessionId: z.string().max(255).optional(),
});

// ── POST /api/v1/frames/:frameId/photos/upload-url ────────────────────────────
// R2 upload flow — Step 1: create a FramePhoto record and return a presigned PUT URL.
//
// The FramePhoto created here is PENDING until confirm-upload sets uploadConfirmedAt.
// Do not call analyze-by-photoId (POST /api/v1/frame-photos/:photoId/analyze) until
// confirm-upload has been called and returned successfully.
//
// Storage key format: frames/{frameId}/{side}-{photoId}.{ext}
//
// Returns: { photoId, presignedUrl, storageKey, expiresAt }

router.post("/:frameId/photos/upload-url", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  if (!isR2Configured()) {
    return res.status(503).json({
      error: "R2 storage not available",
      detail: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME must be configured",
    });
  }

  const body = uploadUrlSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const frame = await db.frame.findUnique({ where: { id: req.params.frameId as string } });
  if (!frame) return res.status(404).json({ error: "Frame not found" });

  const { side, mimeType, fileSizeBytes, inspectionId, inspectionSessionId } = body.data;

  const photoId = crypto.randomUUID();
  const ext = (mimeType as AllowedMimeType) === "image/png" ? "png" : "jpg";
  const storageKey = `frames/${frame.id}/${side}-${photoId}.${ext}`;

  // Create FramePhoto in PENDING state (uploadConfirmedAt = null).
  // Pending records are created before the presigned URL is returned to the client.
  // If the client never uploads, this row remains pending indefinitely.
  // A future cleanup job can delete pending rows older than, e.g., 24 hours.
  await db.framePhoto.create({
    data: {
      id: photoId,
      frameId: frame.id,
      inspectionId: inspectionId || null,
      inspectionSessionId: inspectionSessionId || null,
      side,
      storageKey,
      mimeType,
      fileSizeBytes,          // declared by client; overwritten by confirm-upload with real R2 value
      uploadConfirmedAt: null, // PENDING — set by confirm-upload after successful HeadObject
      capturedAt: new Date(),
      uploadedBy: req.user!.id,
    },
  });

  const { url: presignedUrl, expiresAt } = await getPresignedUploadUrl(storageKey, mimeType);

  res.status(201).json({ photoId, presignedUrl, storageKey, expiresAt });
});

export { router as framePhotosRouter };
