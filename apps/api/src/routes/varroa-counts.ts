import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

// ── Computed-field helper ─────────────────────────────────────────────────────

/** Thresholds follow standard beekeeping treatment guidelines. */
const WASH_THRESHOLDS  = { warn: 2, treat: 3 };   // mites per 100 bees
const BOARD_THRESHOLDS = { warn: 8, treat: 12 };   // mites per day

type Status = "green" | "yellow" | "red";

interface DerivedFields {
  mitesPer100: number | null;
  mitesPerDay: number | null;
  status: Status | null;
}

/**
 * Computes display-ready derived values from raw count data.
 * No derived values are stored in the database — calculated at read time.
 * Returns null fields when the denominator is unavailable.
 */
function computeDerived(record: {
  method: string;
  miteCount: number;
  beeSample: number | null;
  daysOnBoard: number | null;
}): DerivedFields {
  const { method, miteCount, beeSample, daysOnBoard } = record;

  if (method === "alcohol_wash" || method === "sugar_roll") {
    if (!beeSample || beeSample <= 0) return { mitesPer100: null, mitesPerDay: null, status: null };
    const mitesPer100 = Math.round((miteCount / beeSample) * 1000) / 10;
    const status: Status =
      mitesPer100 < WASH_THRESHOLDS.warn  ? "green"  :
      mitesPer100 <= WASH_THRESHOLDS.treat ? "yellow" : "red";
    return { mitesPer100, mitesPerDay: null, status };
  }

  if (method === "sticky_board") {
    if (!daysOnBoard || daysOnBoard <= 0) return { mitesPer100: null, mitesPerDay: null, status: null };
    const mitesPerDay = Math.round((miteCount / daysOnBoard) * 10) / 10;
    const status: Status =
      mitesPerDay < BOARD_THRESHOLDS.warn  ? "green"  :
      mitesPerDay <= BOARD_THRESHOLDS.treat ? "yellow" : "red";
    return { mitesPer100: null, mitesPerDay, status };
  }

  return { mitesPer100: null, mitesPerDay: null, status: null };
}

// ── Validation ────────────────────────────────────────────────────────────────

const varroaSchema = z
  .object({
    hiveId:      z.string().uuid(),
    countedAt:   z.string().datetime(),
    method:      z.enum(["alcohol_wash", "sugar_roll", "sticky_board"]),
    miteCount:   z.number().int().min(0),
    beeSample:   z.number().int().min(1).optional(),
    daysOnBoard: z.number().int().min(1).optional(),
    notes:       z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.method === "alcohol_wash" || data.method === "sugar_roll") && !data.beeSample) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "beeSample is required for alcohol_wash and sugar_roll",
        path: ["beeSample"],
      });
    }
    if (data.method === "sticky_board" && !data.daysOnBoard) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "daysOnBoard is required for sticky_board",
        path: ["daysOnBoard"],
      });
    }
  });

// ── GET /api/v1/varroa-counts?hiveId=uuid&limit=10 ───────────────────────────
// Returns counts newest-first with computed mitesPer100 / mitesPerDay / status.
// Spectators are allowed (read-only).

router.get("/", requireAuth, async (req, res) => {
  const hiveId = req.query.hiveId as string | undefined;
  if (!hiveId) return res.status(400).json({ error: "hiveId query parameter is required" });

  const limit = Math.min(parseInt((req.query.limit as string) || "10"), 50);

  const counts = await db.varroaCount.findMany({
    where:    { hiveId },
    orderBy:  { countedAt: "desc" },
    take:     limit,
    include:  { counter: { select: { name: true } } },
  });

  res.json(counts.map(c => ({ ...c, ...computeDerived(c) })));
});

// ── POST /api/v1/varroa-counts ────────────────────────────────────────────────
// Creates a new count. Returns the created record with computed fields.
// Spectators are blocked (403).

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const body = varroaSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const { hiveId, countedAt, ...rest } = body.data;
  const count = await db.varroaCount.create({
    data: {
      ...rest,
      countedAt: new Date(countedAt),
      hive:    { connect: { id: hiveId } },
      counter: { connect: { id: req.user!.id } },
    },
    include: { counter: { select: { name: true } } },
  });

  res.status(201).json({ ...count, ...computeDerived(count) });
});

export { router as varroaCountsRouter };
