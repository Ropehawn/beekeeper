import { Router } from "express";
import { db } from "@beekeeper/db";
import { requireAuth } from "../middleware/auth";
import {
  varroaStatus,
  checkVarroaNoTreatment,
  checkTreatmentTooLong,
  checkInspectionOverdue,
  checkDiseaseFlags,
  checkQueenAbsent,
  Alert,
} from "./alerts";

const router = Router();

// ── Scoring constants (mirrors scores.ts) ────────────────────────────────────

const ALERT_PENALTIES: Record<string, number> = {
  varroa_no_treatment: -25,
  queen_absent:        -25,
  treatment_too_long:  -10,
  inspection_overdue:  -10,
  disease_flags:       -10,
};

const VARROA_YELLOW_PENALTY = -5;

type ScoreLabel = "Strong" | "Watch" | "At Risk";

function toLabel(score: number): ScoreLabel {
  if (score >= 85) return "Strong";
  if (score >= 65) return "Watch";
  return "At Risk";
}

// ── Response shape ────────────────────────────────────────────────────────────

export interface HiveSummary {
  hiveId:              string;
  score:               number;
  scoreLabel:          ScoreLabel;
  alertCount:          number;
  hasCritical:         boolean;
  varroaStatusColor:   "green" | "yellow" | "red" | null;
  varroaMetric:        string | null;   // e.g. "2.4 /day" or "1.8 /100"
  daysSinceInspection: number | null;
  activeTreatment:     string | null;   // productName or treatmentType, null if none
}

// ── GET /api/v1/hive-summary ──────────────────────────────────────────────────
// Returns a summary row for every active hive the auth user can see.
// One round-trip vs N×3 individual calls.
// Spectators are allowed (read-only endpoint).

router.get("/", requireAuth, async (req, res) => {
  const hives = await db.hive.findMany({
    where:  { status: "active" },
    select: { id: true },
  });

  if (hives.length === 0) {
    return res.json([]);
  }

  const results: HiveSummary[] = await Promise.all(
    hives.map(async ({ id: hiveId }) => {
      // Run all checks + supporting queries in parallel for this hive
      const [
        varroaAlert,
        treatmentAlerts,
        inspectionAlert,
        diseaseAlert,
        queenAlert,
        latestVarroa,
        latestInspection,
        activeTreatments,
      ] = await Promise.all([
        checkVarroaNoTreatment(hiveId),
        checkTreatmentTooLong(hiveId),
        checkInspectionOverdue(hiveId),
        checkDiseaseFlags(hiveId),
        checkQueenAbsent(hiveId),
        db.varroaCount.findFirst({
          where:   { hiveId },
          orderBy: { countedAt: "desc" },
          select:  { method: true, miteCount: true, beeSample: true, daysOnBoard: true, countedAt: true },
        }),
        db.inspection.findFirst({
          where:   { hiveId },
          orderBy: { inspectedAt: "desc" },
          select:  { inspectedAt: true },
        }),
        db.treatmentLog.findMany({
          where:  { hiveId, endedAt: null },
          select: { treatmentType: true, productName: true },
          take:   1,
        }),
      ]);

      // ── Alerts + score ──────────────────────────────────────────────────────
      const alerts: Alert[] = [
        varroaAlert,
        ...treatmentAlerts,
        inspectionAlert,
        diseaseAlert,
        queenAlert,
      ].filter(Boolean) as Alert[];

      let penaltyTotal = 0;
      for (const a of alerts) {
        penaltyTotal += ALERT_PENALTIES[a.rule] ?? -10;
      }

      // Varroa yellow soft penalty (only when red rule didn't already fire)
      const varroaRed = alerts.some(a => a.rule === "varroa_no_treatment");
      let varroaColor: "green" | "yellow" | "red" | null = null;
      let varroaMetric: string | null = null;

      if (latestVarroa) {
        const { status, metric } = varroaStatus(
          latestVarroa.method,
          latestVarroa.miteCount,
          latestVarroa.beeSample,
          latestVarroa.daysOnBoard,
        );
        varroaColor = status;
        if (status === "yellow" && !varroaRed) {
          penaltyTotal += VARROA_YELLOW_PENALTY;
        }
        if (metric.mitesPer100 !== undefined) {
          varroaMetric = `${metric.mitesPer100} /100`;
        } else if (metric.mitesPerDay !== undefined) {
          varroaMetric = `${metric.mitesPerDay} /day`;
        }
      }

      const score      = Math.max(0, Math.min(100, 100 + penaltyTotal));
      const scoreLabel = toLabel(score);
      const alertCount = alerts.length;
      const hasCritical = alerts.some(a => a.severity === "critical");

      // ── Days since inspection ───────────────────────────────────────────────
      const daysSinceInspection = latestInspection
        ? Math.floor((Date.now() - latestInspection.inspectedAt.getTime()) / 86_400_000)
        : null;

      // ── Active treatment label ──────────────────────────────────────────────
      const t = activeTreatments[0] ?? null;
      const activeTreatment = t
        ? (t.productName || t.treatmentType)
        : null;

      return {
        hiveId,
        score,
        scoreLabel,
        alertCount,
        hasCritical,
        varroaStatusColor: varroaColor,
        varroaMetric,
        daysSinceInspection,
        activeTreatment,
      };
    }),
  );

  res.json(results);
});

export { router as hiveSummaryRouter };
