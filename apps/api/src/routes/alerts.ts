import { Router } from "express";
import { db } from "@beekeeper/db";
import { requireAuth } from "../middleware/auth";

const router = Router();

// ── Rule thresholds (named constants — all Phase 1 rules use these) ───────────

const TREATMENT_MAX_DAYS         = 56;  // 8 weeks — Apivar max label duration
const INSPECTION_OVERDUE_DAYS    = 14;  // standard re-inspection interval
const QUEEN_ABSENT_INSPECTIONS   = 2;   // consecutive inspections required for absent-queen alert
const DISEASE_FLAG_CONFIDENCE    = 80;  // minimum AI analysis confidence to surface flags (0–100)
const DISEASE_FLAG_LOOKBACK_DAYS = 30;  // days to look back for AI disease observations

// ── Disease severity weights ─────────────────────────────────────────────────
// Penalty points applied per unique disease detected within the lookback window.
// Values reflect real-world beekeeping severity: AFB is hive-destroying and
// legally reportable; wax moths are typically a secondary indicator of a weak
// colony. The disease_flags rule is capped at DISEASE_PENALTY_CAP to prevent
// a single inspection from tanking the score below what any other rule can.

export const DISEASE_SEVERITY: Record<string, { points: number; label: string }> = {
  afb_signs:            { points: -35, label: "American Foulbrood" },
  american_foulbrood:   { points: -35, label: "American Foulbrood" },
  varroa_mites_visible: { points: -20, label: "Varroa mites visible" },
  varroa_signs:         { points: -20, label: "Varroa signs" },
  efb_signs:            { points: -15, label: "European Foulbrood" },
  european_foulbrood:   { points: -15, label: "European Foulbrood" },
  small_hive_beetles:   { points: -10, label: "Small Hive Beetles" },
  nosema:               { points: -10, label: "Nosema" },
  nosema_signs:         { points: -10, label: "Nosema" },
  sacbrood:             { points:  -5, label: "Sacbrood" },
  chalkbrood:           { points:  -5, label: "Chalkbrood" },
  wax_moths:            { points:  -5, label: "Wax Moths" },
};

export const DISEASE_PENALTY_CAP = -40;

// Map free-text manual disease strings (from the inspection form) to canonical keys
const MANUAL_DISEASE_MAP: Record<string, string> = {
  "varroa signs":          "varroa_signs",
  "chalkbrood":            "chalkbrood",
  "american foulbrood":    "afb_signs",
  "european foulbrood":    "efb_signs",
  "small hive beetles":    "small_hive_beetles",
  "wax moths":             "wax_moths",
  "nosema":                "nosema",
  "sacbrood":              "sacbrood",
};

function normalizeDiseaseKey(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (DISEASE_SEVERITY[lower]) return lower;
  if (MANUAL_DISEASE_MAP[lower]) return MANUAL_DISEASE_MAP[lower];
  return null;
}

/**
 * Compute severity-weighted penalty from a set of detected disease keys.
 * Adds combination bonuses for weak-colony signals.
 * Returned value is negative; clamped to DISEASE_PENALTY_CAP at the low end.
 */
