import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@beekeeper/db", () => ({
  db: {
    varroaCount:         { findFirst: vi.fn() },
    treatmentLog:        { findFirst: vi.fn(), findMany: vi.fn() },
    inspection:          { findFirst: vi.fn(), findMany: vi.fn() },
    frameAiObservation:  { findMany: vi.fn() },
  },
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "user-aaa", email: "test@example.com", role: "worker", name: "Worker" };
    next();
  },
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { alertsRouter } from "./alerts";
import { db } from "@beekeeper/db";

// ── Test app ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/", alertsRouter);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HIVE_ID = "aaaaaaaa-0000-0000-0000-000000000001";

// Freeze the clock so production `new Date()` calls return a deterministic value.
// All mock data is constructed relative to NOW, so the clock must also be fixed at NOW
// for computed values like `daysSinceDue` to stay stable across calendar days.
const NOW = new Date("2026-04-04T12:00:00Z");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

/** Returns a varroa count at the given level */
function varroaCount(overrides: object = {}) {
  return {
    method:     "alcohol_wash",
    miteCount:  13,   // 13/300 × 100 = 4.3% → red
    beeSample:  300,
    daysOnBoard: null,
    countedAt:  new Date("2026-04-01T10:00:00Z"),
    ...overrides,
  };
}

function activeTreatment(daysAgo = 10) {
  const appliedAt = new Date(NOW.getTime() - daysAgo * 86_400_000);
  return { id: "treat-001", treatmentType: "apivar", productName: "Apivar", appliedAt, endedAt: null };
}

function recentInspection(overrides: object = {}) {
  return {
    inspectedAt:       new Date("2026-04-01T10:00:00Z"),   // 3 days ago
    nextInspectionDate: null,
    queenSeen:         true,
    ...overrides,
  };
}

// ── Helper: set all mocks to "no alert" defaults ──────────────────────────────

function setHealthyDefaults() {
  // Rule 1: no varroa data
  vi.mocked(db.varroaCount.findFirst).mockResolvedValue(null);
  // Rule 1 + 2: no active treatments
  vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null);
  vi.mocked(db.treatmentLog.findMany).mockResolvedValue([]);
  // Rule 3 + 5: no inspections
  vi.mocked(db.inspection.findFirst).mockResolvedValue(null);
  vi.mocked(db.inspection.findMany).mockResolvedValue([]);
  // Rule 4: no AI observations
  vi.mocked(db.frameAiObservation.findMany).mockResolvedValue([]);
}

// ── GET / ─────────────────────────────────────────────────────────────────────

describe("GET /alerts — parameter validation", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("returns 400 when hiveId is missing", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hiveId/i);
  });

  it("returns 200 with empty array for a healthy hive", async () => {
    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── Rule 1: varroa_no_treatment ───────────────────────────────────────────────

describe("Rule 1 — varroa_no_treatment", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("fires critical alert when latest count is red and no active treatment", async () => {
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(varroaCount() as any);
    vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    const alert = res.body.find((a: any) => a.rule === "varroa_no_treatment");
    expect(alert).toBeDefined();
    expect(alert.severity).toBe("critical");
    expect(alert.data.mitesPer100).toBeCloseTo(4.3, 1);
    expect(alert.data.method).toBe("alcohol_wash");
  });

  it("does not fire when active treatment exists", async () => {
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(varroaCount() as any);
    vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(activeTreatment() as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "varroa_no_treatment");
    expect(alert).toBeUndefined();
  });

  it("does not fire when latest count is yellow (below red threshold)", async () => {
    // 6/300 × 100 = 2.0% → yellow
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(
      varroaCount({ miteCount: 6 }) as any
    );

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "varroa_no_treatment");
    expect(alert).toBeUndefined();
  });

  it("does not fire when no varroa counts exist", async () => {
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(null);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "varroa_no_treatment");
    expect(alert).toBeUndefined();
  });

  it("fires for sticky_board method when mitesPerDay is red (> 12)", async () => {
    // 40 mites / 3 days = 13.3/day → red
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(
      varroaCount({ method: "sticky_board", miteCount: 40, beeSample: null, daysOnBoard: 3 }) as any
    );
    vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "varroa_no_treatment");
    expect(alert).toBeDefined();
    expect(alert.data.mitesPerDay).toBeCloseTo(13.3, 1);
  });
});

