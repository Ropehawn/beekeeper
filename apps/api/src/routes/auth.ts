import { Router } from "express";
import { db } from "@beekeeper/db";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import * as crypto from "crypto";
import { z } from "zod";
import { sendPasswordResetEmail } from "../email/send";
import { logger, hashEmail } from "../lib/logger";

const router = Router();
if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
const JWT_SECRET: string = process.env.JWT_SECRET;
const WEB_URL = process.env.WEB_URL || "http://localhost:3000";

// POST /api/v1/auth/login — email + password/OTP login
router.post("/login", async (req, res) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input" });

  const { email, password } = body.data;
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    logger.warn({ email_hash: hashEmail(email), reason: "user_not_found" }, "Auth failure");
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (user.status === "suspended") {
    logger.warn({ user_id: user.id, reason: "suspended" }, "Auth blocked");
    return res.status(403).json({ error: "Account suspended" });
  }

  // Check if this is an OTP login (invited user)
  if (user.status === "invited" && user.otpHash && user.otpExpiresAt) {
    if (new Date() > user.otpExpiresAt) {
      return res.status(401).json({ error: "OTP expired" });
    }
    const otpValid = await bcrypt.compare(password, user.otpHash);
    if (otpValid) {
      // OTP valid — client must call /auth/set-password next
      const tempToken = jwt.sign({ sub: user.id, email: user.email, otp: true }, JWT_SECRET, { expiresIn: "15m" });
      return res.json({ requirePasswordChange: true, token: tempToken });
    }
  }

  // Normal password login
  if (!user.passwordHash) {
    logger.warn({ user_id: user.id, reason: "no_password_hash" }, "Auth failure");
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    logger.warn({ user_id: user.id, reason: "invalid_password" }, "Auth failure");
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// POST /api/v1/auth/set-password — first-login password set (OTP users)
router.post("/set-password", async (req, res) => {
  const body = z.object({ token: z.string(), password: z.string().min(8) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Password must be at least 8 characters" });

  try {
    const payload = jwt.verify(body.data.token, JWT_SECRET) as { sub: string; otp?: boolean };
    if (!payload.otp) return res.status(400).json({ error: "Invalid token" });

    const passwordHash = await bcrypt.hash(body.data.password, 12);
    const user = await db.user.update({
      where: { id: payload.sub },
      data: { passwordHash, otpHash: null, otpExpiresAt: null, status: "active" },
    });

    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

// POST /api/v1/auth/forgot-password
router.post("/forgot-password", async (req, res) => {
  const body = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid email" });

  const user = await db.user.findUnique({ where: { email: body.data.email } });
  // Always return success to prevent email enumeration
  if (!user || user.status !== "active") {
    return res.json({ message: "If that email exists, a reset link has been sent" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const resetTokenHash = await bcrypt.hash(token, 12);
  const resetTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1hr

  await db.user.update({
    where: { id: user.id },
    data: { resetTokenHash, resetTokenExpiresAt },
  });

  const resetUrl = `${WEB_URL}/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`;
  await sendPasswordResetEmail(user.email, user.name || "", resetUrl);

  res.json({ message: "If that email exists, a reset link has been sent" });
});

// POST /api/v1/auth/reset-password
router.post("/reset-password", async (req, res) => {
  const body = z.object({
    email: z.string().email(),
    token: z.string().min(1),
    password: z.string().min(8),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input" });

  const { email, token, password } = body.data;
  const user = await db.user.findUnique({ where: { email } });

  if (!user || !user.resetTokenHash || !user.resetTokenExpiresAt) {
    return res.status(400).json({ error: "Invalid or expired reset link" });
  }

  if (new Date() > user.resetTokenExpiresAt) {
    return res.status(400).json({ error: "Reset link has expired" });
  }

  const valid = await bcrypt.compare(token, user.resetTokenHash);
  if (!valid) return res.status(400).json({ error: "Invalid or expired reset link" });

  const passwordHash = await bcrypt.hash(password, 12);
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash, resetTokenHash: null, resetTokenExpiresAt: null },
  });

  logger.info({ user_id: user.id }, "Password reset completed");
  res.json({ message: "Password reset successfully" });
});

// GET /api/v1/auth/unsubscribe?token=<jwt>
// One-click alert email unsubscribe. No auth required — the signed token proves identity.
// Returns plain HTML (not JSON) so email clients can open it directly.
router.get("/unsubscribe", async (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== "string") {
    return res.status(400).send(unsubscribePage("invalid", ""));
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; email: string; purpose: string };
    if (payload.purpose !== "unsubscribe-alerts") {
      return res.status(400).send(unsubscribePage("invalid", ""));
    }

    // Idempotent — safe to call multiple times
    await db.user.update({
      where: { id: payload.sub },
      data:  { alertEmailsEnabled: false },
    });

    return res.send(unsubscribePage("success", payload.email));
  } catch {
    return res.status(400).send(unsubscribePage("invalid", ""));
  }
});

function unsubscribePage(state: "success" | "invalid", email: string): string {
  if (state === "success") {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Unsubscribed — Beekeeper</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; border-radius: 12px; padding: 48px 40px; max-width: 440px; width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,.1); text-align: center; }
    h1 { color: #1e293b; font-size: 22px; margin: 0 0 12px; }
    p { color: #475569; font-size: 15px; line-height: 1.6; margin: 0 0 12px; }
    .note { color: #94a3b8; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:48px;margin-bottom:16px;">🐝</div>
    <h1>You've been unsubscribed</h1>
    <p>${email ? `<strong>${escapeHtml(email)}</strong> will no longer receive` : "You will no longer receive"} hive alert emails.</p>
    <p class="note">This only affects hive alert emails. Account and security emails (password resets, invitations) are unaffected.</p>
    <p class="note" style="margin-top:16px;">To re-enable alerts, sign in to Beekeeper and update your notification settings.</p>
  </div>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Invalid Link — Beekeeper</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; border-radius: 12px; padding: 48px 40px; max-width: 440px; width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,.1); text-align: center; }
    h1 { color: #1e293b; font-size: 22px; margin: 0 0 12px; }
    p { color: #475569; font-size: 15px; line-height: 1.6; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:48px;margin-bottom:16px;">🐝</div>
    <h1>Invalid or expired link</h1>
    <p>This unsubscribe link is not valid. If you'd like to stop receiving alert emails, please use the link in a recent Beekeeper alert email.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export { router as authRouter };