export function computeDiseasePenalty(diseaseKeys: string[]): { points: number; breakdown: Array<{ key: string; label: string; points: number }>; combos: string[] } {
  const unique = [...new Set(diseaseKeys)].filter(k => DISEASE_SEVERITY[k]);
  const breakdown = unique.map(k => ({ key: k, label: DISEASE_SEVERITY[k].label, points: DISEASE_SEVERITY[k].points }));
  let total = breakdown.reduce((sum, b) => sum + b.points, 0);

  const combos: string[] = [];
  // Wax moths + SHB → weak colony signal
  if (unique.includes("wax_moths") && unique.includes("small_hive_beetles")) {
    total -= 10;
    combos.push("Weak colony signal: wax moths + small hive beetles together (-10)");
  }
  // 3+ distinct diseases → multi-stressor
  if (unique.length >= 3) {
    total -= 5;
    combos.push(`Multi-stressor: ${unique.length} diseases detected (-5)`);
  }

  // Cap the penalty at DISEASE_PENALTY_CAP
  if (total < DISEASE_PENALTY_CAP) total = DISEASE_PENALTY_CAP;

  return { points: total, breakdown, combos };
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Severity = "critical" | "warning";

export interface Alert {
  rule:     string;
  severity: Severity;
  message:  string;
  data?:    Record<string, unknown>;
}

// ── Shared helper: compute varroa status from raw count fields ─────────────────

export function varroaStatus(
  method: string,
  miteCount: number,
  beeSample: number | null,
  daysOnBoard: number | null,
): { status: "green" | "yellow" | "red" | null; metric: Record<string, number> } {
  if (method === "alcohol_wash" || method === "sugar_roll") {
    if (!beeSample || beeSample <= 0) return { status: null, metric: {} };
    const mitesPer100 = Math.round((miteCount / beeSample) * 1000) / 10;
    const status =
      mitesPer100 < 2  ? "green"  :
      mitesPer100 <= 3 ? "yellow" : "red";
    return { status, metric: { mitesPer100 } };
  }
  if (method === "sticky_board") {
    if (!daysOnBoard || daysOnBoard <= 0) return { status: null, metric: {} };
    const mitesPerDay = Math.round((miteCount / daysOnBoard) * 10) / 10;
    const status =
      mitesPerDay < 8   ? "green"  :
      mitesPerDay <= 12 ? "yellow" : "red";
    return { status, metric: { mitesPerDay } };
  }
  return { status: null, metric: {} };
}

// ── Rule functions (exported for reuse by scores route) ──────────────────────

export async function checkVarroaNoTreatment(hiveId: string): Promise<Alert | null> {
  const latest = await db.varroaCount.findFirst({
    where:   { hiveId },
    orderBy: { countedAt: "desc" },
  });
  if (!latest) return null;

  const { status, metric } = varroaStatus(
    latest.method, latest.miteCount, latest.beeSample, latest.daysOnBoard,
  );
  if (status !== "red") return null;

  const activeTreatment = await db.treatmentLog.findFirst({
    where: { hiveId, endedAt: null },
  });
  if (activeTreatment) return null;

  return {
    rule:     "varroa_no_treatment",
    severity: "critical",
    message:  "Varroa level is high with no active treatment",
    data:     { ...metric, method: latest.method },
  };
}

// ── Rule 2: Active treatment has been running longer than TREATMENT_MAX_DAYS ──

export async function checkTreatmentTooLong(hiveId: string): Promise<Alert[]> {
  const active = await db.treatmentLog.findMany({
    where:  { hiveId, endedAt: null },
    select: { id: true, treatmentType: true, productName: true, appliedAt: true },
  });

  const now = new Date();
  return active
    .map(t => {
      const daysActive = Math.floor((now.getTime() - t.appliedAt.getTime()) / 86_400_000);
      if (daysActive < TREATMENT_MAX_DAYS) return null;
      return {
        rule:     "treatment_too_long",
        severity: "warning" as Severity,
        message:  `Treatment has been running for ${daysActive} days (max: ${TREATMENT_MAX_DAYS})`,
        data: {
          treatmentLogId: t.id,
          treatmentType:  t.treatmentType,
          productName:    t.productName ?? null,
          daysActive,
        },
      };
    })
    .filter(Boolean) as Alert[];
}

// ── Rule 3: Next inspection date is overdue ───────────────────────────────────

export async function checkInspectionOverdue(hiveId: string): Promise<Alert | null> {
  const latest = await db.inspection.findFirst({
    where:   { hiveId },
    orderBy: { inspectedAt: "desc" },
    select:  { inspectedAt: true, nextInspectionDate: true },
  });
  if (!latest) return null;

  const now = new Date();
  const dueDate = latest.nextInspectionDate
    ?? new Date(latest.inspectedAt.getTime() + INSPECTION_OVERDUE_DAYS * 86_400_000);

  if (dueDate >= now) return null;

  const daysSinceDue        = Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000);
  const daysSinceInspection = Math.floor((now.getTime() - latest.inspectedAt.getTime()) / 86_400_000);

  return {
    rule:     "inspection_overdue",
    severity: "warning",
    message:  `Inspection overdue by ${daysSinceDue} day${daysSinceDue === 1 ? "" : "s"}`,
    data:     { daysSinceDue, daysSinceInspection, dueDate: dueDate.toISOString() },
  };
}

// ── Rule 4: Recent high-confidence AI disease flags ───────────────────────────

export async function checkDiseaseFlags(hiveId: string): Promise<Alert | null> {
  const lookbackDate = new Date(Date.now() - DISEASE_FLAG_LOOKBACK_DAYS * 86_400_000);

  // Check AI-detected disease flags from frame photos
  const obs = await db.frameAiObservation.findMany({
    where: {
      frame:      { component: { hiveId } },
      confidence: { gte: DISEASE_FLAG_CONFIDENCE },
      createdAt:  { gte: lookbackDate },
    },
    select: { diseaseFlags: true },
  });

  type DiseaseFlag = { type: string };
  const aiFlags = obs
    .flatMap(o => Array.isArray(o.diseaseFlags) ? (o.diseaseFlags as DiseaseFlag[]) : [])
    .filter(f => Boolean(f?.type));

  // Check manually reported diseases from inspection form (diseaseNotes field)
  const recentInspections = await db.inspection.findMany({
    where: {
      hiveId,
      inspectedAt: { gte: lookbackDate },
      diseaseNotes: { not: null },
    },
    select: { diseaseNotes: true },
    orderBy: { inspectedAt: "desc" },
    take: 5,
  });

  const manualFlags = recentInspections
    .filter(i => i.diseaseNotes && i.diseaseNotes.trim().length > 0)
    .map(i => i.diseaseNotes!.trim());

  if (aiFlags.length === 0 && manualFlags.length === 0) return null;

  const uniqueAiTypes = [...new Set(aiFlags.map(f => f.type))];

  // Normalize manual free-text to canonical keys where possible
  const manualKeys: string[] = [];
  for (const note of manualFlags) {
    // Manual notes are comma-separated when multiple diseases were checked
    const parts = note.split(",").map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      const key = normalizeDiseaseKey(part);
      if (key) manualKeys.push(key);
    }
  }

  // Combine all disease keys and compute severity-weighted penalty
  const allKeys = [...uniqueAiTypes, ...manualKeys];
  const penalty = computeDiseasePenalty(allKeys);

  // Build human-readable disease list from breakdown
  const diseaseLabels = penalty.breakdown.map(b => b.label).join(", ");

  return {
    rule:     "disease_flags",
    severity: penalty.points <= -25 ? "critical" : "warning",
    message:  diseaseLabels
      ? `Disease indicators: ${diseaseLabels}`
      : "Disease indicators detected",
    data: {
      aiFlags: uniqueAiTypes,
      manualFlags,
      manualKeys,
      detectedKeys: [...new Set(allKeys)],
      breakdown: penalty.breakdown,
      combos: penalty.combos,
      penaltyPoints: penalty.points,
      observationCount: obs.length,
    },
  };
}

