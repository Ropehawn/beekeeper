import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

const inspectionSchema = z.object({
  hiveId: z.string().uuid(),
  inspectedAt: z.string().datetime(),
  weather: z.string().optional(),
  tempF: z.number().optional(),
  queenSeen: z.boolean().default(false),
  eggsPresent: z.boolean().default(false),
  larvaePresent: z.boolean().default(false),
  cappedBrood: z.boolean().default(false),
  queenCells: z.boolean().default(false),
  swarmCells: z.boolean().default(false),
  layingPattern: z.enum(["Solid", "Spotty", "None"]).optional(),
  temperament: z.enum(["calm", "nervous", "aggressive"]).optional(),
  population: z.enum(["light", "moderate", "strong"]).optional(),
  framesBees: z.number().int().min(0).optional(),
  framesBrood: z.number().int().min(0).optional(),
  framesHoney: z.number().int().min(0).optional(),
  framesPollen: z.number().int().min(0).optional(),
  diseaseNotes: z.string().optional(),
  notes: z.string().optional(),
  nextInspectionDate: z.string().datetime().optional(),
  // Feeder assessment — all optional, null = not recorded (not equivalent to empty)
  feederRemaining: z.enum(["full", "three_quarter", "half", "quarter", "empty"]).nullable().optional(),
  feederType: z.enum(["top_feeder", "entrance_feeder", "frame_feeder"]).nullable().optional(),
  // Accept either ISO datetime or YYYY-MM-DD; refine to reject future dates
  lastFedDate: z.string()
    .nullable()
    .optional()
    .refine(v => {
      if (v == null || v === "") return true;
      const d = new Date(v.length === 10 ? v + "T12:00:00Z" : v);
      if (isNaN(d.getTime())) return false;
      return d.getTime() <= Date.now() + 60_000; // small clock-skew tolerance
    }, { message: "lastFedDate cannot be in the future or invalid" }),
});

// GET /api/v1/inspections?hiveId=xxx
router.get("/", requireAuth, async (req, res) => {
  const hiveId = req.query.hiveId as string | undefined;
  const inspections = await db.inspection.findMany({
    where: hiveId ? { hiveId } : {},
    include: { inspector: { select: { name: true } }, hive: { select: { name: true } } },
    orderBy: { inspectedAt: "desc" },
    take: 50,
  });
  res.json(inspections);
});

// POST /api/v1/inspections
router.post("/", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Insufficient permissions" });

  const body = inspectionSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { hiveId, inspectedAt, nextInspectionDate, lastFedDate, feederRemaining, feederType, ...rest } = body.data;
  // Normalize lastFedDate: accept "" → null, "YYYY-MM-DD" → noon UTC
  let lastFedDateNormalized: Date | null | undefined;
  if (lastFedDate == null || lastFedDate === "") {
    lastFedDateNormalized = undefined;
  } else if (lastFedDate.length === 10) {
    lastFedDateNormalized = new Date(lastFedDate + "T12:00:00Z");
  } else {
    lastFedDateNormalized = new Date(lastFedDate);
  }
  const inspection = await db.inspection.create({
    data: {
      ...rest,
      inspectedAt: new Date(inspectedAt),
      nextInspectionDate: nextInspectionDate ? new Date(nextInspectionDate) : undefined,
      feederRemaining: feederRemaining ?? undefined,
      feederType: feederType ?? undefined,
      lastFedDate: lastFedDateNormalized ?? undefined,
      hive: { connect: { id: hiveId } },
      inspector: { connect: { id: req.user!.id } },
    },
  });
  res.status(201).json(inspection);
});

// GET /api/v1/inspections/:id
router.get("/:id", requireAuth, async (req, res) => {
  const inspection = await db.inspection.findUnique({
    where: { id: req.params.id as string },
    include: {
      inspector: { select: { name: true, email: true } },
      hive: { select: { name: true } },
      photos: true,
    },
  });
  if (!inspection) return res.status(404).json({ error: "Inspection not found" });
  res.json(inspection);
});

// ── Frame Summary ─────────────────────────────────────────────────────────────

/** How long after an inspection we tolerate zero linked frames before assuming
 *  link-inspection hasn't finished yet (linkPending guard). */
const LINK_PENDING_WINDOW_MS = 30_000; // 30 seconds

/** Convert a HiveComponent type slug + position number into a display label. */
function fmtComponentLabel(type: string, pos: number): string {
  const labels: Record<string, string> = {
    "brood-box":        "Brood Box",
    "honey-super":      "Honey Super",
    "bottom-board":     "Bottom Board",
    "queen-excluder":   "Queen Excluder",
    "top-feeder":       "Top Feeder",
    "inner-cover":      "Inner Cover",
    "outer-cover":      "Outer Cover",
    "entrance-reducer": "Entrance Reducer",
  };
  return `${labels[type] ?? type} ${pos}`;
}

