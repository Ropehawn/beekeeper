import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@beekeeper/db", () => ({
  db: {
    framePhoto: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    frameAiObservation: {
      create: vi.fn(),
      count: vi.fn(),
    },
    domainEvent: { create: vi.fn() },
  },
  // JsonNull is the Prisma sentinel for "store null in a JSON column".
  // Using actual null here keeps toBeNull() assertions simple.
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

// Anthropic mock with vi.hoisted so mockCreate is available in the factory
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

vi.mock("../storage/r2", () => ({
  isR2Configured: vi.fn(),
  getPresignedUploadUrl: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
  headObject: vi.fn(),
  fetchFileBuffer: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { framePhotoActionsRouter } from "./frame-photo-actions";
import { db } from "@beekeeper/db";
import * as r2 from "../storage/r2";

// ── Test app ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/", framePhotoActionsRouter);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FRAME_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const PHOTO_ID  = "bbbbbbbb-0000-0000-0000-000000000001";

// A confirmed FramePhoto (uploadConfirmedAt is set)
const CONFIRMED_PHOTO = {
  id: PHOTO_ID,
  frameId: FRAME_ID,
  storageKey: `frames/${FRAME_ID}/front-${PHOTO_ID}.jpg`,
  side: "front",
  mimeType: "image/jpeg",
  fileSizeBytes: 102400,
  uploadConfirmedAt: new Date("2026-04-01T10:00:00Z"),
  inspectionSessionId: null,
  frame: { id: FRAME_ID, componentId: "comp-uuid-1", position: 1 },
};

// A pending FramePhoto (uploadConfirmedAt is null)
const PENDING_PHOTO = {
  ...CONFIRMED_PHOTO,
  uploadConfirmedAt: null,
};

/**
 * Build a mock Anthropic message envelope.
 */
function mockClaudeResponse(json: object) {
  return {
    id: "msg_test123",
    type: "message",
    model: "claude-opus-4-5",
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(json) }],
    usage: { input_tokens: 100, output_tokens: 50 },
    stop_reason: "end_turn",
  };
}

/** A complete valid analysis payload Claude would return. */
function fullAnalysis(overrides: object = {}) {
  return {
    honey: 20,
    brood: 60,
    open_comb: 15,
    pollen: 5,
    frame_visible_pct: 95,
    image_quality_score: 88,
    image_quality_issues: [],
    confidence: 87,
    disease_flags: [],
    notes: "",
    ...overrides,
  };
}

// ── POST /:photoId/confirm-upload ─────────────────────────────────────────────

describe("POST /frame-photos/:photoId/confirm-upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.domainEvent.create).mockResolvedValue({} as any);
  });

  it("returns 404 when photo does not exist", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(null);

    const res = await request(app).post(`/${PHOTO_ID}/confirm-upload`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
    expect(db.framePhoto.update).not.toHaveBeenCalled();
  });

  it("returns 502 when R2 HeadObject throws", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(PENDING_PHOTO as any);
    vi.mocked(r2.headObject).mockRejectedValue(new Error("Network error"));

    const res = await request(app).post(`/${PHOTO_ID}/confirm-upload`);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/verify upload/i);
    expect(db.framePhoto.update).not.toHaveBeenCalled();
  });

  it("returns 422 when file is not found in R2 after all retries", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(PENDING_PHOTO as any);
    vi.mocked(r2.headObject).mockResolvedValue({ exists: false, contentLength: null });

    const res = await request(app).post(`/${PHOTO_ID}/confirm-upload`);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not found in storage/i);
    // Retry logic: headObject is called HEAD_RETRIES (3) times before giving up
    expect(r2.headObject).toHaveBeenCalledTimes(3);
    expect(db.framePhoto.update).not.toHaveBeenCalled();
  });

  it("succeeds on second attempt when R2 object appears after initial miss (PUT→HEAD race)", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(PENDING_PHOTO as any);
    vi.mocked(r2.headObject)
      .mockResolvedValueOnce({ exists: false, contentLength: null }) // attempt 1: miss
      .mockResolvedValueOnce({ exists: true,  contentLength: 98765 }); // attempt 2: hit
    vi.mocked(db.framePhoto.update).mockResolvedValue({
      ...PENDING_PHOTO,
      uploadConfirmedAt: new Date("2026-04-01T10:01:00Z"),
      fileSizeBytes: 98765,
    } as any);

    const res = await request(app).post(`/${PHOTO_ID}/confirm-upload`);

    expect(res.status).toBe(200);
    expect(r2.headObject).toHaveBeenCalledTimes(2);
    expect(res.body.photoId).toBe(PHOTO_ID);
    expect(res.body.alreadyConfirmed).toBeUndefined();
  });

  it("sets uploadConfirmedAt and updates fileSizeBytes from R2", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(PENDING_PHOTO as any);
    vi.mocked(r2.headObject).mockResolvedValue({ exists: true, contentLength: 98765 });
    vi.mocked(db.framePhoto.update).mockResolvedValue({
      ...PENDING_PHOTO,
      uploadConfirmedAt: new Date("2026-04-01T10:01:00Z"),
      fileSizeBytes: 98765,
    } as any);

    const res = await request(app).post(`/${PHOTO_ID}/confirm-upload`);

    expect(res.status).toBe(200);
    const updateData = vi.mocked(db.framePhoto.update).mock.calls[0][0].data;
    expect(updateData.uploadConfirmedAt).toBeInstanceOf(Date);
    expect(updateData.fileSizeBytes).toBe(98765);
    expect(res.body.photoId).toBe(PHOTO_ID);
    expect(res.body.uploadConfirmedAt).toBeDefined();
  });

  it("is idempotent — returns existing state without re-checking R2 if already confirmed", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(CONFIRMED_PHOTO as any);

    const res = await request(app).post(`/${PHOTO_ID}/confirm-upload`);

    expect(res.status).toBe(200);
    expect(res.body.alreadyConfirmed).toBe(true);
    expect(r2.headObject).not.toHaveBeenCalled();
    expect(db.framePhoto.update).not.toHaveBeenCalled();
  });

  it("falls back to client-declared fileSizeBytes when R2 contentLength is null", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(PENDING_PHOTO as any);
    vi.mocked(r2.headObject).mockResolvedValue({ exists: true, contentLength: null });
    vi.mocked(db.framePhoto.update).mockResolvedValue({
      ...PENDING_PHOTO,
      uploadConfirmedAt: new Date(),
    } as any);

    const res = await request(app).post(`/${PHOTO_ID}/confirm-upload`);

    expect(res.status).toBe(200);
    const updateData = vi.mocked(db.framePhoto.update).mock.calls[0][0].data;
    // fileSizeBytes should NOT be in the update data (falls back to DB value)
    expect(updateData.fileSizeBytes).toBeUndefined();
  });
});

