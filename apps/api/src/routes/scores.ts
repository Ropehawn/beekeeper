import { Router } from "express";
import { db } from "@beekeeper/db";
import { requireAuth } from "../middleware/auth";
import {
  Alert,
  varroaStatus,
  checkVarroaNoTreatment,
  checkTreatmentTooLong,
  checkInspectionOverdue,
  checkDiseaseFlags,
  checkQueenAbsent,
  checkLowFood,
} from "./alerts";

const router = Router();

// ── Scoring constants ─────────────────────────────────────────────────────────

/** Points deducted per alert rule when that rule fires. */
const ALERT_PENALTIES: Record<string, number> = {
  varroa_no_treatment: -25,
  queen_absent:        -25,
  treatment_too_long:  -10,
  inspection_overdue:  -10,
  disease_flags:       -10,
  // low_food severity is dynamic (see scoring loop): warning = -10, critical = -20
  // Note: this CAN stack with low framesHoney signals from other rules in the
  // future. Currently no other rule penalizes low honey, so no double-count today.
  low_food:            -10,
};

/** Additional soft penalty when varroa is yellow (not captured by alert rules). */
const VARROA_YELLOW_PENALTY = -5;

// ── Types ─────────────────────────────────────────────────────────────────────

type Label = "Strong" | "Watch" | "At Risk";

interface Penalty {
  points: number;
  reason: string;
  rule?:  string;
}

interface HealthScore {
  hiveId:    string;
  score:     number;
  label:     Label;
  penalties: Penalty[];
  summary:   string;
}

// ── Score helpers ─────────────────────────────────────────────────────────────

function toLabel(score: number): Label {
  if (score >= 85) return "Strong";
  if (score >= 65) return "Watch";
  return "At Risk";
}

function buildSummary(label: Label, penalties: Penalty[]): string {
  if (label === "Strong") return "No active concerns detected.";
  const count = penalties.length;
  return `${count} active concern${count === 1 ? "" : "s"} detected. Review the alerts below.`;
}

// ── GET /api/v1/scores?hiveId=uuid ────────────────────────────────────────────
// Runs all 5 alert rules + a varroa yellow check, then computes a penalty-based
// score (0–100), label, ordered penalty list, and plain-text summary.
// Returns the same data as the alerts route would, plus the aggregate score.
// Spectators are allowed (read-only).

router.get("/", requireAuth, async (req, res) => {
  const hiveId = req.query.hiveId as string | undefined;
  if (!hiveId) return res.status(400).json({ error: "hiveId query parameter is required" });

  // Run all 5 alert rule checks and the varroa yellow check in parallel.
  // The varroa query is separate from checkVarroaNoTreatment because that
  // function only returns an alert for red status — we need yellow too.
  const [varroaAlert, treatmentAlerts, inspectionAlert, diseaseAlert, queenAlert, lowFoodAlert, latestVarroa] =
    await Promise.all([
      checkVarroaNoTreatment(hiveId),
      checkTreatmentTooLong(hiveId),
      checkInspectionOverdue(hiveId),
      checkDiseaseFlags(hiveId),
      checkQueenAbsent(hiveId),
      checkLowFood(hiveId),
      db.varroaCount.findFirst({
        where:   { hiveId },
        orderBy: { countedAt: "desc" },
      }),
    ]);

  const alerts: Alert[] = [
    varroaAlert,
    ...treatmentAlerts,
    inspectionAlert,
    diseaseAlert,
    queenAlert,
    lowFoodAlert,
  ].filter(Boolean) as Alert[];

  // ── Build penalty list ────────────────────────────────────────────────────

  const penalties: Penalty[] = [];

  for (const alert of alerts) {
    // For disease_flags, use the dynamic severity-weighted penalty from the alert
    // data (computed by computeDiseasePenalty). Falls back to -10 if missing.
    let points: number;
    if (alert.rule === "disease_flags" && typeof (alert.data as Record<string, unknown>)?.penaltyPoints === "number") {
      points = (alert.data as { penaltyPoints: number }).penaltyPoints;
    } else if (alert.rule === "low_food") {
      // low_food: derive from alert severity (warning = -10, critical = -20)
      points = alert.severity === "critical" ? -20 : -10;
    } else {
      points = ALERT_PENALTIES[alert.rule] ?? -10;
    }
    penalties.push({ points, reason: alert.message, rule: alert.rule });
  }

  // Varroa yellow: soft signal — only when Rule 1 did NOT fire (no double-count)
  const varroaRed = alerts.some(a => a.rule === "varroa_no_treatment");
  if (!varroaRed && latestVarroa) {
    const { status } = varroaStatus(
      latestVarroa.method,
      latestVarroa.miteCount,
      latestVarroa.beeSample,
      latestVarroa.daysOnBoard,
    );
    if (status === "yellow") {
      penalties.push({ points: VARROA_YELLOW_PENALTY, reason: "Varroa levels elevated (yellow)" });
    }
  }

  // ── Compute score ─────────────────────────────────────────────────────────

  const total  = penalties.reduce((sum, p) => sum + p.points, 0);
  const score  = Math.max(0, Math.min(100, 100 + total));
  const label  = toLabel(score);
  const summary = buildSummary(label, penalties);

  const result: HealthScore = { hiveId, score, label, penalties, summary };
  res.json(result);
});

export { router as scoresRouter };
