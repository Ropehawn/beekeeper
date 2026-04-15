import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@beekeeper/db", () => ({
  db: {
    varroaCount: {
      findMany: vi.fn(),
      create:   vi.fn(),
    },
  },
}));

// Default mock: authenticated as a worker (non-spectator).
// Uses vi.fn() so individual tests can override via mockImplementationOnce.
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

import { varroaCountsRouter } from "./varroa-counts";
import { db } from "@beekeeper/db";
import * as authModule from "../middleware/auth";

// ── Test app ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/", varroaCountsRouter);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HIVE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_ID = "user-uuid-aaaaaaaa-0000-0000-0000-000000000001";

/** A raw DB row — all nullable fields present */
function dbRow(overrides: object = {}) {
  return {
    id:          "cccccccc-0000-0000-0000-000000000001",
    hiveId:      HIVE_ID,
    countedBy:   USER_ID,
    countedAt:   new Date("2026-04-01T10:00:00Z"),
    method:      "alcohol_wash",
    miteCount:   6,
    beeSample:   300,
    daysOnBoard: null,
    notes:       null,
    createdAt:   new Date("2026-04-01T10:01:00Z"),
    counter:     { name: "Test Worker" },
    ...overrides,
  };
}

// ── GET / ─────────────────────────────────────────────────────────────────────