// ── Rule 5: Queen not seen across consecutive recent inspections ───────────────

export async function checkQueenAbsent(hiveId: string): Promise<Alert | null> {
  const recent = await db.inspection.findMany({
    where:   { hiveId },
    orderBy: { inspectedAt: "desc" },
    take:    QUEEN_ABSENT_INSPECTIONS,
    select:  { queenSeen: true, inspectedAt: true },
  });

  if (recent.length < QUEEN_ABSENT_INSPECTIONS) return null;

  const allAbsent = recent.every(i => !i.queenSeen);
  if (!allAbsent) return null;

  return {
    rule:     "queen_absent",
    severity: "critical",
    message:  `Queen not seen in last ${QUEEN_ABSENT_INSPECTIONS} inspections`,
    data: {
      inspectionCount:  QUEEN_ABSENT_INSPECTIONS,
      lastInspectedAt:  recent[0].inspectedAt.toISOString(),
    },
  };
}

// ── Rule 6: Low food — empty feeder + low honey reserves ─────────────────────
// Stale inspections (>14 days) flag staleInspection=true in metadata but do NOT
// escalate severity — staleness is a confidence concern, not a severity escalator.

const STALE_INSPECTION_DAYS = 14;

export async function checkLowFood(hiveId: string): Promise<Alert | null> {
  const latest = await db.inspection.findFirst({
    where:   { hiveId },
    orderBy: { inspectedAt: "desc" },
    select:  {
      id: true,
      inspectedAt: true,
      feederRemaining: true,
      framesHoney: true,
    },
  });

  // No inspection, or feeder not recorded as empty — no alert
  if (!latest || latest.feederRemaining !== "empty") return null;

  const now = Date.now();
  const ageDays = Math.floor((now - latest.inspectedAt.getTime()) / 86_400_000);
  const staleInspection = ageDays > STALE_INSPECTION_DAYS;
  const framesHoney = latest.framesHoney;

  // Severity rules — based on data quality, NOT staleness
  let severity: Severity = "warning";
  const reasons: string[] = ["Latest inspection recorded feeder as empty"];

  if (framesHoney != null) {
    if (framesHoney <= 1) {
      severity = "critical";
      reasons.push(`Honey reserves critically low (${framesHoney} frame${framesHoney === 1 ? "" : "s"})`);
    } else if (framesHoney <= 2) {
      reasons.push(`Honey reserves low (${framesHoney} frames)`);
    }
  }

  return {
    rule:     "low_food",
    severity,
    message:  reasons.join(" · "),
    data: {
      reasons,
      feederRemaining: latest.feederRemaining,
      framesHoney,
      inspectionAgeDays: ageDays,
      staleInspection,
      inspectionId: latest.id,
      observedAt: latest.inspectedAt.toISOString(),
    },
  };
}

// ── GET /api/v1/alerts?hiveId=uuid ────────────────────────────────────────────
// Runs all rule checks in parallel and returns the combined alert array.
// Returns [] when the hive is healthy. Spectators are allowed (read-only).

router.get("/", requireAuth, async (req, res) => {
  const hiveId = req.query.hiveId as string | undefined;
  if (!hiveId) return res.status(400).json({ error: "hiveId query parameter is required" });

  const [varroaAlert, treatmentAlerts, inspectionAlert, diseaseAlert, queenAlert, lowFoodAlert] =
    await Promise.all([
      checkVarroaNoTreatment(hiveId),
      checkTreatmentTooLong(hiveId),
      checkInspectionOverdue(hiveId),
      checkDiseaseFlags(hiveId),
      checkQueenAbsent(hiveId),
      checkLowFood(hiveId),
    ]);

  const alerts: Alert[] = [
    varroaAlert,
    ...treatmentAlerts,
    inspectionAlert,
    diseaseAlert,
    queenAlert,
    lowFoodAlert,
  ].filter(Boolean) as Alert[];

  res.json(alerts);
});

export { router as alertsRouter };
