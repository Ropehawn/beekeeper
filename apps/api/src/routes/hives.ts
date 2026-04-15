import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

const VALID_COMP_TYPES = [
  "bottom-board", "entrance-reducer", "brood-box", "queen-excluder",
  "honey-super", "top-feeder", "inner-cover", "outer-cover",
] as const;

// ── GET /api/v1/hives — list all hives with components ─────────────────
router.get("/", requireAuth, async (_req, res) => {
  const hives = await db.hive.findMany({
    include: {
      apiary: { select: { name: true, address: true } },
      components: {
        orderBy: { position: "asc" },
        include: { frames: { orderBy: { position: "asc" } } },
      },
    },
    orderBy: { name: "asc" },
  });
  res.json(hives);
});

// ── GET /api/v1/hives/:id — single hive detail ────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  const hive = await db.hive.findUnique({
    where: { id: req.params.id as string },
    include: {
      apiary: true,
      components: {
        orderBy: { position: "asc" },
        include: { frames: { orderBy: { position: "asc" } } },
      },
      inspections: { orderBy: { inspectedAt: "desc" }, take: 10 },
      feedingLogs: { orderBy: { fedAt: "desc" }, take: 10 },
      healthEvents: { orderBy: { eventDate: "desc" }, take: 10 },
    },
  });
  if (!hive) return res.status(404).json({ error: "Hive not found" });
  res.json(hive);
});

// ── POST /api/v1/hives — create hive with components & frames ─────────
const componentSchema = z.object({
  type: z.enum(VALID_COMP_TYPES),
  frameCount: z.number().int().min(1).max(20).optional(),
  notes: z.string().optional(),
  state: z.string().optional(), // for entrance-reducer: Full Open | Reduced | Closed | Removed
});

const hiveCreateSchema = z.object({
  name: z.string().min(1).max(100),
  breed: z.string().optional(),
  source: z.string().optional(),
  installDate: z.string().optional(), // ISO date string
  status: z.enum(["active", "inactive", "dead", "pending"]).default("active"),
  queenMarkColor: z.enum(["white", "yellow", "red", "green", "blue"]).nullable().optional(),
  notes: z.string().optional(),
  components: z.array(componentSchema).min(1),
});

router.post("/", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Insufficient permissions" });

  const body = hiveCreateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { components, installDate, ...hiveData } = body.data;

  // Find the apiary (use the first one — single-apiary setup)
  const apiary = await db.apiary.findFirst();
  if (!apiary) return res.status(400).json({ error: "No apiary exists. Create an apiary first." });

  const hive = await db.hive.create({
    data: {
      ...hiveData,
      installDate: installDate ? new Date(installDate + "T12:00:00Z") : undefined,
      apiary: { connect: { id: apiary.id } },
      components: {
        create: components.map((comp, idx) => {
          const isBox = comp.type === "brood-box" || comp.type === "honey-super";
          const frameCount = isBox ? (comp.frameCount || 10) : undefined;
          return {
            type: comp.type,
            position: idx,
            frameCount,
            notes: comp.notes || (comp.state ? comp.state : undefined),
            // Auto-create frames for boxes
            ...(isBox && frameCount ? {
              frames: {
                create: Array.from({ length: frameCount }, (_, i) => ({
                  position: i + 1,
                })),
              },
            } : {}),
          };
        }),
      },
    },
    include: {
      apiary: { select: { name: true, address: true } },
      components: {
        orderBy: { position: "asc" },
        include: { frames: { orderBy: { position: "asc" } } },
      },
    },
  });

  res.status(201).json(hive);
});

// ── PATCH /api/v1/hives/:id — update hive-level data ──────────────────
const hiveUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  breed: z.string().optional(),
  source: z.string().optional(),
  installDate: z.string().optional(),
  queenMarkColor: z.enum(["white", "yellow", "red", "green", "blue"]).nullable().optional(),
  status: z.enum(["active", "inactive", "dead", "pending"]).optional(),
  notes: z.string().optional(),
});

router.patch("/:id", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Insufficient permissions" });

  const body = hiveUpdateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { installDate, ...rest } = body.data;
  const hive = await db.hive.update({
    where: { id: req.params.id as string },
    data: {
      ...rest,
      ...(installDate !== undefined ? { installDate: new Date(installDate + "T12:00:00Z") } : {}),
    },
  });
  res.json(hive);
});

// ── PUT /api/v1/hives/:id/components — replace entire component stack ──
// Deletes all existing components/frames and creates new ones.
// Used by the structure editor.
const componentStackSchema = z.array(z.object({
  type: z.enum(VALID_COMP_TYPES),
  frameCount: z.number().int().min(1).max(20).optional(),
  notes: z.string().optional(),
})).min(1);

router.put("/:id/components", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Insufficient permissions" });

  const body = componentStackSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const hiveId = req.params.id as string;

  // Verify hive exists
  const hive = await db.hive.findUnique({ where: { id: hiveId } });
  if (!hive) return res.status(404).json({ error: "Hive not found" });

  // Delete existing components (cascade deletes frames via DB constraint)
  await db.hiveComponent.deleteMany({ where: { hiveId } });

  // Create new component stack
  for (let idx = 0; idx < body.data.length; idx++) {
    const comp = body.data[idx];
    const isBox = comp.type === "brood-box" || comp.type === "honey-super";
    const frameCount = isBox ? (comp.frameCount || 10) : undefined;

    await db.hiveComponent.create({
      data: {
        hiveId,
        type: comp.type,
        position: idx,
        frameCount,
        notes: comp.notes || undefined,
        ...(isBox && frameCount ? {
          frames: {
            create: Array.from({ length: frameCount }, (_, i) => ({
              position: i + 1,
            })),
          },
        } : {}),
      },
    });
  }

  // Return updated hive with new components
  const updated = await db.hive.findUnique({
    where: { id: hiveId },
    include: {
      components: {
        orderBy: { position: "asc" },
        include: { frames: { orderBy: { position: "asc" } } },
      },
    },
  });
  res.json(updated);
});

// ── PATCH /api/v1/hives/:id/components/:compId/frames/:frameId ────────
const frameUpdateSchema = z.object({
  frontHoney:  z.number().int().min(0).max(100).optional(),
  frontBrood:  z.number().int().min(0).max(100).optional(),
  frontOpen:   z.number().int().min(0).max(100).optional(),
  frontPollen: z.number().int().min(0).max(100).optional(),
  backHoney:   z.number().int().min(0).max(100).optional(),
  backBrood:   z.number().int().min(0).max(100).optional(),
  backOpen:    z.number().int().min(0).max(100).optional(),
  backPollen:  z.number().int().min(0).max(100).optional(),
  notes:       z.string().optional(),
});

router.patch("/:id/components/:compId/frames/:frameId", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Spectators cannot edit frames" });

  const body = frameUpdateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const frame = await db.frame.update({
    where: { id: req.params.frameId as string },
    data: {
      ...body.data,
      lastInspectedAt: new Date(),
    },
  });
  res.json(frame);
});

export { router as hivesRouter };
