import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, requireRole, AuthRequest } from "../middleware/auth";

const router = Router();

const taskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  hiveId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().optional(),
  dueDate: z.string().datetime().optional(),
});

// GET /api/v1/tasks
router.get("/", requireAuth, async (_req, res) => {
  const tasks = await db.task.findMany({
    include: {
      hive: { select: { name: true } },
      assignee: { select: { name: true, id: true } },
      creator: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(tasks);
});

// POST /api/v1/tasks
router.post("/", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Insufficient permissions" });

  const body = taskSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { hiveId, assignedTo, dueDate, ...rest } = body.data;
  const task = await db.task.create({
    data: {
      ...rest,
      ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
      creator: { connect: { id: req.user!.id } },
      ...(hiveId ? { hive: { connect: { id: hiveId } } } : {}),
      ...(assignedTo ? { assignee: { connect: { id: assignedTo } } } : {}),
    },
  });
  res.status(201).json(task);
});

// PATCH /api/v1/tasks/:id
router.patch("/:id", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") return res.status(403).json({ error: "Insufficient permissions" });

  const updateSchema = taskSchema.partial().extend({
    completedAt: z.string().datetime().optional(),
  });

  const body = updateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { hiveId, assignedTo, dueDate, completedAt, ...rest } = body.data;
  const data: Record<string, unknown> = { ...rest };
  if (dueDate) data.dueDate = new Date(dueDate);
  if (completedAt) data.completedAt = new Date(completedAt);
  if (hiveId) data.hive = { connect: { id: hiveId } };
  if (assignedTo) data.assignee = { connect: { id: assignedTo } };

  const task = await db.task.update({
    where: { id: req.params.id as string },
    data,
  });
  res.json(task);
});

// DELETE /api/v1/tasks/:id
router.delete("/:id", requireAuth, requireRole("queen"), async (req, res) => {
  await db.task.delete({ where: { id: req.params.id as string } });
  res.json({ success: true });
});

export { router as tasksRouter };