// ── Rule 2: treatment_too_long ────────────────────────────────────────────────

describe("Rule 2 — treatment_too_long", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("fires warning when active treatment has been running >= 56 days", async () => {
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([activeTreatment(60)] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "treatment_too_long");
    expect(alert).toBeDefined();
    expect(alert.severity).toBe("warning");
    expect(alert.data.daysActive).toBeGreaterThanOrEqual(56);
    expect(alert.data.treatmentType).toBe("apivar");
  });

  it("does not fire when active treatment is under threshold", async () => {
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([activeTreatment(30)] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "treatment_too_long");
    expect(alert).toBeUndefined();
  });

  it("does not fire when no active treatments exist", async () => {
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([]);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "treatment_too_long");
    expect(alert).toBeUndefined();
  });

  it("emits one alert per over-running treatment when multiple are active", async () => {
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([
      activeTreatment(70),
      activeTreatment(80),
      activeTreatment(10), // under threshold — should not fire
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alerts = res.body.filter((a: any) => a.rule === "treatment_too_long");
    expect(alerts).toHaveLength(2);
  });
});

// ── Rule 3: inspection_overdue ────────────────────────────────────────────────

describe("Rule 3 — inspection_overdue", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("fires warning when nextInspectionDate is in the past", async () => {
    vi.mocked(db.inspection.findFirst).mockResolvedValue({
      inspectedAt:        new Date("2026-03-01T10:00:00Z"),
      nextInspectionDate: new Date("2026-03-15T10:00:00Z"), // 20 days before NOW
    } as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "inspection_overdue");
    expect(alert).toBeDefined();
    expect(alert.severity).toBe("warning");
    expect(alert.data.daysSinceDue).toBeGreaterThan(0);
  });

  it("fires when no nextInspectionDate and inspectedAt + 14 days is past", async () => {
    // inspectedAt 20 days ago, no nextInspectionDate → due 6 days ago
    vi.mocked(db.inspection.findFirst).mockResolvedValue({
      inspectedAt:        new Date(NOW.getTime() - 20 * 86_400_000),
      nextInspectionDate: null,
    } as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "inspection_overdue");
    expect(alert).toBeDefined();
    expect(alert.data.daysSinceDue).toBeCloseTo(6, 0);
  });

  it("does not fire when inspection is recent (within 14 days)", async () => {
    // inspectedAt 3 days ago, no nextInspectionDate → not yet due
    vi.mocked(db.inspection.findFirst).mockResolvedValue(recentInspection() as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "inspection_overdue");
    expect(alert).toBeUndefined();
  });

  it("does not fire when no inspections exist (new hive)", async () => {
    vi.mocked(db.inspection.findFirst).mockResolvedValue(null);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "inspection_overdue");
    expect(alert).toBeUndefined();
  });
});

// ── Rule 4: disease_flags ─────────────────────────────────────────────────────

