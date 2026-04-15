/**
 * LLM-backed hive health analysis.
 *
 * Synthesizes inspection history, AI frame observations, varroa counts,
 * treatment status, and recent sensor readings into an intelligent
 * assessment using Claude. Cached for 1 hour per hive; invalidated
 * automatically when any input changes (via cacheKey hash).
 */

import { Router } from "express";
import { db, Prisma } from "@beekeeper/db";
import { requireAuth } from "../middleware/auth";
import { logger } from "../lib/logger";
import Anthropic from "@anthropic-ai/sdk";
import * as crypto from "crypto";
import { varroaStatus } from "./alerts";

const router = Router();

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MODEL_VERSION = process.env.ANTHROPIC_ANALYSIS_MODEL || "claude-sonnet-4-20250514";

const ANALYSIS_PROMPT = `You are an experienced beekeeper analyzing a single hive's health status.
Review the structured hive context below (inspections, AI frame analysis, varroa counts, treatments, sensor readings).

Return ONLY a valid JSON object with no prose or markdown, matching this schema:
{
  "severityScore": <integer 0-100, where 100 = perfect health, 0 = colony failure imminent>,
  "label": "Strong" | "Watch" | "At Risk" | "Critical",
  "summary": "<2-3 sentence plain-English assessment of overall hive health>",
  "topConcerns": [
    {
      "issue": "<brief issue name>",
      "severity": "critical" | "warning" | "info",
      "detail": "<1-2 sentence explanation>",
      "recommendation": "<specific action beekeeper should take>"
    }
  ],
  "nextInspectionFocus": ["<action item 1>", "<action item 2>", ...],
  "positiveIndicators": ["<what's going well 1>", ...],
  "confidence": <integer 0-100, how confident you are in this assessment given the data>
}

Rules:
- Use real beekeeping severity: AFB is hive-destroying and legally reportable; wax moths alone usually just mean a weak colony; varroa is the #1 killer of US honey bees.
- "Critical" label means immediate intervention needed (AFB, failing queen, hive collapse imminent).
- "At Risk" means treatment/action needed within days.
- "Watch" means monitor closely, possible issue developing.
- "Strong" means no concerns — affirm what's working.
- Be specific with recommendations (e.g., "Perform alcohol wash within 7 days" not "Check varroa").
- If data is sparse, say so in summary and keep confidence lower.
- Consider disease combinations (wax moths + SHB = weak colony, needs root cause).
- Consider the timeline — a single old inspection isn't enough to judge current health.
- Top concerns: 0-4 items ordered by severity. Empty array if truly nothing.
- nextInspectionFocus: 2-5 specific things to check on the next inspection.

DATA MODEL CAVEATS (do NOT raise these as concerns):
- Feeding logs only record what was ADDED to the feeder, not what bees consumed. Absence of recent feeding logs does NOT mean the colony is starving — the user may have fed without logging, or the colony may not need feeding.
- HOWEVER: inspection-level "Feeder" assessment IS a real signal. If an inspection records "Feeder: Empty" combined with low honey reserves (≤2 frames of honey), that IS a real food-risk / starvation concern and should be raised. Treat empty feeder + low honey as elevated food risk; empty feeder + ≤1 frame of honey as critical starvation risk. Empty feeder alone (with adequate honey reserves) is a moderate concern at most — the colony has natural stores.
- Feeder status is one signal among many. Brood, population, queenrightness, and observed food stores in frames matter equally or more. Do not let feeder status outweigh the broader colony assessment.
- Sensor readings are sparse (started recently). Absence of sensor data is not a colony health issue — do not include it in concerns.
- Cameras are not used for health assessment — do not mention them.
- A new colony (< 30 days since install) is expected to have minimal frame draw-out and brood — do not flag normal new-colony patterns as concerns.
- Only call out "no feeding assessment" if the latest inspection truly has no feeder field AND no honey-frame data AND it's a new colony in first 4 weeks.`;

