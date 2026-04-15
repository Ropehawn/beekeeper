import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@beekeeper/db", () => ({
  db: {
    treatmentLog: {
      findMany:   vi.fn(),
      findUnique: vi.fn(),
      create:     vi.fn(),
      update:     vi.fn(),
    },
  },
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: vi.fn((req: any, _res: any, next: any) => {
    req.user = {
      id:    "user-uuid-aaaaaaaa-0000-0000-0000-000000000001",
      email: "worker@example.com",
      role:  "worker",
      name:  "Test Worker",
    };
    next();
  }),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { treatmentLogsRouter } from "./treatment-logs";
import { db } from "@beekeeper/db";
import * as authModule from "../middleware/auth";

// ── Test app ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/", treatmentLogsRouter);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HIVE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_ID = "user-uuid-aaaaaaaa-0000-0000-0000-000000000001";
const LOG_ID  = "dddddddd-0000-0000-0000-000000000001";

const APPLIED_AT = new Date("2026-04-01T10:00:00Z");
const ENDED_AT   = new Date("2026-04-22T10:00:00Z"); // 21 days later

function dbLog(overrides: object = {}) {
  return {
    id:            LOG_ID,
    hiveId:        HIVE_ID,
    loggedBy:      USER_ID,
    appliedAt:     APPLIED_AT,
    endedAt:       null,
    treatmentType: "apivar",
    productName:   "Apivar strips",
    dosage:        "2 strips",
    notes:         null,
    createdAt:     new Date("2026-04-01T10:01:00Z"),
    logger:        { name: "Test Worker" },
    ...overrides,
  };
}

const validApivar = {
  hiveId:        HIVE_ID,
  appliedAt:     "2026-04-01T10:00:00.000Z",
  treatmentType: "apivar",
  productName:   "Apivar strips",
  dosage:        "2 strips",
};

// ── GET / ─────────────────────────────────────────────────────────────────────

describe("GET /treatment-logs", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 400 when hiveId is missing", async () => {
    const res = await request(app).get("/");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hiveId/i);
    expect(db.treatmentLog.findMany).not.toHaveBeenCalled();
  });

  it("returns 200 with isActive:true and daysActive for an active treatment", async () => {
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([dbLog()] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const item = res.body[0];
    expect(item.isActive).toBe(true);
    expect(typeof item.daysActive).toBe("number");
    expect(item.daysActive).toBeGreaterThanOrEqual(0);
  });

  it("returns isActive:false and correct daysActive for a completed treatment", async () => {
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([
      dbLog({ endedAt: ENDED_AT }),
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].isActive).toBe(false);
    // 21 days between APPLIED_AT and ENDED_AT
    expect(res.body[0].daysActive).toBe(21);
  });

  it("returns empty array when no treatments exist", async () => {
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([]);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("queries with correct hiveId, orderBy appliedAt desc, and respects limit cap at 50", async () => {
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([]);

    await request(app).get(`/?hiveId=${HIVE_ID}&limit=999`);

    expect(db.treatmentLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where:   { hiveId: HIVE_ID },
        orderBy: { appliedAt: "desc" },
        take:    50,
      })
    );
  });
});

// ── POST / ───────────────────────────────────────────────────────────────────

describe("POST /treatment-logs", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 201 with isActive:true and daysActive on valid input", async () => {
    vi.mocked(db.treatmentLog.create).mockResolvedValue(dbLog() as any);

    const res = await request(app).post("/").send(validApivar);

    expect(res.status).toBe(201);
    expect(res.body.treatmentType).toBe("apivar");
    expect(res.body.isActive).toBe(true);
    expect(typeof res.body.daysActive).toBe("number");
    expect(db.treatmentLog.create).toHaveBeenCalledOnce();
  });

  it("connects hive and logger relations on create", async () => {
    vi.mocked(db.treatmentLog.create).mockResolvedValue(dbLog() as any);

    await request(app).post("/").send(validApivar);

    const data = vi.mocked(db.treatmentLog.create).mock.calls[0][0].data;
    expect(data.hive).toEqual({ connect: { id: HIVE_ID } });
    expect(data.logger).toEqual({ connect: { id: USER_ID } });
  });

  it("returns 201 with isActive:false when endedAt is provided at creation", async () => {
    vi.mocked(db.treatmentLog.create).mockResolvedValue(
      dbLog({ endedAt: ENDED_AT }) as any
    );

    const res = await request(app).post("/").send({
      ...validApivar,
      endedAt: ENDED_AT.toISOString(),
    });

    expect(res.status).toBe(201);
    expect(res.body.isActive).toBe(false);
    expect(res.body.daysActive).toBe(21);
  });

  it("returns 400 when treatmentType is not a recognized enum value", async () => {
    const res = await request(app)
      .post("/")
      .send({ ...validApivar, treatmentType: "unknown_treatment" });

    expect(res.status).toBe(400);
    expect(db.treatmentLog.create).not.toHaveBeenCalled();
  });

  it("returns 400 when endedAt is before appliedAt", async () => {
    const res = await request(app).post("/").send({
      ...validApivar,
      endedAt: "2026-03-31T10:00:00.000Z", // day before appliedAt
    });

    expect(res.status).toBe(400);
    expect(res.body.details.fieldErrors.endedAt).toBeDefined();
    expect(db.treatmentLog.create).not.toHaveBeenCalled();
  });

  it("returns 400 when hiveId is not a valid UUID", async () => {
    const res = await request(app)
      .post("/")
      .send({ ...validApivar, hiveId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(db.treatmentLog.create).not.toHaveBeenCalled();
  });

  it("returns 403 when authenticated user is a spectator", async () => {
    vi.mocked(authModule.requireAuth).mockImplementationOnce(((req: any, _res: any, next: any) => {
      req.user = { id: USER_ID, role: "spectator", name: "Spectator" };
      next();
    }) as any);

    const res = await request(app).post("/").send(validApivar);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/insufficient permissions/i);
    expect(db.treatmentLog.create).not.toHaveBeenCalled();
  });

  it("allows optional fields to be omitted", async () => {
    vi.mocked(db.treatmentLog.create).mockResolvedValue(
      dbLog({ productName: null, dosage: null, notes: null }) as any
    );

    const minimalPayload = {
      hiveId:        HIVE_ID,
      appliedAt:     "2026-04-01T10:00:00.000Z",
      treatmentType: "oxalic_acid_vaporize",
    };

    const res = await request(app).post("/").send(minimalPayload);

    expect(res.status).toBe(201);
    expect(db.treatmentLog.create).toHaveBeenCalledOnce();
  });
});

