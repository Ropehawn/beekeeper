import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

// ── Accepted treatment types ──────────────────────────────────────────────────

const TREATMENT_TYPES = [
  "oxalic_acid_dribble",
  "oxalic_acid_vaporize",
  "apivar",
  "apiguard",
  "formic_pro",
  "maqs",
  "hopguard",
  "other",
] as const;

// ── Computed-field helper ─────────────────────────────────────────────────────

interface DerivedFields {
  daysActive: number | null;
  isActive: boolean;
}

/**
 * Computes display-ready derived values from a treatment record.
 * daysActive: number of days between appliedAt and endedAt (or now if still active).
 * isActive: true when endedAt is null.
 * All values computed at read time — not stored in the database.
 */
function computeDerived(record: {
  appliedAt: Date;
  endedAt: Date | null;
}): DerivedFields {
  const { appliedAt, endedAt } = record;
  const isActive = endedAt === null;
  const end = endedAt ?? new Date();
  const daysActive = Math.round((end.getTime() - appliedAt.getTime()) / 86_400_000);
  return { daysActive, isActive };
}

// ── Validation ────────────────────────────────────────────────────────────────

const createSchema = z
  .object({
    hiveId:        z.string().uuid(),
    appliedAt:     z.string().datetime(),
    treatmentType: z.enum(TREATMENT_TYPES),
    productName:   z.string().optional(),
    dosage:        z.string().optional(),
    endedAt:       z.string().datetime().optional(),
    notes:         z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.endedAt && new Date(data.endedAt) <= new Date(data.appliedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endedAt must be after appliedAt",
        path: ["endedAt"],
      });
    }
  });

/** PATCH allows updating endedAt, notes, and dosage only. */
const patchSchema = z
  .object({
    endedAt: z.string().datetime().optional(),
    notes:   z.string().optional(),
    dosage:  z.string().optional(),
  })
  .refine(data => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// ── GET /api/v1/treatment-logs?hiveId=uuid&limit=N ───────────────────────────
// Returns treatments newest-first with computed daysActive / isActive.
// Spectators are allowed (read-only).

router.get("/", requireAuth, async (req, res) => {
  const hiveId = req.query.hiveId as string | undefined;
  if (!hiveId) return res.status(400).json({ error: "hiveId query parameter is required" });

  const limit = Math.min(parseInt((req.query.limit as string) || "10"), 50);

  const logs = await db.treatmentLog.findMany({
    where:   { hiveId },
    orderBy: { appliedAt: "desc" },
    take:    limit,
    include: { logger: { select: { name: true } } },
  });

  res.json(logs.map(l => ({ ...l, ...computeDerived(l) })));
});

// ── POST /api/v1/treatment-logs ───────────────────────────────────────────────
// Creates a new treatment record. Returns 201 with computed fields.
// Spectators are blocked (403).

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const body = createSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const { hiveId, appliedAt, endedAt, ...rest } = body.data;
  const log = await db.treatmentLog.create({
    data: {
      ...rest,
      appliedAt: new Date(appliedAt),
      endedAt:   endedAt ? new Date(endedAt) : null,
      hive:      { connect: { id: hiveId } },
      logger:    { connect: { id: req.user!.id } },
    },
    include: { logger: { select: { name: true } } },
  });

  res.status(201).json({ ...log, ...computeDerived(log) });
});

// ── PATCH /api/v1/treatment-logs/:id ─────────────────────────────────────────
// Allows updating endedAt, notes, and dosage.
// Validates endedAt > appliedAt if provided.
// Spectators are blocked (403).

router.patch("/:id", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const body = patchSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const id = req.params.id as string;
  const existing = await db.treatmentLog.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Treatment log not found" });

  // Validate endedAt > appliedAt using the stored appliedAt
  if (body.data.endedAt && new Date(body.data.endedAt) <= existing.appliedAt) {
    return res.status(400).json({
      error: "Invalid input",
      details: { fieldErrors: { endedAt: ["endedAt must be after appliedAt"] }, formErrors: [] },
    });
  }

  const log = await db.treatmentLog.update({
    where: { id },
    data: {
      ...(body.data.endedAt !== undefined && { endedAt: new Date(body.data.endedAt) }),
      ...(body.data.notes   !== undefined && { notes: body.data.notes }),
      ...(body.data.dosage  !== undefined && { dosage: body.data.dosage }),
    },
    include: { logger: { select: { name: true } } },
  });

  res.json({ ...log, ...computeDerived(log) });
});

export { router as treatmentLogsRouter };