interface AnalysisResult {
  severityScore: number;
  label: string;
  summary: string;
  topConcerns: Array<{ issue: string; severity: string; detail: string; recommendation: string }>;
  nextInspectionFocus: string[];
  positiveIndicators: string[];
  confidence: number;
}

// ── Build context from DB ────────────────────────────────────────────────────

async function buildHiveContext(hiveId: string): Promise<{ context: string; cacheInputs: string }> {
  const lookback = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days

  const [hive, inspections, varroaCounts, treatments, aiObservations, recentReadings] = await Promise.all([
    db.hive.findUnique({
      where: { id: hiveId },
      include: { apiary: { select: { name: true, address: true } } },
    }),
    db.inspection.findMany({
      where: { hiveId, inspectedAt: { gte: lookback } },
      orderBy: { inspectedAt: "desc" },
      take: 10,
    }),
    db.varroaCount.findMany({
      where: { hiveId, countedAt: { gte: lookback } },
      orderBy: { countedAt: "desc" },
      take: 10,
    }),
    db.treatmentLog.findMany({
      where: { hiveId, appliedAt: { gte: lookback } },
      orderBy: { appliedAt: "desc" },
      take: 5,
    }),
    db.frameAiObservation.findMany({
      where: {
        frame: { component: { hiveId } },
        createdAt: { gte: lookback },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        createdAt: true, confidence: true, side: true,
        honey: true, brood: true, openComb: true, pollen: true,
        diseaseFlags: true, imageQualityIssues: true, imageQualityScore: true,
      },
    }),
    db.sensorReading.findMany({
      where: {
        device: { hiveId, isActive: true },
        recordedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { recordedAt: "desc" },
      take: 100,
      select: { tempF: true, humidity: true, recordedAt: true },
    }),
  ]);

  if (!hive) throw new Error("Hive not found");

  // Cache key: hash of all input IDs + timestamps. Changes when new data arrives.
  const cacheInputs = JSON.stringify({
    hiveUpdatedAt: hive.updatedAt,
    inspectionIds: inspections.map(i => i.id + "|" + i.inspectedAt.getTime()),
    varroaIds: varroaCounts.map(v => v.id),
    treatmentIds: treatments.map(t => t.id + "|" + (t.endedAt?.getTime() ?? "active")),
    aiObsCount: aiObservations.length,
    latestReading: recentReadings[0]?.recordedAt ?? null,
  });

  // Build human-readable context for the LLM
  const now = new Date();
  const daysSinceInstall = hive.installDate
    ? Math.floor((now.getTime() - hive.installDate.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const parts: string[] = [];
  parts.push(`# Hive: ${hive.name} (${hive.breed || "Unknown breed"})`);
  parts.push(`- Location: ${hive.apiary?.name || "Unknown"} (${hive.apiary?.address || "no address"})`);
  parts.push(`- Status: ${hive.status}`);
  parts.push(`- Install date: ${hive.installDate?.toISOString().split("T")[0] || "not set"}${daysSinceInstall != null ? ` (${daysSinceInstall} days ago)` : ""}`);
  parts.push(`- Current date: ${now.toISOString().split("T")[0]}`);

  parts.push(`\n## Inspections (last ${inspections.length})`);
  if (inspections.length === 0) {
    parts.push("- NO INSPECTIONS IN LAST 60 DAYS");
  } else {
    inspections.forEach((i, idx) => {
      const tags: string[] = [];
      if (i.queenSeen) tags.push("queen seen"); else tags.push("queen NOT seen");
      if (i.eggsPresent) tags.push("eggs");
      if (i.larvaePresent) tags.push("larvae");
      if (i.cappedBrood) tags.push("capped brood");
      if (i.queenCells) tags.push("⚠ queen cells");
      if (i.swarmCells) tags.push("⚠ swarm cells");
      if (i.temperament) tags.push(`temperament: ${i.temperament}`);
      if (i.population) tags.push(`population: ${i.population}`);
      if (i.layingPattern) tags.push(`laying pattern: ${i.layingPattern}`);
      parts.push(`- ${i.inspectedAt.toISOString().split("T")[0]}${idx === 0 ? " (LATEST)" : ""}: ${tags.join(", ")}`);
      if (i.diseaseNotes) parts.push(`    Disease indicators: ${i.diseaseNotes}`);
      if (i.notes) parts.push(`    Notes: ${i.notes}`);
      if (i.framesBees != null) parts.push(`    Frames: ${i.framesBees} bees, ${i.framesBrood ?? "?"} brood, ${i.framesHoney ?? "?"} honey, ${i.framesPollen ?? "?"} pollen`);
      if (i.tempF != null) parts.push(`    Outside temp: ${i.tempF}°F, weather: ${i.weather || "?"}`);
      // Feeder assessment (added in migration 13) — only print when present
      if (i.feederRemaining || i.feederType || i.lastFedDate) {
        const feederLabel: Record<string, string> = {
          full: "Full", three_quarter: "3/4 full", half: "1/2 full", quarter: "1/4 full", empty: "Empty",
        };
        const feederTypeLabel: Record<string, string> = {
          top_feeder: "Top feeder", entrance_feeder: "Entrance feeder", frame_feeder: "Frame feeder",
        };
        const feederBits: string[] = [];
        if (i.feederRemaining) feederBits.push(`${feederLabel[i.feederRemaining] || i.feederRemaining} remaining`);
        if (i.feederType)      feederBits.push(feederTypeLabel[i.feederType] || i.feederType);
        if (i.lastFedDate)     feederBits.push(`last refilled ${i.lastFedDate.toISOString().split("T")[0]}`);
        parts.push(`    Feeder: ${feederBits.join(" · ")}`);
      }
    });
  }

  parts.push(`\n## Varroa Counts (last ${varroaCounts.length})`);
  if (varroaCounts.length === 0) {
    parts.push("- NO VARROA MONITORING IN LAST 60 DAYS");
  } else {
    varroaCounts.forEach(v => {
      const vs = varroaStatus(v.method, v.miteCount, v.beeSample, v.daysOnBoard);
      let pct: string;
      if (v.method === "sticky_board" && v.daysOnBoard) {
        pct = `${(v.miteCount / v.daysOnBoard).toFixed(1)}/day`;
      } else if (v.beeSample && v.beeSample > 0) {
        pct = `${((v.miteCount / v.beeSample) * 100).toFixed(1)}%`;
      } else {
        pct = `${v.miteCount} mites`;
      }
      parts.push(`- ${v.countedAt.toISOString().split("T")[0]}: ${v.method}, ${pct} (${vs.status})`);
    });
  }

  parts.push(`\n## Treatments (last ${treatments.length})`);
  if (treatments.length === 0) {
    parts.push("- No recent treatments");
  } else {
    treatments.forEach(t => {
      const endedStr = t.endedAt ? `ended ${t.endedAt.toISOString().split("T")[0]}` : "ACTIVE";
      parts.push(`- ${t.appliedAt.toISOString().split("T")[0]}: ${t.treatmentType}${t.productName ? ` (${t.productName})` : ""}, ${endedStr}`);
    });
  }

  parts.push(`\n## AI Frame Observations (${aiObservations.length} in last 60 days)`);
  if (aiObservations.length > 0) {
    const diseaseMap: Record<string, number> = {};
    let highConfCount = 0;
    let qualityIssues = 0;
    for (const obs of aiObservations) {
      if ((obs.confidence ?? 0) >= 80) highConfCount++;
      const qi = obs.imageQualityIssues as unknown as string[] | null;
      if (Array.isArray(qi) && qi.length > 0) qualityIssues++;
      const flags = obs.diseaseFlags as unknown as Array<{ type: string; confidence: number }> | null;
      if (Array.isArray(flags)) {
        for (const f of flags) {
          if ((f.confidence ?? 0) >= 70) {
            diseaseMap[f.type] = (diseaseMap[f.type] || 0) + 1;
          }
        }
      }
    }
    parts.push(`- ${highConfCount} high-confidence observations (≥80%)`);
    if (qualityIssues > 0) parts.push(`- ${qualityIssues} had image quality issues (may reduce AI reliability)`);
    const diseaseEntries = Object.entries(diseaseMap);
    if (diseaseEntries.length > 0) {
      parts.push(`- AI-detected disease flags: ${diseaseEntries.map(([k, v]) => `${k} (${v} sightings)`).join(", ")}`);
    } else {
      parts.push(`- No AI-flagged diseases in recent photos`);
    }
  }

  parts.push(`\n## Sensor Readings (last 7 days, ${recentReadings.length} data points)`);
  if (recentReadings.length === 0) {
    parts.push("- No sensor data available");
  } else {
    const temps = recentReadings.map(r => r.tempF).filter((t): t is number => t != null);
    const hums = recentReadings.map(r => r.humidity).filter((h): h is number => h != null);
    if (temps.length > 0) {
      const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
      const min = Math.min(...temps);
      const max = Math.max(...temps);
      parts.push(`- Temperature: avg ${avg.toFixed(1)}°F, range ${min.toFixed(1)}-${max.toFixed(1)}°F`);
    }
    if (hums.length > 0) {
      const avgH = hums.reduce((a, b) => a + b, 0) / hums.length;
      parts.push(`- Humidity: avg ${avgH.toFixed(0)}%`);
    }
  }

  return { context: parts.join("\n"), cacheInputs };
}

// Bump PROMPT_VERSION whenever the analysis prompt changes meaningfully — invalidates stale cached
// responses so the next call regenerates with the new prompt rules.
const PROMPT_VERSION = "v3-feeder-assessment";

function computeCacheKey(cacheInputs: string): string {
  return crypto.createHash("sha256").update(PROMPT_VERSION + "|" + cacheInputs).digest("hex").slice(0, 16);
}

// ── GET /api/v1/health-analysis/:hiveId ──────────────────────────────────────

router.get("/:hiveId", requireAuth, async (req, res) => {
  const hiveId = req.params.hiveId as string;
  if (!/^[0-9a-f-]{36}$/i.test(hiveId)) {
    return res.status(400).json({ error: "Invalid hive ID" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  let context: string, cacheInputs: string;
  try {
    const built = await buildHiveContext(hiveId);
    context = built.context;
    cacheInputs = built.cacheInputs;
  } catch (err) {
    if (err instanceof Error && err.message === "Hive not found") {
      return res.status(404).json({ error: "Hive not found" });
    }
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to build hive context");
    return res.status(500).json({ error: "Failed to gather hive data" });
  }

  const cacheKey = computeCacheKey(cacheInputs);
  const cacheCutoff = new Date(Date.now() - CACHE_TTL_MS);

  // Check cache — fresh analysis with matching cache key
  const cached = await db.hiveHealthAnalysis.findFirst({
    where: { hiveId, cacheKey, createdAt: { gte: cacheCutoff } },
    orderBy: { createdAt: "desc" },
  });

  if (cached) {
    return res.json({
      cached: true,
      analyzedAt: cached.createdAt,
      modelVersion: cached.modelVersion,
      ...(cached.analysisJson as object),
    });
  }

  // Run LLM analysis
  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: MODEL_VERSION,
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: ANALYSIS_PROMPT + "\n\n" + context,
      }],
    });

    const rawText = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(503).json({ error: "AI could not produce valid analysis" });
    }

    const parsed = JSON.parse(jsonMatch[0]) as AnalysisResult;

    // Store in cache
    await db.hiveHealthAnalysis.create({
      data: {
        id: crypto.randomUUID(),
        hiveId,
        severityScore: Math.max(0, Math.min(100, Math.round(parsed.severityScore || 0))),
        label: parsed.label || "Watch",
        summary: parsed.summary || "",
        analysisJson: parsed as unknown as Prisma.InputJsonValue,
        modelVersion: MODEL_VERSION,
        cacheKey,
      },
    });

    res.json({
      cached: false,
      analyzedAt: new Date(),
      modelVersion: MODEL_VERSION,
      ...parsed,
    });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "LLM health analysis failed");
    res.status(503).json({ error: "Health analysis failed — try again" });
  }
});

export { router as healthAnalysisRouter };