// GET /api/v1/inspections/:id/frame-summary
// Returns a structured summary of all FrameObservations linked to this inspection,
// including per-side AI metadata (via FrameObservationSource → FrameAiObservation).
router.get("/:id/frame-summary", requireAuth, async (req, res) => {
  const inspection = await db.inspection.findUnique({
    where: { id: req.params.id as string },
    include: {
      hive: { select: { id: true, name: true } },
      frameObservations: {
        include: {
          frame: {
            include: {
              component: { select: { type: true, position: true } },
            },
          },
          sources: {
            include: {
              photo: {
                select: {
                  id:                true,
                  side:              true,
                  uploadConfirmedAt: true,
                },
              },
              aiObservation: {
                select: {
                  id:                 true,
                  side:               true,
                  confidence:         true,
                  imageQualityScore:  true,
                  imageQualityIssues: true,
                  diseaseFlags:       true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!inspection) return res.status(404).json({ error: "Inspection not found" });

  // Sort in application code: component position, then frame position within component
  const sorted = [...inspection.frameObservations].sort((a, b) => {
    const cDiff = a.frame.component.position - b.frame.component.position;
    return cDiff !== 0 ? cDiff : a.frame.position - b.frame.position;
  });

  // linkPending: inspection is recent and no frames linked yet — link-inspection may still be running
  // Guard: ageMs must be non-negative (future-dated inspections should never be "pending")
  const ageMs = Date.now() - new Date(inspection.inspectedAt).getTime();
  const linkPending = ageMs >= 0 && ageMs < LINK_PENDING_WINDOW_MS && sorted.length === 0;

  // Build per-frame data
  const frames = sorted.map(obs => {
    // Build aiSummary keyed by side using FrameObservationSource → FrameAiObservation
    const aiSummary: Record<string, object> = {};
    for (const src of obs.sources) {
      const ai = src.aiObservation;
      if (ai?.side && !aiSummary[ai.side]) {
        aiSummary[ai.side] = {
          confidence:         ai.confidence,
          imageQualityScore:  ai.imageQualityScore,
          imageQualityIssues: ai.imageQualityIssues ?? [],
          diseaseFlags:       ai.diseaseFlags ?? [],
        };
      }
    }

    // Photos: confirmed uploads only, deduplicated by photoId (a photo can appear
    // in multiple FrameObservationSource rows if re-analyzed).
    const seenPhotoIds = new Set<string>();
    const photos: { photoId: string; side: string }[] = [];
    for (const src of obs.sources) {
      if (src.photo?.uploadConfirmedAt != null && !seenPhotoIds.has(src.photo.id)) {
        seenPhotoIds.add(src.photo.id);
        photos.push({ photoId: src.photo.id, side: src.photo.side });
      }
    }

    return {
      frameId:        obs.frameId,
      position:       obs.frame.position,
      componentLabel: fmtComponentLabel(obs.frame.component.type, obs.frame.component.position),
      observation: {
        id:           obs.id,
        observedAt:   obs.observedAt,
        frontHoney:   obs.frontHoney,
        frontBrood:   obs.frontBrood,
        frontOpen:    obs.frontOpen,
        frontPollen:  obs.frontPollen,
        backHoney:    obs.backHoney,
        backBrood:    obs.backBrood,
        backOpen:     obs.backOpen,
        backPollen:   obs.backPollen,
        queenSpotted: obs.queenSpotted,
        notes:        obs.notes,
        photos,
        aiSummary:    Object.keys(aiSummary).length ? aiSummary : null,
      },
    };
  });

  // derivedTotals: average coverage across all observed sides
  let honeySum = 0, broodSum = 0, openSum = 0, pollenSum = 0, sideCount = 0;
  for (const f of frames) {
    const o = f.observation;
    const sides = [
      [o.frontHoney, o.frontBrood, o.frontOpen, o.frontPollen],
      [o.backHoney,  o.backBrood,  o.backOpen,  o.backPollen],
    ] as const;
    for (const [h, b, op, p] of sides) {
      if (h != null || b != null || op != null || p != null) {
        honeySum  += h  ?? 0;
        broodSum  += b  ?? 0;
        openSum   += op ?? 0;
        pollenSum += p  ?? 0;
        sideCount++;
      }
    }
  }

  const derivedTotals = {
    totalHoneyPct:  sideCount > 0 ? Math.round(honeySum  / sideCount) : 0,
    totalBroodPct:  sideCount > 0 ? Math.round(broodSum  / sideCount) : 0,
    totalOpenPct:   sideCount > 0 ? Math.round(openSum   / sideCount) : 0,
    totalPollenPct: sideCount > 0 ? Math.round(pollenSum / sideCount) : 0,
    framesObserved: frames.length,
  };

  res.json({
    inspectionId: inspection.id,
    inspectedAt:  inspection.inspectedAt,
    hive:         inspection.hive,
    hiveObservations: {
      queenSeen:       inspection.queenSeen,
      temperament:     inspection.temperament,
      population:      inspection.population,
      healthStatus:    inspection.diseaseNotes ? "Monitor" : "Good",
      notes:           inspection.notes,
      feederRemaining: inspection.feederRemaining,
      feederType:      inspection.feederType,
      lastFedDate:     inspection.lastFedDate,
    },
    derivedTotals,
    frames,
    linkPending,
  });
});

export { router as inspectionsRouter };
