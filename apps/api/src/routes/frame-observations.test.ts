import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// ── Mocks ────────────────────────────────────────────────────────────────────
//
// frame-observations.ts now imports Prisma from @beekeeper/db for type casts,
// so Prisma: {} is required in the mock to prevent import errors.
//
// domainEvent.create is called fire-and-forget; it must return a Promise so
// the .catch() in emitDomainEvent() does not throw.

vi.mock("@beekeeper/db", () => ({
  db: {
    frameObservation: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    frameObservationSource: {
      create: vi.fn(),
    },
    framePhoto: {
      updateMany: vi.fn(),
    },
    frame: {
      findUnique: vi.fn(),
    },
    inspection: {
      findUnique: vi.fn(),
    },
    domainEvent: {
      create: vi.fn(),
    },
  },
  Prisma: {},
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

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { frameObservationsRouter } from "./frame-observations";
import { db } from "@beekeeper/db";

// ── Test app ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/", frameObservationsRouter);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FRAME_ID       = "aaaaaaaa-0000-0000-0000-000000000001";
const INSPECTION_ID  = "eeeeeeee-0000-0000-0000-000000000001";
const USER_ID        = "user-uuid-aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_ID     = `${USER_ID}-${FRAME_ID}-2026-04-01`;

const mockFrame      = { id: FRAME_ID, componentId: "comp-uuid-1", position: 1 };
const mockInspection = { id: INSPECTION_ID };

function mockObservation(overrides: Record<string, unknown> = {}) {
  return {
    id: "obs-uuid-0000-0000-0000-000000000001",
    frameId: FRAME_ID,
    inspectionId: null,
    inspectionSessionId: null,
    observedBy: USER_ID,
    observedAt: new Date("2026-04-01T12:00:00Z"),
    frontHoney: null,
    frontBrood: null,
    frontOpen: null,
    frontPollen: null,
    backHoney: null,
    backBrood: null,
    backOpen: null,
    backPollen: null,
    queenSpotted: false,
    notes: null,
    createdAt: new Date("2026-04-01T12:00:00Z"),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /frame-observations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // domainEvent.create must return a Promise for fire-and-forget .catch() to work
    vi.mocked(db.domainEvent.create).mockResolvedValue({} as any);
  });

  it("creates an observation with valid data and returns 201", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(
      mockObservation({ frontHoney: 20, frontBrood: 50, frontOpen: 20, frontPollen: 10 }) as any
    );

    const res = await request(app).post("/").send({
      frameId: FRAME_ID,
      frontHoney: 20,
      frontBrood: 50,
      frontOpen: 20,
      frontPollen: 10,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "obs-uuid-0000-0000-0000-000000000001", frontHoney: 20 });
    expect(db.frameObservation.create).toHaveBeenCalledOnce();
  });

  it("returns 400 when frameId is not a valid UUID", async () => {
    const res = await request(app).post("/").send({ frameId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    expect(db.frameObservation.create).not.toHaveBeenCalled();
  });

  it("returns 404 when frame does not exist", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(null);

    const res = await request(app).post("/").send({ frameId: FRAME_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
    expect(db.frameObservation.create).not.toHaveBeenCalled();
  });

  // ── inspectionSessionId ────────────────────────────────────────────────────

  it("stores inspectionSessionId on FrameObservation when provided", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(mockObservation() as any);

    await request(app).post("/").send({
      frameId: FRAME_ID,
      frontHoney: 10,
      inspectionSessionId: SESSION_ID,
    });

    const createData = vi.mocked(db.frameObservation.create).mock.calls[0][0].data;
    expect(createData.inspectionSessionId).toBe(SESSION_ID);
  });

  it("stores null inspectionSessionId when not provided", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(mockObservation() as any);

    const res = await request(app).post("/").send({ frameId: FRAME_ID, frontHoney: 10 });

    expect(res.status).toBe(201);
    expect(db.frameObservation.create).toHaveBeenCalledOnce();
    const calls = vi.mocked(db.frameObservation.create).mock.calls as any[];
    const createData = calls[0][0].data;
    expect(createData.inspectionSessionId).toBeNull();
  });

  // ── Nullable side handling ─────────────────────────────────────────────────

  it("accepts only front-side data — back fields absent from create payload", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(
      mockObservation({ frontHoney: 10, frontBrood: 60, frontOpen: 20, frontPollen: 10 }) as any
    );

    const res = await request(app).post("/").send({
      frameId: FRAME_ID,
      frontHoney: 10,
      frontBrood: 60,
      frontOpen: 20,
      frontPollen: 10,
    });

    expect(res.status).toBe(201);
    const createData = vi.mocked(db.frameObservation.create).mock.calls[0][0].data;
    expect(createData.frontHoney).toBe(10);
    expect(createData.frontBrood).toBe(60);
    expect(createData).not.toHaveProperty("backHoney");
    expect(createData).not.toHaveProperty("backBrood");
    expect(createData).not.toHaveProperty("backOpen");
    expect(createData).not.toHaveProperty("backPollen");
  });

  it("accepts only back-side data — front fields absent from create payload", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(
      mockObservation({ backHoney: 5, backBrood: 70, backOpen: 15, backPollen: 10 }) as any
    );

    const res = await request(app).post("/").send({
      frameId: FRAME_ID,
      backHoney: 5,
      backBrood: 70,
      backOpen: 15,
      backPollen: 10,
    });

    expect(res.status).toBe(201);
    const createData = vi.mocked(db.frameObservation.create).mock.calls[0][0].data;
    expect(createData.backHoney).toBe(5);
    expect(createData).not.toHaveProperty("frontHoney");
    expect(createData).not.toHaveProperty("frontBrood");
  });

  // ── Provenance storage ─────────────────────────────────────────────────────

  it("stores sourcePhotoIds as provenance rows in frame_observation_sources", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(mockObservation() as any);
    vi.mocked(db.frameObservationSource.create).mockResolvedValue({} as any);

    await request(app).post("/").send({
      frameId: FRAME_ID,
      frontHoney: 10,
      sourcePhotoIds: [
        "bbbbbbbb-0000-0000-0000-000000000001",
        "bbbbbbbb-0000-0000-0000-000000000002",
      ],
    });

    expect(db.frameObservationSource.create).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(db.frameObservationSource.create).mock.calls[0][0].data;
    expect(firstCall.observationId).toBe("obs-uuid-0000-0000-0000-000000000001");
    expect(firstCall.photoId).toBe("bbbbbbbb-0000-0000-0000-000000000001");
    expect(firstCall.aiObservationId).toBeNull();
  });

  it("stores sourceAiObservationIds in provenance rows when provided", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(mockObservation() as any);
    vi.mocked(db.frameObservationSource.create).mockResolvedValue({} as any);

    await request(app).post("/").send({
      frameId: FRAME_ID,
      frontHoney: 15,
      backHoney: 5,
      sourcePhotoIds: [
        "cccccccc-0000-0000-0000-000000000001",
        "cccccccc-0000-0000-0000-000000000002",
      ],
      sourceAiObservationIds: [
        "dddddddd-0000-0000-0000-000000000001",
        "dddddddd-0000-0000-0000-000000000002",
      ],
    });

    const calls = vi.mocked(db.frameObservationSource.create).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].data.photoId).toBe("cccccccc-0000-0000-0000-000000000001");
    expect(calls[0][0].data.aiObservationId).toBe("dddddddd-0000-0000-0000-000000000001");
    expect(calls[1][0].data.photoId).toBe("cccccccc-0000-0000-0000-000000000002");
    expect(calls[1][0].data.aiObservationId).toBe("dddddddd-0000-0000-0000-000000000002");
  });

  it("does not create provenance rows when no sourcePhotoIds provided", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(mockObservation() as any);

    await request(app).post("/").send({ frameId: FRAME_ID, frontHoney: 10 });

    expect(db.frameObservationSource.create).not.toHaveBeenCalled();
  });

  it("returns 201 even when provenance create fails (best-effort)", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(mockObservation() as any);
    vi.mocked(db.frameObservationSource.create).mockRejectedValue(new Error("FK violation"));

    const res = await request(app).post("/").send({
      frameId: FRAME_ID,
      frontHoney: 10,
      sourcePhotoIds: ["bbbbbbbb-0000-0000-0000-000000000001"],
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "obs-uuid-0000-0000-0000-000000000001" });
  });

  // ── Domain event emission ─────────────────────────────────────────────────

  it("emits frame.observation_recorded domain event on POST /", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(mockObservation() as any);

    await request(app).post("/").send({
      frameId: FRAME_ID,
      frontHoney: 25,
      inspectionSessionId: SESSION_ID,
      sourcePhotoIds: ["bbbbbbbb-0000-0000-0000-000000000001"],
    });

    expect(db.domainEvent.create).toHaveBeenCalledOnce();
    const eventData = vi.mocked(db.domainEvent.create).mock.calls[0][0].data;
    expect(eventData.eventType).toBe("frame.observation_recorded");
    expect(eventData.aggregateId).toBe(FRAME_ID);
    expect(eventData.aggregateType).toBe("Frame");
    expect(eventData.actorId).toBe(USER_ID);
    expect((eventData.payload as any).observationId).toBe("obs-uuid-0000-0000-0000-000000000001");
    expect((eventData.payload as any).inspectionSessionId).toBe(SESSION_ID);
    expect((eventData.payload as any).hasProvenance).toBe(true);
    expect((eventData.payload as any).provenanceCount).toBe(1);
  });

  it("domain event reflects hasProvenance=false when no sourcePhotoIds", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(mockObservation() as any);

    await request(app).post("/").send({ frameId: FRAME_ID, frontHoney: 10 });

    const eventData = vi.mocked(db.domainEvent.create).mock.calls[0][0].data;
    expect((eventData.payload as any).hasProvenance).toBe(false);
    expect((eventData.payload as any).provenanceCount).toBe(0);
  });

  it("returns 201 when domain event insertion fails (best-effort)", async () => {
    vi.mocked(db.frame.findUnique).mockResolvedValue(mockFrame as any);
    vi.mocked(db.frameObservation.create).mockResolvedValue(mockObservation() as any);
    vi.mocked(db.domainEvent.create).mockRejectedValue(new Error("event store unavailable"));

    const res = await request(app).post("/").send({ frameId: FRAME_ID, frontHoney: 10 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "obs-uuid-0000-0000-0000-000000000001" });
  });
});