// ── PATCH /:id ───────────────────────────────────────────────────────────────

describe("PATCH /treatment-logs/:id", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 200 with updated endedAt and isActive:false after ending treatment", async () => {
    vi.mocked(db.treatmentLog.findUnique).mockResolvedValue(dbLog() as any);
    vi.mocked(db.treatmentLog.update).mockResolvedValue(
      dbLog({ endedAt: ENDED_AT }) as any
    );

    const res = await request(app)
      .patch(`/${LOG_ID}`)
      .send({ endedAt: ENDED_AT.toISOString() });

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(res.body.daysActive).toBe(21);
    expect(db.treatmentLog.update).toHaveBeenCalledOnce();
  });

  it("returns 200 when updating notes only (no endedAt change)", async () => {
    vi.mocked(db.treatmentLog.findUnique).mockResolvedValue(dbLog() as any);
    vi.mocked(db.treatmentLog.update).mockResolvedValue(
      dbLog({ notes: "Re-checked, looking good" }) as any
    );

    const res = await request(app)
      .patch(`/${LOG_ID}`)
      .send({ notes: "Re-checked, looking good" });

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(true);
    expect(db.treatmentLog.update).toHaveBeenCalledOnce();
  });

  it("returns 200 when updating dosage only", async () => {
    vi.mocked(db.treatmentLog.findUnique).mockResolvedValue(dbLog() as any);
    vi.mocked(db.treatmentLog.update).mockResolvedValue(
      dbLog({ dosage: "1 strip (corrected)" }) as any
    );

    const res = await request(app)
      .patch(`/${LOG_ID}`)
      .send({ dosage: "1 strip (corrected)" });

    expect(res.status).toBe(200);
    expect(db.treatmentLog.update).toHaveBeenCalledOnce();
  });

  it("returns 404 when treatment log does not exist", async () => {
    vi.mocked(db.treatmentLog.findUnique).mockResolvedValue(null);

    const res = await request(app)
      .patch(`/${LOG_ID}`)
      .send({ endedAt: ENDED_AT.toISOString() });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(db.treatmentLog.update).not.toHaveBeenCalled();
  });

  it("returns 400 when endedAt is before the stored appliedAt", async () => {
    vi.mocked(db.treatmentLog.findUnique).mockResolvedValue(dbLog() as any);

    const res = await request(app)
      .patch(`/${LOG_ID}`)
      .send({ endedAt: "2026-03-15T10:00:00.000Z" }); // before APPLIED_AT (Apr 1)

    expect(res.status).toBe(400);
    expect(res.body.details.fieldErrors.endedAt).toBeDefined();
    expect(db.treatmentLog.update).not.toHaveBeenCalled();
  });

  it("returns 400 when no fields are provided", async () => {
    const res = await request(app).patch(`/${LOG_ID}`).send({});

    expect(res.status).toBe(400);
    expect(db.treatmentLog.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 when authenticated user is a spectator", async () => {
    vi.mocked(authModule.requireAuth).mockImplementationOnce(((req: any, _res: any, next: any) => {
      req.user = { id: USER_ID, role: "spectator", name: "Spectator" };
      next();
    }) as any);

    const res = await request(app)
      .patch(`/${LOG_ID}`)
      .send({ endedAt: ENDED_AT.toISOString() });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/insufficient permissions/i);
    expect(db.treatmentLog.update).not.toHaveBeenCalled();
  });

  it("only updates patchable fields — does not pass treatmentType or appliedAt to update()", async () => {
    vi.mocked(db.treatmentLog.findUnique).mockResolvedValue(dbLog() as any);
    vi.mocked(db.treatmentLog.update).mockResolvedValue(
      dbLog({ endedAt: ENDED_AT }) as any
    );

    await request(app)
      .patch(`/${LOG_ID}`)
      .send({ endedAt: ENDED_AT.toISOString(), notes: "Done" });

    const updateData = vi.mocked(db.treatmentLog.update).mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("treatmentType");
    expect(updateData).not.toHaveProperty("appliedAt");
    expect(updateData).not.toHaveProperty("hiveId");
    expect(updateData.endedAt).toBeInstanceOf(Date);
    expect(updateData.notes).toBe("Done");
  });
});
