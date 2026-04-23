import { Resend } from "resend";
import { db } from "@beekeeper/db";
import * as jwt from "jsonwebtoken";
import { logger, hashEmail } from "../lib/logger";

let _resend: Resend | null = null;
function getResend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY not configured — email sending disabled");
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}
const FROM = process.env.EMAIL_FROM || "Beekeeper <noreply@thomdigital.com>";

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  template: string;
  recipientUserId?: string;
  metadata?: Record<string, unknown>;
  /** Optional RFC 2822 / RFC 8058 headers (e.g. List-Unsubscribe). */
  headers?: Record<string, string>;
}

export async function sendEmail({ to, subject, html, template, recipientUserId, metadata, headers }: SendEmailParams) {
  const { data, error } = await getResend().emails.send({
    from: FROM,
    to,
    subject,
    html,
    headers,
  });

  if (error) {
    logger.error(
      { template, to_hash: hashEmail(to), err: error.message },
      "Email send failed",
    );
    await db.emailLog.create({
      data: {
        template,
        recipientEmail: to,
        recipientUserId: recipientUserId || null,
        subject,
        status: "failed",
        metadataJson: { ...metadata, error: error.message } as any,
      },
    });
    throw new Error(`Email send failed: ${error.message}`);
  }

  await db.emailLog.create({
    data: {
      template,
      recipientEmail: to,
      recipientUserId: recipientUserId || null,
      subject,
      resendId: data?.id || null,
      status: "sent",
      metadataJson: (metadata || undefined) as any,
    },
  });

  return data;
}

