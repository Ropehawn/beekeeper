import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@beekeeper/db", () => ({
  db: {
    frame:      { findUnique: vi.fn() },
    framePhoto: { create: vi.fn() },
  },
  Prisma: { JsonNull: null },
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: "user-uuid-aaaaaaaa-0000-0000-0000-000000000001",
      email: "test@example.com",
      role: "queen",
      name: "Test Queen",
    };
    next();
  },
}));

// R2 mock — frame-photos.ts uses isR2Configured and getPresignedUploadUrl
vi.mock("../storage/r2", () => ({
  isR2Configured:       vi.fn(),
  getPresignedUploadUrl: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { framePhotosRouter } from "./frame-photos";
import { db } from "@beekeeper/db";
import * as r2 from "../storage/r2";

// ── Test app ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/", framePhotosRouter);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FRAME_ID   = "aaaaaaaa-0000-0000-0000-000000000001";
const MOCK_FRAME = { id: FRAME_ID, componentId: "comp-uuid-1", position: 1 };

// ── POST /:frameId/photos/upload-url ─────────────────────────────────────────

describe("POST /frames/:frameId/photos/upload-url", () => {
  const UPLOAD_PAYLOAD = {
    side: "front",
    mimeType: "image/jpeg",
    fileSizeBytes: 1024 * 500, // 500 KB
  };

  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.frame.findUnique).mockResolvedValue(MOCK_FRAME as any);
    vi.mocked(db.framePhoto.create).mockResolvedValue({ id: "photo-uuid-r2" } as any);
    vi.mocked(r2.isR2Configured).mockReturnValue(true);
    vi.mocked(r2.getPresignedUploadUrl).mockResolvedValue({
      url: "https://r2.example.com/presigned-url",
      expiresAt: new Date("2026-04-01T12:10:00Z"),
    });
  });

  afterEach(() => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
  });

  it("returns 503 when R2 is not configured", async () => {
    vi.mocked(r2.isR2Configured).mockReturnValue(false);

    const res = await request(app)
      .post(`/${FRAME_ID}/photos/upload-url`)
      .send(UPLOAD_PAYLOAD);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not available/i);
    expect(db.framePhoto.create).not.toHaveBeenCalled();
  });

  it("returns 404 when frame does not exist", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(null);

    const res = await request(app)
      .post(`/${FRAME_ID}/photos/upload-url`)
      .send(UPLOAD_PAYLOAD);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
    expect(db.framePhoto.create).not.toHaveBeenCalled();
  });

  it("returns 400 when fileSizeBytes exceeds 10 MB", async () => {
    const res = await request(app)
      .post(`/${FRAME_ID}/photos/upload-url`)
      .send({ ...UPLOAD_PAYLOAD, fileSizeBytes: 11 * 1024 * 1024 });

    expect(res.status).toBe(400);
    expect(db.framePhoto.create).not.toHaveBeenCalled();
  });

  it("returns 400 when mimeType is not allowed", async () => {
    const res = await request(app)
      .post(`/${FRAME_ID}/photos/upload-url`)
      .send({ ...UPLOAD_PAYLOAD, mimeType: "image/gif" });

    expect(res.status).toBe(400);
  });

  it("creates a pending FramePhoto record with uploadConfirmedAt = null", async () => {
    const res = await request(app)
      .post(`/${FRAME_ID}/photos/upload-url`)
      .send(UPLOAD_PAYLOAD);

    expect(res.status).toBe(201);
    const photoData = vi.mocked(db.framePhoto.create).mock.calls[0][0].data;
    expect(photoData.uploadConfirmedAt).toBeNull();
    expect(photoData.mimeType).toBe("image/jpeg");
    expect(photoData.frameId).toBe(FRAME_ID);
    expect(photoData.side).toBe("front");
    expect(photoData.fileSizeBytes).toBe(UPLOAD_PAYLOAD.fileSizeBytes);
  });

  it("returns photoId, presignedUrl, storageKey, and expiresAt", async () => {
    const res = await request(app)
      .post(`/${FRAME_ID}/photos/upload-url`)
      .send(UPLOAD_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body.photoId).toBeDefined();
    expect(res.body.presignedUrl).toBe("https://r2.example.com/presigned-url");
    expect(res.body.storageKey).toMatch(/^frames\//);
    expect(res.body.expiresAt).toBeDefined();
  });
});