// ── GET /frame-observations ────────────────────────────────────────────────────

describe("GET /frame-observations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.domainEvent.create).mockResolvedValue({} as any);
  });

  it("returns 400 when frameId is missing", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(400);
  });

  it("returns observations for a frameId", async () => {
    const obs = [mockObservation({ frontHoney: 20 })];
    vi.mocked(db.frameObservation.findMany).mockResolvedValue(obs as any);

    const res = await request(app).get(`/?frameId=${FRAME_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].frontHoney).toBe(20);
  });

  it("caps limit at 50", async () => {
    vi.mocked(db.frameObservation.findMany).mockResolvedValue([]);

    await request(app).get(`/?frameId=${FRAME_ID}&limit=999`);
    const findCall = vi.mocked(db.frameObservation.findMany).mock.calls[0]?.[0];
    expect(findCall?.take).toBe(50);
  });
});

// ── POST /link-inspection ──────────────────────────────────────────────────────

describe("POST /link-inspection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.domainEvent.create).mockResolvedValue({} as any);
  });

  it("links observations and photos and returns counts", async () => {
    vi.mocked(db.inspection.findUnique).mockResolvedValue(mockInspection as any);
    vi.mocked(db.frameObservation.updateMany).mockResolvedValue({ count: 3 });
    vi.mocked(db.framePhoto.updateMany).mockResolvedValue({ count: 4 });

    const res = await request(app).post("/link-inspection").send({
      inspectionId: INSPECTION_ID,
      sessionId: SESSION_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      inspectionId: INSPECTION_ID,
      sessionId: SESSION_ID,
      observationsLinked: 3,
      photosLinked: 4,
    });
  });

  it("calls updateMany with correct where clause (only unlinked rows)", async () => {
    vi.mocked(db.inspection.findUnique).mockResolvedValue(mockInspection as any);
    vi.mocked(db.frameObservation.updateMany).mockResolvedValue({ count: 2 });
    vi.mocked(db.framePhoto.updateMany).mockResolvedValue({ count: 2 });

    await request(app).post("/link-inspection").send({
      inspectionId: INSPECTION_ID,
      sessionId: SESSION_ID,
    });

    const obsArgs = vi.mocked(db.frameObservation.updateMany).mock.calls[0][0];
    expect(obsArgs.where).toEqual({ inspectionSessionId: SESSION_ID, inspectionId: null });
    expect(obsArgs.data).toEqual({ inspectionId: INSPECTION_ID });

    const photoArgs = vi.mocked(db.framePhoto.updateMany).mock.calls[0][0];
    expect(photoArgs.where).toEqual({ inspectionSessionId: SESSION_ID, inspectionId: null });
    expect(photoArgs.data).toEqual({ inspectionId: INSPECTION_ID });
  });

  it("returns 0 counts when sessionId matches no rows (not an error)", async () => {
    vi.mocked(db.inspection.findUnique).mockResolvedValue(mockInspection as any);
    vi.mocked(db.frameObservation.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(db.framePhoto.updateMany).mockResolvedValue({ count: 0 });

    const res = await request(app).post("/link-inspection").send({
      inspectionId: INSPECTION_ID,
      sessionId: "session-with-no-rows",
    });

    expect(res.status).toBe(200);
    expect(res.body.observationsLinked).toBe(0);
    expect(res.body.photosLinked).toBe(0);
  });

  it("returns 404 when inspection does not exist", async () => {
    vi.mocked(db.inspection.findUnique).mockResolvedValue(null);

    const res = await request(app).post("/link-inspection").send({
      inspectionId: INSPECTION_ID,
      sessionId: SESSION_ID,
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
    expect(db.frameObservation.updateMany).not.toHaveBeenCalled();
    expect(db.framePhoto.updateMany).not.toHaveBeenCalled();
  });

  it("returns 400 when inspectionId is not a UUID", async () => {
    const res = await request(app).post("/link-inspection").send({
      inspectionId: "not-a-uuid",
      sessionId: SESSION_ID,
    });

    expect(res.status).toBe(400);
    expect(db.inspection.findUnique).not.toHaveBeenCalled();
  });

  it("returns 400 when sessionId is missing", async () => {
    const res = await request(app).post("/link-inspection").send({
      inspectionId: INSPECTION_ID,
    });

    expect(res.status).toBe(400);
  });

  it("emits frame.inspection_linked domain event", async () => {
    vi.mocked(db.inspection.findUnique).mockResolvedValue(mockInspection as any);
    vi.mocked(db.frameObservation.updateMany).mockResolvedValue({ count: 2 });
    vi.mocked(db.framePhoto.updateMany).mockResolvedValue({ count: 3 });

    await request(app).post("/link-inspection").send({
      inspectionId: INSPECTION_ID,
      sessionId: SESSION_ID,
    });

    expect(db.domainEvent.create).toHaveBeenCalledOnce();
    const eventData = vi.mocked(db.domainEvent.create).mock.calls[0][0].data;
    expect(eventData.eventType).toBe("frame.inspection_linked");
    expect(eventData.aggregateId).toBe(INSPECTION_ID);
    expect(eventData.aggregateType).toBe("Inspection");
    expect(eventData.actorId).toBe(USER_ID);
    expect((eventData.payload as any).sessionId).toBe(SESSION_ID);
    expect((eventData.payload as any).observationsLinked).toBe(2);
    expect((eventData.payload as any).photosLinked).toBe(3);
  });

  it("returns 200 even when domain event insertion fails", async () => {
    vi.mocked(db.inspection.findUnique).mockResolvedValue(mockInspection as any);
    vi.mocked(db.frameObservation.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(db.framePhoto.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(db.domainEvent.create).mockRejectedValue(new Error("event store unavailable"));

    const res = await request(app).post("/link-inspection").send({
      inspectionId: INSPECTION_ID,
      sessionId: SESSION_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body.observationsLinked).toBe(1);
    expect(res.body.photosLinked).toBe(1);
  });

  it("is idempotent — re-calling with same sessionId returns 0 for already-linked rows", async () => {
    vi.mocked(db.inspection.findUnique).mockResolvedValue(mockInspection as any);
    // Second call: no rows match (inspection_id IS NULL clause filters them out)
    vi.mocked(db.frameObservation.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(db.framePhoto.updateMany).mockResolvedValue({ count: 0 });

    const res = await request(app).post("/link-inspection").send({
      inspectionId: INSPECTION_ID,
      sessionId: SESSION_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body.observationsLinked).toBe(0);
    expect(res.body.photosLinked).toBe(0);
  });
});
