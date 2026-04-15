import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

const healthEventSchema = z.object({
  hiveId: z.string().uuid(),
  eventDate: z.string().datetime(),
  eventType: z.enum(["varroa", "nosema", "afb", "efb", "chalkbrood", "swarm", "requeen", "treatment", "other"]),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  treatment: z.string().optional(),
  notes: z.string().optional(),
});

// GET /api/v1/health-events?hiveId=xxx
router.get("/", requireAuth, async (req, res) => {
  const hiveId = req.query.hiveId as string | undefined;
  const events = await db.healthEvent.findMany({
    where: hiveId ? { hiveId } : {},
    include: { user: { select: { name: true } }, hive: { select: { name: true } } },
    orderBy: { eventDate: "desc" },
    take: 50,
  });
  res.json(events);
});

// POST /api/v1/health-events
router.post("/", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Insufficient permissions" });

  const body = healthEventSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { hiveId, eventDate, ...rest } = body.data;
  const event = await db.healthEvent.create({
    data: {
      ...rest,
      eventDate: new Date(eventDate),
      hive: { connect: { id: hiveId } },
      user: { connect: { id: req.user!.id } },
    },
  });
  res.status(201).json(event);
});

// PATCH /api/v1/health-events/:id
router.patch("/:id", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Insufficient permissions" });

  const updateSchema = healthEventSchema.partial().extend({
    resolvedAt: z.string().datetime().optional(),
  });

  const body = updateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { hiveId, eventDate, resolvedAt, ...rest } = body.data;
  const data: Record<string, unknown> = { ...rest };
  if (eventDate) data.eventDate = new Date(eventDate);
  if (resolvedAt) data.resolvedAt = new Date(resolvedAt);
  if (hiveId) data.hive = { connect: { id: hiveId } };

  const event = await db.healthEvent.update({
    where: { id: req.params.id as string },
    data,
  });
  res.json(event);
});

export { router as healthEventsRouter };