// ── POST /:photoId/analyze ────────────────────────────────────────────────────

describe("POST /frame-photos/:photoId/analyze", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-api-key";
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(CONFIRMED_PHOTO as any);
    vi.mocked(db.frameAiObservation.count).mockResolvedValue(0);
    vi.mocked(db.frameAiObservation.create).mockResolvedValue({ id: "ai-obs-uuid-1" } as any);
    vi.mocked(db.domainEvent.create).mockResolvedValue({} as any);
    vi.mocked(r2.fetchFileBuffer).mockResolvedValue(Buffer.from("fake-image-bytes"));
  });

  afterEach(() => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
  });

  it("returns 503 when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const res = await request(app).post(`/${PHOTO_ID}/analyze`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not available/i);
    expect(db.frameAiObservation.create).not.toHaveBeenCalled();
  });

  it("returns 404 when photo does not exist", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(null);

    const res = await request(app).post(`/${PHOTO_ID}/analyze`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
    expect(db.frameAiObservation.create).not.toHaveBeenCalled();
  });

  it("returns 422 when uploadConfirmedAt is null (upload not confirmed)", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(PENDING_PHOTO as any);

    const res = await request(app).post(`/${PHOTO_ID}/analyze`);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not confirmed/i);
    expect(r2.fetchFileBuffer).not.toHaveBeenCalled();
    expect(db.frameAiObservation.create).not.toHaveBeenCalled();
  });

  it("returns 502 when R2 fetch fails", async () => {
    vi.mocked(r2.fetchFileBuffer).mockRejectedValue(new Error("R2 unavailable"));

    const res = await request(app).post(`/${PHOTO_ID}/analyze`);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/retrieve photo/i);
    expect(db.frameAiObservation.create).not.toHaveBeenCalled();
  });

  it("returns 503 when Claude Vision throws, does not create FrameAiObservation", async () => {
    mockCreate.mockRejectedValue(new Error("API timeout"));

    const res = await request(app).post(`/${PHOTO_ID}/analyze`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/AI analysis failed/i);
    // No partial/zero row should be written to the DB on a hard Claude failure
    expect(db.frameAiObservation.create).not.toHaveBeenCalled();
  });

  it("returns the same response shape as the base64 analyze route", async () => {
    mockCreate.mockResolvedValue(mockClaudeResponse(fullAnalysis()));

    const res = await request(app).post(`/${PHOTO_ID}/analyze`);

    expect(res.status).toBe(200);
    // All fields present in base64 route response
    expect(res.body).toMatchObject({
      photoId: PHOTO_ID,
      side: "front",
      honey: 20,
      brood: 60,
      open_comb: 15,
      pollen: 5,
      frame_visible_pct: 95,
      image_quality_score: 88,
      image_quality_issues: [],
      confidence: 87,
      disease_flags: [],
      notes: "",
    });
    // Plus R2-only field
    expect(res.body.previousAnalysisCount).toBeDefined();
  });

  it("includes previousAnalysisCount in response", async () => {
    vi.mocked(db.frameAiObservation.count).mockResolvedValue(2); // 2 prior analyses
    mockCreate.mockResolvedValue(mockClaudeResponse(fullAnalysis()));

    const res = await request(app).post(`/${PHOTO_ID}/analyze`);

    expect(res.status).toBe(200);
    expect(res.body.previousAnalysisCount).toBe(2);
  });

  it("emits frame.photo_analyzed domain event with analyzeSource = 'r2'", async () => {
    mockCreate.mockResolvedValue(mockClaudeResponse(fullAnalysis({ confidence: 87 })));

    await request(app).post(`/${PHOTO_ID}/analyze`);

    expect(db.domainEvent.create).toHaveBeenCalledOnce();
    const eventData = vi.mocked(db.domainEvent.create).mock.calls[0][0].data;
    expect(eventData.eventType).toBe("frame.photo_analyzed");
    expect(eventData.aggregateId).toBe(FRAME_ID);
    expect(eventData.aggregateType).toBe("Frame");
    expect((eventData.payload as any).photoId).toBe(PHOTO_ID);
    expect((eventData.payload as any).analyzeSource).toBe("r2");
    expect((eventData.payload as any).confidence).toBe(87);
    expect((eventData.payload as any).side).toBe("front");
  });

  it("continues and returns 200 when domain event insertion fails", async () => {
    mockCreate.mockResolvedValue(mockClaudeResponse(fullAnalysis()));
    vi.mocked(db.domainEvent.create).mockRejectedValue(new Error("DB write failed"));

    const res = await request(app).post(`/${PHOTO_ID}/analyze`);

    expect(res.status).toBe(200);
    expect(res.body.confidence).toBe(87);
  });

  it("uses stored mimeType from FramePhoto when calling Claude Vision", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue({
      ...CONFIRMED_PHOTO,
      mimeType: "image/png",
    } as any);
    mockCreate.mockResolvedValue(mockClaudeResponse(fullAnalysis()));

    await request(app).post(`/${PHOTO_ID}/analyze`);

    // Claude was called — verify the SDK mock was invoked (mimeType flows through callClaudeVision)
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.messages[0].content[0].source.media_type).toBe("image/png");
  });
});