export async function sendInviteEmail(to: string, name: string, otp: string, role: string, loginUrl: string) {
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #1e293b; margin-bottom: 8px;">You've been invited to Beekeeper</h2>
      <p style="color: #475569;">Hi ${name},</p>
      <p style="color: #475569;">You've been invited as a <strong>${role}</strong> to the Beekeeper hive management app.</p>
      <p style="color: #475569;">Your one-time password is:</p>
      <div style="background: #f8fafc; border: 2px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; margin: 24px 0;">
        <span style="font-size: 32px; font-weight: 700; letter-spacing: 4px; color: #0f172a;">${otp}</span>
      </div>
      <p style="color: #475569;">Sign in at <a href="${loginUrl}" style="color: #2563eb;">${loginUrl}</a> using your email and this one-time password. You'll be asked to set a new password on first login.</p>
      <p style="color: #94a3b8; font-size: 13px;">This OTP expires in 24 hours.</p>
    </div>
  `;

  return sendEmail({
    to,
    subject: "You've been invited to Beekeeper",
    html,
    template: "invite",
    metadata: { role },
  });
}

// ── Alert Digest ──────────────────────────────────────────────────────────────

/** One entry in the digest: a hive name + the alerts that fired for it. */
export interface HiveAlertGroup {
  hiveName: string;
  alerts: Array<{ rule: string; severity: string; message: string }>;
}

/**
 * Sends a daily alert digest to a single user.
 * `groups` contains only the hive/rule pairs that passed the cooldown gate —
 * it is the caller's responsibility to filter before calling this function.
 *
 * `apiUrl` is the base URL of the API service (used to build the unsubscribe link).
 */
export async function sendAlertDigest(
  to: string,
  name: string,
  userId: string,
  groups: HiveAlertGroup[],
  appUrl: string,
  apiUrl: string,
) {
  const totalAlerts = groups.reduce((n, g) => n + g.alerts.length, 0);
  const hasCritical = groups.some(g => g.alerts.some(a => a.severity === "critical"));

  const subjectIcon    = hasCritical ? "🔴" : "⚠️";
  const subjectSuffix  = hasCritical ? "Critical" : "";
  const subject = subjectSuffix
    ? `${subjectIcon} ${subjectSuffix}: ${totalAlerts} hive alert${totalAlerts === 1 ? "" : "s"} — Beekeeper`
    : `${subjectIcon} ${totalAlerts} hive alert${totalAlerts === 1 ? "" : "s"} need${totalAlerts === 1 ? "s" : ""} attention — Beekeeper`;

  // Build one-click unsubscribe token (no expiry — link must always work)
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
  const JWT_SECRET: string = process.env.JWT_SECRET;
  const unsubToken = jwt.sign({ sub: userId, email: to, purpose: "unsubscribe-alerts" }, JWT_SECRET);
  const unsubUrl   = `${apiUrl}/api/v1/auth/unsubscribe?token=${encodeURIComponent(unsubToken)}`;

  // Build per-hive sections
  const hiveSections = groups.map(g => {
    const alertRows = g.alerts.map(a => {
      const icon = a.severity === "critical" ? "🔴" : "⚠️";
      return `
        <tr>
          <td style="padding:6px 12px;color:#475569;font-size:14px;border-bottom:1px solid #f1f5f9;">
            ${icon}&nbsp;${escapeHtml(a.message)}
          </td>
        </tr>`;
    }).join("");

    return `
      <tr>
        <td style="padding:10px 12px 4px;font-size:13px;font-weight:700;color:#1e293b;background:#f8fafc;border-bottom:1px solid #e2e8f0;border-top:1px solid #e2e8f0;">
          ${escapeHtml(g.hiveName)}
        </td>
      </tr>
      ${alertRows}`;
  }).join("");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
      <h2 style="color:#1e293b;margin-bottom:8px;">🐝 Beekeeper — Hive Alerts</h2>
      <p style="color:#475569;">Hi ${escapeHtml(name || "there")},</p>
      <p style="color:#475569;">The following issue${totalAlerts === 1 ? "" : "s"} ${totalAlerts === 1 ? "was" : "were"} detected across your hives:</p>

      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin:24px 0;">
        ${hiveSections}
      </table>

      <div style="text-align:center;margin:32px 0;">
        <a href="${appUrl}" style="background:#f59e0b;color:#1a1a1a;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;">Open Beekeeper →</a>
      </div>

      <p style="color:#94a3b8;font-size:12px;border-top:1px solid #f1f5f9;padding-top:16px;margin-top:16px;">
        You're receiving this because you're an active team member on this apiary.
        Critical alerts re-notify after 48 hours; warnings re-notify after 7 days
        while the condition persists.<br><br>
        This only affects hive alert emails — account and security emails are unaffected.<br>
        <a href="${unsubUrl}" style="color:#94a3b8;">Unsubscribe from hive alert emails</a>
      </p>
    </div>`;

  return sendEmail({
    to,
    subject,
    html,
    template: "alert-digest",
    recipientUserId: userId,
    metadata: {
      totalAlerts,
      hasCritical,
      hiveCount: groups.length,
      rules: groups.flatMap(g => g.alerts.map(a => a.rule)),
    },
    headers: {
      // RFC 8058 one-click unsubscribe (honored by Gmail, Apple Mail, etc.)
      "List-Unsubscribe":       `<${unsubUrl}>`,
      "List-Unsubscribe-Post":  "List-Unsubscribe=One-Click",
    },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string) {
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #1e293b; margin-bottom: 8px;">Reset your password</h2>
      <p style="color: #475569;">Hi ${name || "there"},</p>
      <p style="color: #475569;">We received a request to reset your Beekeeper password. Click the button below to set a new password:</p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${resetUrl}" style="background: #2563eb; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">Reset Password</a>
      </div>
      <p style="color: #94a3b8; font-size: 13px;">This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
    </div>
  `;

  return sendEmail({
    to,
    subject: "Reset your Beekeeper password",
    html,
    template: "password-reset",
  });
}

// ── Hub Health Alert ─────────────────────────────────────────────────────────

export interface HubHealthAlertParams {
  to: string;
  recipientUserId: string;
  recipientName: string;
  hubName: string;
  hubId: string;
  /** "silent" — hub responsive but scanner stalled; "offline" — no heartbeat. */
  state: "silent" | "offline";
  heartbeatAgeMin: number | null;
  readingAgeMin: number | null;
}

/**
 * Alerts an operator that a Tachyon hub has stopped reporting.
 * `silent` means the hub process is alive and sending heartbeats but its BLE
 * scanner isn't ingesting readings — distinguishes a software/BlueZ fault
 * from a full hub outage.
 */
export async function sendHubHealthAlert(p: HubHealthAlertParams) {
  const severity = p.state === "offline" ? "🔴 offline" : "⚠️ scanner stalled";
  const humanState =
    p.state === "offline"
      ? "is not reporting a heartbeat — the hub process or its network link is down"
      : "is alive but its BLE scanner has stopped producing readings";

  const heartbeatLine =
    p.heartbeatAgeMin === null
      ? "never"
      : `${p.heartbeatAgeMin} min ago`;
  const readingLine =
    p.readingAgeMin === null
      ? "never"
      : `${p.readingAgeMin} min ago`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;">
      <h2 style="color:#1e293b;margin-bottom:8px;">Hub health alert: ${severity}</h2>
      <p style="color:#475569;">Hi ${escapeHtml(p.recipientName)},</p>
      <p style="color:#475569;">Your Tachyon hub <strong>${escapeHtml(p.hubName)}</strong> ${humanState}.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr>
          <td style="padding:6px 12px;color:#64748b;font-size:13px;border-bottom:1px solid #f1f5f9;">Last heartbeat</td>
          <td style="padding:6px 12px;color:#0f172a;font-size:13px;text-align:right;border-bottom:1px solid #f1f5f9;">${heartbeatLine}</td>
        </tr>
        <tr>
          <td style="padding:6px 12px;color:#64748b;font-size:13px;border-bottom:1px solid #f1f5f9;">Last reading ingested</td>
          <td style="padding:6px 12px;color:#0f172a;font-size:13px;text-align:right;border-bottom:1px solid #f1f5f9;">${readingLine}</td>
        </tr>
        <tr>
          <td style="padding:6px 12px;color:#64748b;font-size:13px;">Hub ID</td>
          <td style="padding:6px 12px;color:#0f172a;font-size:12px;font-family:monospace;text-align:right;">${escapeHtml(p.hubId)}</td>
        </tr>
      </table>
      <p style="color:#475569;font-size:14px;">Likely next step:</p>
      <ul style="color:#475569;font-size:14px;">
        <li>SSH into the hub and run <code style="background:#f1f5f9;padding:2px 6px;border-radius:3px;">sudo systemctl status beekeeper-hub-py</code></li>
        <li>If the service is failing, <code style="background:#f1f5f9;padding:2px 6px;border-radius:3px;">sudo systemctl restart beekeeper-hub-py</code></li>
        <li>Tail logs: <code style="background:#f1f5f9;padding:2px 6px;border-radius:3px;">sudo journalctl -u beekeeper-hub-py -f</code></li>
      </ul>
      <p style="color:#94a3b8;font-size:12px;margin-top:32px;">You won't get another alert for this hub/state within the next 4 hours.</p>
    </div>
  `;

  const subject =
    p.state === "offline"
      ? `🔴 Hub offline — ${p.hubName}`
      : `⚠️ Hub scanner stalled — ${p.hubName}`;

  return sendEmail({
    to: p.to,
    subject,
    html,
    template: "hub-health-alert",
    recipientUserId: p.recipientUserId,
    metadata: {
      hubId: p.hubId,
      state: p.state,
      heartbeatAgeMin: p.heartbeatAgeMin,
      readingAgeMin: p.readingAgeMin,
    },
  });
}
