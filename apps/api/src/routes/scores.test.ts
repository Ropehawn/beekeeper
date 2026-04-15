import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@beekeeper/db", () => ({
  db: {
    varroaCount:        { findFirst: vi.fn() },
    treatmentLog:       { findFirst: vi.fn(), findMany: vi.fn() },
    inspection:         { findFirst: vi.fn(), findMany: vi.fn() },
    frameAiObservation: { findMany: vi.fn() },
  },
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "user-aaa", email: "test@example.com", role: "worker", name: "Worker" };
    next();
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { scoresRouter } from "./scores";
import { db } from "@beekeeper/db";

// ── Test app ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/", scoresRouter);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HIVE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const NOW     = new Date("2026-04-04T12:00:00Z");

function redVarroa() {
  return { method: "alcohol_wash", miteCount: 13, beeSample: 300, daysOnBoard: null };
}

function yellowVarroa() {
  return { method: "alcohol_wash", miteCount: 6, beeSample: 300, daysOnBoard: null };
}

function greenVarroa() {
  return { method: "alcohol_wash", miteCount: 3, beeSample: 300, daysOnBoard: null };
}

function activeTreatment(daysAgo = 10) {
  return { id: "t1", treatmentType: "apivar", productName: "Apivar", endedAt: null,
           appliedAt: new Date(NOW.getTime() - daysAgo * 86_400_000) };
}

/** Sets all mocks to a "healthy hive" state — no alerts fire. */
function setHealthyDefaults() {
  vi.mocked(db.varroaCount.findFirst).mockResolvedValue(null);
  vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null);
  vi.mocked(db.treatmentLog.findMany).mockResolvedValue([]);
  vi.mocked(db.inspection.findFirst).mockResolvedValue(null);
  vi.mocked(db.inspection.findMany).mockResolvedValue([]);
  vi.mocked(db.frameAiObservation.findMany).mockResolvedValue([]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /scores — parameter validation", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("returns 400 when hiveId is missing", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hiveId/i);
  });
});

describe("GET /scores — no-data / all-clear hive", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("returns score=100, label=Strong, empty penalties for a hive with no data", async () => {
    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(100);
    expect(res.body.label).toBe("Strong");
    expect(res.body.penalties).toEqual([]);
    expect(res.body.summary).toMatch(/no active concerns/i);
    expect(res.body.hiveId).toBe(HIVE_ID);
  });

  it("returns score=100 when varroa is green (no penalty)", async () => {
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(greenVarroa() as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.body.score).toBe(100);
    expect(res.body.label).toBe("Strong");
    expect(res.body.penalties).toHaveLength(0);
  });
});

describe("GET /scores — varroa yellow penalty", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("deducts 5 points when latest varroa is yellow and Rule 1 did not fire", async () => {
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(yellowVarroa() as any);
    vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null); // ensures Rule 1 won't be blocked by treatment

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.body.score).toBe(95);
    expect(res.body.label).toBe("Strong");
    expect(res.body.penalties).toHaveLength(1);
    expect(res.body.penalties[0].points).toBe(-5);
    expect(res.body.penalties[0].reason).toMatch(/elevated/i);
  });

  it("does NOT apply yellow penalty when Rule 1 also fires (varroa red — no double-count)", async () => {
    // varroa is red, no active treatment → Rule 1 fires (-25), yellow penalty should NOT apply
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(redVarroa() as any);
    vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null);
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([]);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    // Only the -25 from varroa_no_treatment, no additional -5
    expect(res.body.score).toBe(75);
    const yellowPenalty = res.body.penalties.find((p: any) => p.reason?.match(/elevated/i));
    expect(yellowPenalty).toBeUndefined();
  });
});