describe("GET /varroa-counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when hiveId query param is missing", async () => {
    const res = await request(app).get("/");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hiveId/i);
    expect(db.varroaCount.findMany).not.toHaveBeenCalled();
  });

  it("returns 200 with computed mitesPer100 and yellow status for alcohol_wash at 2%", async () => {
    // 6 mites / 300 bees × 100 = 2.0 → yellow (2 ≤ 2% ≤ 3%)
    vi.mocked(db.varroaCount.findMany).mockResolvedValue([dbRow()] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const item = res.body[0];
    expect(item.mitesPer100).toBe(2.0);
    expect(item.mitesPerDay).toBeNull();
    expect(item.status).toBe("yellow");
  });

  it("returns green status for alcohol_wash below warn threshold (< 2%)", async () => {
    // 3 mites / 300 bees × 100 = 1.0 → green
    vi.mocked(db.varroaCount.findMany).mockResolvedValue([
      dbRow({ miteCount: 3, beeSample: 300 }),
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].mitesPer100).toBe(1.0);
    expect(res.body[0].status).toBe("green");
  });

  it("returns red status for alcohol_wash above treat threshold (> 3%)", async () => {
    // 13 mites / 300 bees × 100 = 4.3 → red
    vi.mocked(db.varroaCount.findMany).mockResolvedValue([
      dbRow({ miteCount: 13, beeSample: 300 }),
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].mitesPer100).toBeCloseTo(4.3, 1);
    expect(res.body[0].status).toBe("red");
  });

  it("returns null derived fields when beeSample is null for alcohol_wash", async () => {
    vi.mocked(db.varroaCount.findMany).mockResolvedValue([
      dbRow({ beeSample: null }),
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    const item = res.body[0];
    expect(item.mitesPer100).toBeNull();
    expect(item.mitesPerDay).toBeNull();
    expect(item.status).toBeNull();
  });

  it("returns mitesPerDay and status for sticky_board", async () => {
    // 20 mites / 3 days = 6.7/day → green (< 8)
    vi.mocked(db.varroaCount.findMany).mockResolvedValue([
      dbRow({ method: "sticky_board", miteCount: 20, beeSample: null, daysOnBoard: 3 }),
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    const item = res.body[0];
    expect(item.mitesPer100).toBeNull();
    expect(item.mitesPerDay).toBeCloseTo(6.7, 1);
    expect(item.status).toBe("green");
  });

  it("returns yellow status for sticky_board in warn range (8–12/day)", async () => {
    // 30 mites / 3 days = 10/day → yellow (8 ≤ 10 ≤ 12)
    vi.mocked(db.varroaCount.findMany).mockResolvedValue([
      dbRow({ method: "sticky_board", miteCount: 30, beeSample: null, daysOnBoard: 3 }),
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body[0].mitesPerDay).toBeCloseTo(10.0, 1);
    expect(res.body[0].status).toBe("yellow");
  });

  it("queries with correct hiveId, orderBy countedAt desc, and respects limit cap at 50", async () => {
    vi.mocked(db.varroaCount.findMany).mockResolvedValue([]);

    // Request limit=999 — should be capped to 50
    await request(app).get(`/?hiveId=${HIVE_ID}&limit=999`);

    expect(db.varroaCount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where:   { hiveId: HIVE_ID },
        orderBy: { countedAt: "desc" },
        take:    50,
      })
    );
  });
});

// ── POST / ───────────────────────────────────────────────────────────────────

describe("POST /varroa-counts", () => {
  const validAlcoholWash = {
    hiveId:    HIVE_ID,
    countedAt: "2026-04-01T10:00:00.000Z",
    method:    "alcohol_wash",
    miteCount: 6,
    beeSample: 300,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 201 with computed fields on valid alcohol_wash input", async () => {
    vi.mocked(db.varroaCount.create).mockResolvedValue(
      dbRow({ miteCount: 6, beeSample: 300 }) as any
    );

    const res = await request(app).post("/").send(validAlcoholWash);

    expect(res.status).toBe(201);
    expect(res.body.mitesPer100).toBe(2.0);
    expect(res.body.mitesPerDay).toBeNull();
    expect(res.body.status).toBe("yellow");
    expect(db.varroaCount.create).toHaveBeenCalledOnce();
  });

  it("connects hive and counter relations on create", async () => {
    vi.mocked(db.varroaCount.create).mockResolvedValue(dbRow() as any);

    await request(app).post("/").send(validAlcoholWash);

    const createData = vi.mocked(db.varroaCount.create).mock.calls[0][0].data;
    expect(createData.hive).toEqual({ connect: { id: HIVE_ID } });
    expect(createData.counter).toEqual({ connect: { id: USER_ID } });
  });

  it("returns 400 when miteCount is negative", async () => {
    const res = await request(app)
      .post("/")
      .send({ ...validAlcoholWash, miteCount: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid input");
    expect(db.varroaCount.create).not.toHaveBeenCalled();
  });

  it("returns 400 when beeSample is missing for alcohol_wash", async () => {
    const { beeSample: _, ...body } = validAlcoholWash;

    const res = await request(app).post("/").send(body);

    expect(res.status).toBe(400);
    expect(res.body.details.fieldErrors.beeSample).toBeDefined();
    expect(db.varroaCount.create).not.toHaveBeenCalled();
  });

  it("returns 400 when daysOnBoard is missing for sticky_board", async () => {
    const res = await request(app).post("/").send({
      hiveId:    HIVE_ID,
      countedAt: "2026-04-01T10:00:00.000Z",
      method:    "sticky_board",
      miteCount: 20,
      // daysOnBoard intentionally omitted
    });

    expect(res.status).toBe(400);
    expect(res.body.details.fieldErrors.daysOnBoard).toBeDefined();
    expect(db.varroaCount.create).not.toHaveBeenCalled();
  });

  it("returns 400 when hiveId is not a valid UUID", async () => {
    const res = await request(app)
      .post("/")
      .send({ ...validAlcoholWash, hiveId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(db.varroaCount.create).not.toHaveBeenCalled();
  });

  it("returns 403 when authenticated user is a spectator", async () => {
    // Override requireAuth for this single test to inject a spectator user.
    // The module-level mock always sets role:"worker"; mockImplementationOnce
    // lets us substitute a spectator for just this call.
    vi.mocked(authModule.requireAuth).mockImplementationOnce(((req: any, _res: any, next: any) => {
      req.user = { id: USER_ID, role: "spectator", name: "Spectator" };
      next();
    }) as any);

    const res = await request(app).post("/").send(validAlcoholWash);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/insufficient permissions/i);
    expect(db.varroaCount.create).not.toHaveBeenCalled();
  });

  it("returns 201 with correct sticky_board computed fields", async () => {
    // 30 mites / 3 days = 10/day → yellow
    vi.mocked(db.varroaCount.create).mockResolvedValue(
      dbRow({ method: "sticky_board", miteCount: 30, beeSample: null, daysOnBoard: 3 }) as any
    );

    const res = await request(app).post("/").send({
      hiveId:      HIVE_ID,
      countedAt:   "2026-04-01T10:00:00.000Z",
      method:      "sticky_board",
      miteCount:   30,
      daysOnBoard: 3,
    });

    expect(res.status).toBe(201);
    expect(res.body.mitesPer100).toBeNull();
    expect(res.body.mitesPerDay).toBeCloseTo(10.0, 1);
    expect(res.body.status).toBe("yellow");
  });
});
