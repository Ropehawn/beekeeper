/**
 * Alert Notification Job
 *
 * Runs once per day (scheduled by scheduler.ts via node-cron).
 * For every active hive, runs all 5 alert rule checks. Alerts that pass
 * the per-user / per-hive / per-rule cooldown gate are batched into a
 * single digest email per user.
 *
 * Cooldown windows (Option A — rule-level, not instance-level):
 *   critical → 48 hours
 *   warning  → 7 days (168 hours)
 *
 * A row is written to alert_notification_log only after a successful send.
 * Failed sends do not consume the cooldown, so the alert fires again on the
 * next cron run automatically.
 */

import { db } from "@beekeeper/db";
import { sendAlertDigest, HiveAlertGroup } from "../email/send";
import { logger } from "../lib/logger";
import {
  checkVarroaNoTreatment,
  checkTreatmentTooLong,
  checkInspectionOverdue,
  checkDiseaseFlags,
  checkQueenAbsent,
  Alert,
} from "../routes/alerts";

// ── Cooldown constants ────────────────────────────────────────────────────────

const COOLDOWN_CRITICAL_HOURS = 48;
const COOLDOWN_WARNING_HOURS  = 7 * 24; // 168

// ── Types ─────────────────────────────────────────────────────────────────────

interface HiveWithAlerts {
  hiveId:   string;
  hiveName: string;
  alerts:   Alert[];
}

interface PendingAlert {
  hiveId:   string;
  hiveName: string;
  alert:    Alert;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cooldownHours(severity: string): number {
  return severity === "critical" ? COOLDOWN_CRITICAL_HOURS : COOLDOWN_WARNING_HOURS;
}

/**
 * Returns true when the alert has NOT been notified to this user within
 * the applicable cooldown window (i.e. it should fire).
 */
async function isOutsideCooldown(
  hiveId: string,
  rule: string,
  severity: string,
  recipientUserId: string,
): Promise<boolean> {
  const lastSent = await db.alertNotificationLog.findFirst({
    where:   { hiveId, rule, recipientUserId },
    orderBy: { sentAt: "desc" },
    select:  { sentAt: true },
  });

  if (!lastSent) return true;

  const hoursSince = (Date.now() - lastSent.sentAt.getTime()) / 3_600_000;
  return hoursSince >= cooldownHours(severity);
}

/**
 * Runs all 5 alert rule checks for a single hive concurrently.
 * Returns a flat array of fired alerts.
 */
async function runAllChecks(hiveId: string): Promise<Alert[]> {
  const [varroa, treatments, inspection, disease, queen] = await Promise.all([
    checkVarroaNoTreatment(hiveId),
    checkTreatmentTooLong(hiveId),
    checkInspectionOverdue(hiveId),
    checkDiseaseFlags(hiveId),
    checkQueenAbsent(hiveId),
  ]);

  return [varroa, ...treatments, inspection, disease, queen].filter(Boolean) as Alert[];
}

// ── Main job ──────────────────────────────────────────────────────────────────

export async function runAlertNotifications(): Promise<void> {
  const appUrl = process.env.WEB_URL || "http://localhost:3000";
  const apiUrl  = process.env.API_URL  || "http://localhost:3001";

  // 1. Fetch all users who should receive alerts (must have alertEmailsEnabled)
  const users = await db.user.findMany({
    where:  { status: "active", role: { in: ["queen", "worker"] }, alertEmailsEnabled: true },
    select: { id: true, email: true, name: true },
  });

  if (users.length === 0) {
    logger.info({}, "Alert notifications: no eligible users — skipping");
    return;
  }

  // 2. Fetch all active hives
  const hives = await db.hive.findMany({
    where:  { status: "active" },
    select: { id: true, name: true },
  });

  if (hives.length === 0) {
    logger.info({}, "Alert notifications: no active hives — skipping");
    return;
  }

  // 3. Run alert checks for all hives concurrently
  const hiveResults: HiveWithAlerts[] = await Promise.all(
    hives.map(async h => ({
      hiveId:   h.id,
      hiveName: h.name,
      alerts:   await runAllChecks(h.id),
    })),
  );

  // Filter out hives with no alerts at all
  const hivesWithAlerts = hiveResults.filter(h => h.alerts.length > 0);

  if (hivesWithAlerts.length === 0) {
    logger.info({ hive_count: hives.length }, "Alert notifications: all hives healthy — no emails to send");
    return;
  }

  // 4. Per-user: check cooldowns, build digest, send
  for (const user of users) {
    const pendingAlerts: PendingAlert[] = [];

    for (const hive of hivesWithAlerts) {
      for (const alert of hive.alerts) {
        const shouldFire = await isOutsideCooldown(
          hive.hiveId, alert.rule, alert.severity, user.id,
        );
        if (shouldFire) {
          pendingAlerts.push({ hiveId: hive.hiveId, hiveName: hive.hiveName, alert });
        }
      }
    }

    if (pendingAlerts.length === 0) {
      logger.info({ user_id: user.id, reason: "within_cooldown" }, "Alert digest skipped");
      continue;
    }

    // Group pending alerts by hive for the digest body
    const groupMap = new Map<string, HiveAlertGroup>();
    for (const pa of pendingAlerts) {
      if (!groupMap.has(pa.hiveId)) {
        groupMap.set(pa.hiveId, { hiveName: pa.hiveName, alerts: [] });
      }
      groupMap.get(pa.hiveId)!.alerts.push({
        rule:     pa.alert.rule,
        severity: pa.alert.severity,
        message:  pa.alert.message,
      });
    }
    const groups: HiveAlertGroup[] = [...groupMap.values()];

    try {
      // 5. Send the digest
      const emailData = await sendAlertDigest(
        user.email,
        user.name ?? "",
        user.id,
        groups,
        appUrl,
        apiUrl,
      );

      // 6. Look up the EmailLog row just created (sendEmail inserts it)
      //    sendEmail returns the Resend data object; we need the EmailLog id.
      //    Query by resend id if available, else by recipient + template + sentAt approx.
      const resendId = (emailData as any)?.id ?? null;
      const emailLog = await db.emailLog.findFirst({
        where: resendId
          ? { resendId }
          : { recipientEmail: user.email, template: "alert-digest" },
        orderBy: { sentAt: "desc" },
        select:  { id: true },
      });

      // 7. Write one alert_notification_log row per fired alert
      await db.alertNotificationLog.createMany({
        data: pendingAlerts.map(pa => ({
          hiveId:          pa.hiveId,
          rule:            pa.alert.rule,
          severity:        pa.alert.severity,
          recipientUserId: user.id,
          emailLogId:      emailLog?.id ?? null,
        })),
      });

      logger.info(
        { user_id: user.id, alert_count: pendingAlerts.length, hive_count: groups.length },
        "Alert digest sent",
      );
    } catch (err) {
      // Per-user failure is isolated — continue to next user.
      // No alert_notification_log row is written, so the cooldown is not consumed:
      // the same alerts will be retried on the next cron run.
      logger.error(
        { user_id: user.id, err: (err as Error).message },
        "Alert digest failed",
      );
    }
  }
}
