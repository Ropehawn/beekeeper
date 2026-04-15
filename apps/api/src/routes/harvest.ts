import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

const harvestSchema = z.object({
  hiveId: z.string().uuid(),
  harvestedAt: z.string().datetime(),
  weightLbs: z.number().positive(),
  notes: z.string().optional(),
});

// GET /api/v1/harvest?hiveId=xxx
router.get("/", requireAuth, async (req, res) => {
  const hiveId = req.query.hiveId as string | undefined;
  const logs = await db.harvestLog.findMany({
    where: hiveId ? { hiveId } : {},
    include: { hive: { select: { name: true } } },
    orderBy: { harvestedAt: "desc" },
    take: 50,
  });
  res.json(logs);
});

// POST /api/v1/harvest
router.post("/", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Insufficient permissions" });

  const body = harvestSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { hiveId, harvestedAt, ...rest } = body.data;
  const log = await db.harvestLog.create({
    data: {
      ...rest,
      harvestedAt: new Date(harvestedAt),
      hive: { connect: { id: hiveId } },
    },
  });
  res.status(201).json(log);
});

export { router as harvestRouter };