// ── Sequential flow: confirm-upload then analyze ──────────────────────────────
// Regression guard: the R2 flow requires confirm-upload before analyze.
// This test verifies the state transitions flow correctly end-to-end.

describe("R2 sequential flow: confirm-upload → analyze", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-api-key";
    vi.mocked(db.domainEvent.create).mockResolvedValue({} as any);
  });

  afterEach(() => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
  });

  it("confirm then analyze succeeds and produces a FrameAiObservation", async () => {
    // Step 1: confirm-upload on a PENDING photo
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(PENDING_PHOTO as any);
    vi.mocked(r2.headObject).mockResolvedValue({ exists: true, contentLength: 98765 });
    vi.mocked(db.framePhoto.update).mockResolvedValue({
      ...PENDING_PHOTO,
      uploadConfirmedAt: new Date("2026-04-01T10:01:00Z"),
      fileSizeBytes: 98765,
    } as any);

    const confirmRes = await request(app).post(`/${PHOTO_ID}/confirm-upload`);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.uploadConfirmedAt).toBeDefined();

    // Step 2: analyze — now photo is confirmed
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(CONFIRMED_PHOTO as any);
    vi.mocked(db.frameAiObservation.count).mockResolvedValue(0);
    vi.mocked(db.frameAiObservation.create).mockResolvedValue({ id: "ai-obs-uuid-seq" } as any);
    vi.mocked(r2.fetchFileBuffer).mockResolvedValue(Buffer.from("fake-image-bytes"));
    mockCreate.mockResolvedValue(mockClaudeResponse(fullAnalysis({ confidence: 91 })));

    const analyzeRes = await request(app).post(`/${PHOTO_ID}/analyze`);
    expect(analyzeRes.status).toBe(200);
    expect(analyzeRes.body.confidence).toBe(91);
    expect(analyzeRes.body.previousAnalysisCount).toBe(0);
    expect(db.frameAiObservation.create).toHaveBeenCalledOnce();
  });

  it("analyze returns 422 if confirm-upload was never called", async () => {
    // Photo is still PENDING — confirm-upload not yet called
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(PENDING_PHOTO as any);

    const res = await request(app).post(`/${PHOTO_ID}/analyze`);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not confirmed/i);
    expect(r2.fetchFileBuffer).not.toHaveBeenCalled();
    expect(db.frameAiObservation.create).not.toHaveBeenCalled();
  });
});