describe("Rule 4 — disease_flags", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("fires warning when high-confidence AI observations have disease flags", async () => {
    vi.mocked(db.frameAiObservation.findMany).mockResolvedValue([
      { diseaseFlags: [{ type: "varroa_mites_visible" }, { type: "chalkbrood" }] },
      { diseaseFlags: [{ type: "varroa_mites_visible" }] }, // duplicate type — should dedupe
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "disease_flags");
    expect(alert).toBeDefined();
    expect(alert.severity).toBe("warning");
    // varroa_mites_visible deduplicated → 2 unique types
    expect(alert.data.flags).toHaveLength(2);
    expect(alert.data.flags).toContain("varroa_mites_visible");
    expect(alert.data.flags).toContain("chalkbrood");
    expect(alert.data.observationCount).toBe(2);
  });

  it("does not fire when AI observations have empty disease flag arrays", async () => {
    vi.mocked(db.frameAiObservation.findMany).mockResolvedValue([
      { diseaseFlags: [] },
      { diseaseFlags: [] },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "disease_flags");
    expect(alert).toBeUndefined();
  });

  it("does not fire when no AI observations exist", async () => {
    vi.mocked(db.frameAiObservation.findMany).mockResolvedValue([]);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "disease_flags");
    expect(alert).toBeUndefined();
  });

  it("does not fire when AI observations have null diseaseFlags", async () => {
    vi.mocked(db.frameAiObservation.findMany).mockResolvedValue([
      { diseaseFlags: null },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "disease_flags");
    expect(alert).toBeUndefined();
  });
});

// ── Rule 5: queen_absent ──────────────────────────────────────────────────────

describe("Rule 5 — queen_absent", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("fires critical when last 2 inspections both have queenSeen=false", async () => {
    vi.mocked(db.inspection.findMany).mockResolvedValue([
      { queenSeen: false, inspectedAt: new Date("2026-04-01T10:00:00Z") },
      { queenSeen: false, inspectedAt: new Date("2026-03-18T10:00:00Z") },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "queen_absent");
    expect(alert).toBeDefined();
    expect(alert.severity).toBe("critical");
    expect(alert.data.inspectionCount).toBe(2);
    expect(alert.data.lastInspectedAt).toBeDefined();
  });

  it("does not fire when latest inspection has queenSeen=true", async () => {
    vi.mocked(db.inspection.findMany).mockResolvedValue([
      { queenSeen: true,  inspectedAt: new Date("2026-04-01T10:00:00Z") },
      { queenSeen: false, inspectedAt: new Date("2026-03-18T10:00:00Z") },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "queen_absent");
    expect(alert).toBeUndefined();
  });

  it("does not fire when only 1 inspection exists (insufficient data)", async () => {
    vi.mocked(db.inspection.findMany).mockResolvedValue([
      { queenSeen: false, inspectedAt: new Date("2026-04-01T10:00:00Z") },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "queen_absent");
    expect(alert).toBeUndefined();
  });

  it("does not fire when no inspections exist", async () => {
    vi.mocked(db.inspection.findMany).mockResolvedValue([]);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    const alert = res.body.find((a: any) => a.rule === "queen_absent");
    expect(alert).toBeUndefined();
  });
});

// ── All rules fire simultaneously ─────────────────────────────────────────────

describe("Multiple rules active simultaneously", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns one alert per active rule when all conditions are met", async () => {
    // Rule 1: red varroa + no treatment
    vi.mocked(db.varroaCount.findFirst).mockResolvedValue(varroaCount() as any);
    vi.mocked(db.treatmentLog.findFirst).mockResolvedValue(null);

    // Rule 2: over-running treatment
    vi.mocked(db.treatmentLog.findMany).mockResolvedValue([activeTreatment(70)] as any);

    // Rule 3: overdue inspection
    vi.mocked(db.inspection.findFirst).mockResolvedValue({
      inspectedAt:        new Date("2026-03-01T10:00:00Z"),
      nextInspectionDate: new Date("2026-03-15T10:00:00Z"),
    } as any);

    // Rule 4: disease flags
    vi.mocked(db.frameAiObservation.findMany).mockResolvedValue([
      { diseaseFlags: [{ type: "varroa_mites_visible" }] },
    ] as any);

    // Rule 5: queen absent
    vi.mocked(db.inspection.findMany).mockResolvedValue([
      { queenSeen: false, inspectedAt: new Date("2026-04-01T10:00:00Z") },
      { queenSeen: false, inspectedAt: new Date("2026-03-18T10:00:00Z") },
    ] as any);

    const res = await request(app).get(`/?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);

    const rules = res.body.map((a: any) => a.rule);
    expect(rules).toContain("varroa_no_treatment");
    expect(rules).toContain("treatment_too_long");
    expect(rules).toContain("inspection_overdue");
    expect(rules).toContain("disease_flags");
    expect(rules).toContain("queen_absent");
  });
});
