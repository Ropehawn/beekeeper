import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

const feedingSchema = z.object({
  hiveId: z.string().uuid(),
  fedAt: z.string().datetime(),
  feedType: z.enum(["sugar-syrup-1:1", "sugar-syrup-2:1", "fondant", "pollen-patty", "other"]),
  feederType: z.enum(["Top Feeder", "Entrance Feeder", "Frame Feeder"]).optional(),
  amountMl: z.number().optional(),
  amountG: z.number().optional(),
  notes: z.string().optional(),
});

// GET /api/v1/feeding?hiveId=xxx
router.get("/", requireAuth, async (req, res) => {
  const hiveId = req.query.hiveId as string | undefined;
  const logs = await db.feedingLog.findMany({
    where: hiveId ? { hiveId } : {},
    include: { user: { select: { name: true } }, hive: { select: { name: true } } },
    orderBy: { fedAt: "desc" },
    take: 50,
  });
  res.json(logs);
});

// POST /api/v1/feeding
router.post("/", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Insufficient permissions" });

  const body = feedingSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { hiveId, fedAt, ...rest } = body.data;
  const log = await db.feedingLog.create({
    data: {
      ...rest,
      fedAt: new Date(fedAt),
      hive: { connect: { id: hiveId } },
      user: { connect: { id: req.user!.id } },
    },
  });
  res.status(201).json(log);
});

export { router as feedingRouter };