// ── GET /:photoId/view-url ────────────────────────────────────────────────────

describe("GET /frame-photos/:photoId/view-url", () => {
  const MOCK_VIEW_URL = "https://r2.example.com/frames/front.jpg?X-Amz-Signature=abc123";
  const MOCK_EXPIRES_AT = new Date("2026-04-03T15:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(r2.isR2Configured).mockReturnValue(true);
    vi.mocked(r2.getPresignedDownloadUrl).mockResolvedValue({
      url: MOCK_VIEW_URL,
      expiresAt: MOCK_EXPIRES_AT,
    });
  });

  it("returns 200 with url, expiresAt, side, and mimeType for a confirmed photo", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(CONFIRMED_PHOTO as any);

    const res = await request(app).get(`/${PHOTO_ID}/view-url`);

    expect(res.status).toBe(200);
    expect(res.body.photoId).toBe(PHOTO_ID);
    expect(res.body.url).toBe(MOCK_VIEW_URL);
    expect(res.body.expiresAt).toBe(MOCK_EXPIRES_AT.toISOString());
    expect(res.body.side).toBe("front");
    expect(res.body.mimeType).toBe("image/jpeg");
    // Verify getPresignedDownloadUrl called with correct key and 1-hour expiry
    expect(r2.getPresignedDownloadUrl).toHaveBeenCalledWith(CONFIRMED_PHOTO.storageKey, 3600);
  });

  it("returns 404 when photo does not exist", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(null);

    const res = await request(app).get(`/${PHOTO_ID}/view-url`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(r2.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns 422 when uploadConfirmedAt is null (upload not confirmed)", async () => {
    vi.mocked(db.framePhoto.findUnique).mockResolvedValue(PENDING_PHOTO as any);

    const res = await request(app).get(`/${PHOTO_ID}/view-url`);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not confirmed/i);
    expect(r2.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns 503 when R2 is not configured", async () => {
    vi.mocked(r2.isR2Configured).mockReturnValue(false);

    const res = await request(app).get(`/${PHOTO_ID}/view-url`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not available/i);
    expect(db.framePhoto.findUnique).not.toHaveBeenCalled();
  });
});