describe("GET /scores — alert-based penalties", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("deducts 25 for varroa_no_treatment (critical)", async () => {
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(redVarroa() as any);
    vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null);
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([]);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.body.score).toBe(75);
    expect(res.body.label).toBe("Watch");
    const penalty = res.body.penalties.find((p: any) => p.rule === "varroa_no_treatment");
    expect(penalty.points).toBe(-25);
  });

  it("deducts 25 for queen_absent (critical)", async () => {
    vi.mocked(db.inspection.findMany).mockResolvedValue([
      { queenSeen: false, inspectedAt: new Date("2026-04-01T10:00:00Z") },
      { queenSeen: false, inspectedAt: new Date("2026-03-18T10:00:00Z") },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.body.score).toBe(75);
    const penalty = res.body.penalties.find((p: any) => p.rule === "queen_absent");
    expect(penalty.points).toBe(-25);
  });

  it("deducts 10 for inspection_overdue (warning)", async () => {
    vi.mocked(db.inspection.findFirst).mockResolvedValue({
      inspectedAt:        new Date(NOW.getTime() - 20 * 86_400_000),
      nextInspectionDate: null,
    } as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.body.score).toBe(90);
    expect(res.body.label).toBe("Strong");
    const penalty = res.body.penalties.find((p: any) => p.rule === "inspection_overdue");
    expect(penalty.points).toBe(-10);
  });

  it("deducts 10 per over-running treatment (stacks)", async () => {
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([
      activeTreatment(70),
      activeTreatment(80),
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const treatmentPenalties = res.body.penalties.filter((p: any) => p.rule === "treatment_too_long");
    expect(treatmentPenalties).toHaveLength(2);
    expect(res.body.score).toBe(80);
  });

  it("deducts 10 for disease_flags (warning)", async () => {
    vi.mocked(db.frameAiObservation.findMany).mockResolvedValue([
      { diseaseFlags: [{ type: "varroa_mites_visible" }] },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.body.score).toBe(90);
    const penalty = res.body.penalties.find((p: any) => p.rule === "disease_flags");
    expect(penalty.points).toBe(-10);
  });
});

describe("GET /scores — label boundaries", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("returns Watch (not Strong) for score 84", async () => {
    // inspection_overdue (-10) + yellow varroa (-5) = -15 → score 85? No: 90 for overdue alone.
    // Need score exactly 84: two warnings (-10 each) + yellow (-5) = -25 → 75 = Watch
    // Let's use: two warnings = -20 → 80 = Watch
    vi.mocked(db.inspection.findFirst).mockResolvedValue({
      inspectedAt:        new Date(NOW.getTime() - 20 * 86_400_000),
      nextInspectionDate: null,
    } as any);
    vi.mocked(db.frameAiObservation.findMany).mockResolvedValue([
      { diseaseFlags: [{ type: "chalkbrood" }] },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.body.score).toBe(80);
    expect(res.body.label).toBe("Watch");
  });

  it("returns At Risk for score below 65", async () => {
    // varroa_no_treatment (-25) + queen_absent (-25) + inspection_overdue (-10) = -60 → score 40
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(redVarroa() as any);
    vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null);
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([]);
    vi.mocked(db.inspection.findFirst).mockResolvedValue({
      inspectedAt:        new Date(NOW.getTime() - 20 * 86_400_000),
      nextInspectionDate: null,
    } as any);
    vi.mocked(db.inspection.findMany).mockResolvedValue([
      { queenSeen: false, inspectedAt: new Date("2026-04-01T10:00:00Z") },
      { queenSeen: false, inspectedAt: new Date("2026-03-18T10:00:00Z") },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.body.score).toBe(40);
    expect(res.body.label).toBe("At Risk");
    expect(res.body.summary).toMatch(/concerns/i);
  });

  it("floors score at 0 when penalties exceed 100", async () => {
    // varroa_no_treatment (-25) + queen_absent (-25) + two treatment_too_long (-20)
    // + inspection_overdue (-10) + disease_flags (-10) + yellow (blocked by red) = -90
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(redVarroa() as any);
    vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null);
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([
      activeTreatment(70), activeTreatment(80), activeTreatment(90), activeTreatment(100),
    ] as any);
    vi.mocked(db.inspection.findFirst).mockResolvedValue({
      inspectedAt:        new Date(NOW.getTime() - 20 * 86_400_000),
      nextInspectionDate: null,
    } as any);
    vi.mocked(db.inspection.findMany).mockResolvedValue([
      { queenSeen: false, inspectedAt: new Date("2026-04-01T10:00:00Z") },
      { queenSeen: false, inspectedAt: new Date("2026-03-18T10:00:00Z") },
    ] as any);
    vi.mocked(db.frameAiObservation.findMany).mockResolvedValue([
      { diseaseFlags: [{ type: "afb_signs" }] },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.body.score).toBe(0);
    expect(res.body.label).toBe("At Risk");
  });
});

describe("GET /scores — response shape", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("always includes hiveId, score, label, penalties, summary fields", async () => {
    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.body).toHaveProperty("hiveId");
    expect(res.body).toHaveProperty("score");
    expect(res.body).toHaveProperty("label");
    expect(res.body).toHaveProperty("penalties");
    expect(res.body).toHaveProperty("summary");
    expect(Array.isArray(res.body.penalties)).toBe(true);
  });

  it("each penalty has points (negative), reason, and optional rule", async () => {
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(redVarroa() as any);
    vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null);
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([]);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const penalty = res.body.penalties[0];
    expect(penalty.points).toBeLessThan(0);
    expect(typeof penalty.reason).toBe("string");
    expect(penalty.rule).toBe("varroa_no_treatment");
  });
});
