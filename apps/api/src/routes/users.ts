import { Router } from "express";
import { db } from "@beekeeper/db";
import * as bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAuth, requireRole, AuthRequest } from "../middleware/auth";
import { sendInviteEmail } from "../email/send";

const router = Router();
const WEB_URL = process.env.WEB_URL || "http://localhost:3000";

// GET /api/v1/users — list all users (queen only)
router.get("/", requireAuth, requireRole("queen"), async (_req, res) => {
  const users = await db.user.findMany({
    select: { id: true, email: true, name: true, role: true, status: true, createdAt: true, passwordHash: true, otpExpiresAt: true },
    orderBy: { createdAt: "asc" },
  });
  res.json(users.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    needsPassword: !u.passwordHash && u.status === "invited",
  })));
});

// POST /api/v1/users/invite — invite a new user (queen only)
router.post("/invite", requireAuth, requireRole("queen"), async (req: AuthRequest, res) => {
  const body = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    role: z.enum(["queen", "worker", "spectator"]),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });

  const { email, name, role } = body.data;

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "User with this email already exists" });

  // Generate 6-digit OTP
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = await bcrypt.hash(otp, 12);
  const otpExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24hrs

  const user = await db.user.create({
    data: { email, name, role, status: "invited", otpHash, otpExpiresAt },
  });

  // Email is best-effort — user is created even if Resend fails (domain not verified, etc.)
  let emailSent = false;
  try {
    await sendInviteEmail(email, name, otp, role, `${WEB_URL}/login`);
    emailSent = true;
  } catch (emailErr: unknown) {
    // Log but don't throw — the user exists, OTP is set, they just need the code manually
  }

  res.status(201).json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    emailSent,
    ...(emailSent ? {} : { otp, otpNote: "Email failed to send — give this OTP to the user manually" }),
  });
});

// PATCH /api/v1/users/:id — update user (queen only)
router.patch("/:id", requireAuth, requireRole("queen"), async (req, res) => {
  const body = z.object({
    name: z.string().min(1).optional(),
    role: z.enum(["queen", "worker", "spectator"]).optional(),
    status: z.enum(["active", "suspended"]).optional(),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input" });

  const user = await db.user.update({
    where: { id: req.params.id as string },
    data: body.data,
    select: { id: true, email: true, name: true, role: true, status: true },
  });
  res.json(user);
});

// DELETE /api/v1/users/:id — deactivate user (queen only, cannot delete self)
router.delete("/:id", requireAuth, requireRole("queen"), async (req: AuthRequest, res) => {
  if (req.params.id === req.user?.id) return res.status(400).json({ error: "Cannot delete yourself" });

  const user = await db.user.findUnique({ where: { id: req.params.id as string } });
  if (!user) return res.status(404).json({ error: "User not found" });

  await db.user.delete({
    where: { id: req.params.id as string },
  });
  res.json({ message: "User deleted" });
});

// POST /api/v1/users/:id/reset-otp — generate new OTP for user (queen only)
router.post("/:id/reset-otp", requireAuth, requireRole("queen"), async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.params.id as string } });
  if (!user) return res.status(404).json({ error: "User not found" });

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = await bcrypt.hash(otp, 12);
  const otpExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.user.update({
    where: { id: req.params.id as string },
    data: { otpHash, otpExpiresAt, status: "invited" },
  });

  let emailSent = false;
  try {
    await sendInviteEmail(user.email, user.name || "", otp, user.role, `${WEB_URL}/login`);
    emailSent = true;
  } catch { /* email is best-effort */ }

  res.json({ message: emailSent ? "New OTP sent" : "OTP reset — email failed to send", otp, emailSent });
});

export { router as usersRouter };
