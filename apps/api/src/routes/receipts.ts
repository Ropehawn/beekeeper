import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, requireRole, AuthRequest } from "../middleware/auth";
import { isR2Configured, getPresignedUploadUrl, getPresignedDownloadUrl, fetchFileBuffer } from "../storage/r2";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { logger } from "../lib/logger";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const execFileAsync = promisify(execFile);

const router = Router();

// ── Receipt extraction prompt ────────────────────────────────────────────────

const RECEIPT_EXTRACTION_PROMPT = `You are extracting structured data from a receipt or invoice image.
Return ONLY valid JSON matching this exact schema — no prose, no markdown:
{
  "vendor": string,
  "date": "YYYY-MM-DD",
  "order_ref": string | null,
  "total": number,
  "subtotal": number | null,
  "tax": number | null,
  "type": "expense" | "income",
  "category": "Equipment" | "Bees" | "Supplies" | "Treatment" | "Honey Sales" | "Other",
  "description": string,
  "confidence": number (0-100),
  "line_items": [{ "qty": number|null, "sku": string|null, "description": string, "unit_price": number|null, "amount": number }]
}
If a field cannot be determined, use null.`;

// ── POST /api/v1/receipts/upload-url ─────────────────────────────────────────
// Returns a presigned R2 PUT URL for direct browser upload.

router.post("/upload-url", requireAuth, requireRole("queen"), async (req: AuthRequest, res) => {
  if (!isR2Configured()) {
    return res.status(503).json({ error: "R2 storage not configured" });
  }

  const body = z.object({
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
    fileSizeBytes: z.number().int().min(1).max(20 * 1024 * 1024), // 20MB max for receipts
  }).safeParse(req.body);

  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const { mimeType, fileSizeBytes } = body.data;
  const receiptId = crypto.randomUUID();
  const ext = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
  const now = new Date();
  const storageKey = `receipts/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${receiptId}.${ext}`;

  // Create receipt record in pending state
  await db.receipt.create({
    data: {
      id: receiptId,
      storageKey,
      mimeType,
      fileSizeBytes,
      uploadedBy: req.user!.id,
    },
  });

  const { url: presignedUrl, expiresAt } = await getPresignedUploadUrl(storageKey, mimeType);

  res.status(201).json({ receiptId, presignedUrl, storageKey, expiresAt });
});

// ── POST /api/v1/receipts/scan ───────────────────────────────────────────────
// Fetches the uploaded receipt from R2, sends to Claude Vision, returns extracted data.

router.post("/scan", requireAuth, requireRole("queen"), async (req: AuthRequest, res) => {
  const body = z.object({
    receiptId: z.string().uuid(),
  }).safeParse(req.body);

  if (!body.success) {
    return res.status(400).json({ error: "receiptId is required" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const receipt = await db.receipt.findUnique({ where: { id: body.data.receiptId } });
  if (!receipt) return res.status(404).json({ error: "Receipt not found" });

  // Fetch file from R2
  let imageBuffer: Buffer;
  try {
    imageBuffer = await fetchFileBuffer(receipt.storageKey);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "R2 fetch error for receipt");
    return res.status(502).json({ error: "Could not retrieve receipt from storage" });
  }

  // Resize if too large for Claude Vision (5MB base64 limit ≈ 3.5MB raw)
  let mimeType = receipt.mimeType || "image/jpeg";
  const MAX_RAW_BYTES = 3.5 * 1024 * 1024;
  if (imageBuffer.length > MAX_RAW_BYTES && mimeType !== "application/pdf") {
    try {
      imageBuffer = await sharp(imageBuffer)
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      mimeType = "image/jpeg";
    } catch {
      return res.status(422).json({ error: "Image could not be processed for AI analysis" });
    }
  }

  // For PDFs, convert first page to JPEG using pdftoppm (poppler-utils)
  if (mimeType === "application/pdf") {
    const tmpDir = os.tmpdir();
    const pdfPath = path.join(tmpDir, `receipt-${receipt.id}.pdf`);
    const outPrefix = path.join(tmpDir, `receipt-${receipt.id}`);
    try {
      fs.writeFileSync(pdfPath, imageBuffer);
      // Convert first page to JPEG at 300 DPI
      await execFileAsync("pdftoppm", [
        "-jpeg", "-r", "300", "-f", "1", "-l", "1", "-singlefile",
        pdfPath, outPrefix,
      ], { timeout: 30_000 });

      const jpegPath = outPrefix + ".jpg";
      if (!fs.existsSync(jpegPath)) {
        throw new Error("pdftoppm produced no output");
      }
      imageBuffer = fs.readFileSync(jpegPath);
      mimeType = "image/jpeg";

      // Resize if still too large after conversion
      if (imageBuffer.length > MAX_RAW_BYTES) {
        imageBuffer = await sharp(imageBuffer)
          .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      }

      // Clean up temp files
      try { fs.unlinkSync(pdfPath); } catch {}
      try { fs.unlinkSync(jpegPath); } catch {}
    } catch (pdfErr) {
      logger.error({ err: pdfErr instanceof Error ? pdfErr.message : String(pdfErr) }, "PDF conversion failed");
      try { fs.unlinkSync(pdfPath); } catch {}
      return res.status(422).json({ error: "PDF could not be converted — try uploading a photo instead" });
    }
  }

  const modelVersion = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  const imageBase64 = imageBuffer.toString("base64");

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: modelVersion,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType as "image/jpeg" | "image/png" | "image/webp", data: imageBase64 } },
          { type: "text", text: RECEIPT_EXTRACTION_PROMPT },
        ],
      }],
    });

    const rawText = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(422).json({ error: "AI could not parse receipt — try a clearer photo" });
    }

    const aiResult = JSON.parse(jsonMatch[0]);

    // Update receipt with AI results
    await db.receipt.update({
      where: { id: receipt.id },
      data: {
        aiAnalysisJson: aiResult,
        aiAnalyzedAt: new Date(),
        aiModelVersion: modelVersion,
        aiConfidence: typeof aiResult.confidence === "number" ? aiResult.confidence : null,
      },
    });

    res.json({ receiptId: receipt.id, storageKey: receipt.storageKey, aiResult });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Claude Vision receipt scan failed");
    return res.status(503).json({ error: "AI analysis failed — try again" });
  }
});

// ── GET /api/v1/receipts/:id/download ────────────────────────────────────────
// Returns a presigned download URL for viewing the receipt.

router.get("/:id/download", requireAuth, requireRole("queen"), async (req, res) => {
  const receipt = await db.receipt.findUnique({ where: { id: req.params.id as string } });
  if (!receipt) return res.status(404).json({ error: "Receipt not found" });

  if (!isR2Configured()) {
    return res.status(503).json({ error: "R2 storage not configured" });
  }

  const { url: downloadUrl, expiresAt } = await getPresignedDownloadUrl(receipt.storageKey, 3600);
  res.json({ downloadUrl, mimeType: receipt.mimeType, expiresAt });
});

export { router as receiptsRouter };
