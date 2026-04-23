/**
 * Hub Health Monitor
 *
 * Runs every 5 minutes (scheduled by scheduler.ts via node-cron).
 *
 * For every active hub, classifies current health into one of:
 *   - ok       — heartbeat fresh AND ingesting readings
 *   - silent   — heartbeat fresh BUT zero readings in the stale-reading window
 *                (hub process is alive and POSTing /heartbeat, but the BLE
 *                scanner is broken — distinguishes "hub alive" from "scanner
 *                broken" per the outage post-mortem from Apr 21-22)
 *   - offline  — no heartbeat in the stale-heartbeat window
 *
 * Sends an alert email to all active queen users when a hub is silent or
 * offline. Dedupes via the `email_log` table — at most one alert per hub
 * per state per ALERT_COOLDOWN_HOURS.
 *
 * Only runs when RESEND_API_KEY is configured; otherwise logs the state and
 * exits so local dev / CI doesn't try to send.
 */

import { db } from "@beekeeper/db";
import { sendHubHealthAlert } from "../email/send";
import { logger } from "../lib/logger";

// ── Tunables ──────────────────────────────────────────────────────────────────

const HEARTBEAT_STALE_MIN   = 15;     // no heartbeat this long → offline
const READINGS_STALE_MIN    = 15;     // no readings this long while alive → silent
const ALERT_COOLDOWN_HOURS  = 4;      // suppress duplicate alerts inside this window

type HealthState = "ok" | "silent" | "offline";

interface HubHealth {
  hubId:        string;
  hubName:      string;
  state:        HealthState;
  lastHeartbeatAt: Date | null;
  lastReadingAt:   Date | null;
  heartbeatAgeMin: number | null;   // null = never
  readingAgeMin:   number | null;
}

// ── Health classification ────────────────────────────────────────────────────

function classify(h: {
  lastHeartbeatAt: Date | null;
  lastReadingAt:   Date | null;
  now: Date;
}): HealthState {
  const hbAgeMin = h.lastHeartbeatAt
    ? (h.now.getTime() - h.lastHeartbeatAt.getTime()) / 60_000
    : Infinity;
  if (hbAgeMin > HEARTBEAT_STALE_MIN) return "offline";

  const rAgeMin = h.lastReadingAt
    ? (h.now.getTime() - h.lastReadingAt.getTime()) / 60_000
    : Infinity;
  if (rAgeMin > READINGS_STALE_MIN) return "silent";

  return "ok";
}

// ── Dedupe via email_log ─────────────────────────────────────────────────────

async function alreadyAlertedRecently(
  hubId: string,
  state: HealthState,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1_000);
  const recent = await db.emailLog.findFirst({
    where: {
      template: "hub-health-alert",
      status:   "sent",
      sentAt:   { gt: cutoff },
      // Metadata JSON filter — Prisma supports path-based filtering on Json.
      metadataJson: { path: ["hubId"], equals: hubId } as any,
      // AND the state matches (so e.g. offline → silent still alerts)
      AND: [
        { metadataJson: { path: ["state"], equals: state } as any },
      ],
    },
    select: { id: true, sentAt: true },
  });
  return !!recent;
}

// ── Main job ─────────────────────────────────────────────────────────────────

export async function runHubHealthMonitor(): Promise<void> {
  const now = new Date();

  const hubs = await db.hub.findMany({
    where: { isActive: true },
    select: {
      id:              true,
      name:            true,
      lastHeartbeat:   true,
    },
  });

  if (hubs.length === 0) {
    logger.debug({}, "hub-health-monitor: no active hubs");
    return;
  }

  // For each hub, find its most recent SensorReadingRaw timestamp.
  // One grouped query keeps this cheap even with many hubs.
  const readingAgg = await db.sensorReadingRaw.groupBy({
    by: ["hubId"],
    _max: { recordedAt: true },
    where: {
      hubId: { in: hubs.map((h) => h.id) },
    },
  });
  const lastReadingByHub = new Map<string, Date | null>(
    readingAgg.map((r) => [r.hubId!, r._max.recordedAt ?? null]),
  );

  const states: HubHealth[] = hubs.map((h) => {
    const lastReadingAt = lastReadingByHub.get(h.id) ?? null;
    const state = classify({
      lastHeartbeatAt: h.lastHeartbeat,
      lastReadingAt,
      now,
    });
    return {
      hubId:         h.id,
      hubName:       h.name,
      state,
      lastHeartbeatAt: h.lastHeartbeat,
      lastReadingAt,
      heartbeatAgeMin: h.lastHeartbeat
        ? Math.round((now.getTime() - h.lastHeartbeat.getTime()) / 60_000)
        : null,
      readingAgeMin: lastReadingAt
        ? Math.round((now.getTime() - lastReadingAt.getTime()) / 60_000)
        : null,
    };
  });

  const okCount     = states.filter((s) => s.state === "ok").length;
  const silentCount = states.filter((s) => s.state === "silent").length;
  const offlineCount = states.filter((s) => s.state === "offline").length;
  logger.info(
    { ok: okCount, silent: silentCount, offline: offlineCount, total: states.length },
    "hub-health-monitor: classified hubs",
  );

  // Short-circuit: no alerts to send + no email provider → done.
  if (silentCount === 0 && offlineCount === 0) return;
  if (!process.env.RESEND_API_KEY) {
    logger.warn({}, "hub-health-monitor: unhealthy hub(s) but RESEND_API_KEY is unset — no email sent");
    return;
  }

  // Find recipient queen users (active; alerts opt-in).
  const recipients = await db.user.findMany({
    where: { role: "queen", status: "active", alertEmailsEnabled: true },
    select: { id: true, email: true, name: true },
  });
  if (recipients.length === 0) {
    logger.warn({}, "hub-health-monitor: no active queen users to notify");
    return;
  }

  for (const hub of states) {
    if (hub.state === "ok") continue;
    if (await alreadyAlertedRecently(hub.hubId, hub.state)) {
      logger.debug(
        { hubId: hub.hubId, state: hub.state },
        "hub-health-monitor: alert suppressed (cooldown)",
      );
      continue;
    }

    for (const user of recipients) {
      try {
        await sendHubHealthAlert({
          to:               user.email,
          recipientUserId:  user.id,
          recipientName:    user.name ?? user.email,
          hubName:          hub.hubName,
          hubId:            hub.hubId,
          state:            hub.state,
          heartbeatAgeMin:  hub.heartbeatAgeMin,
          readingAgeMin:    hub.readingAgeMin,
        });
        logger.info(
          { hubId: hub.hubId, state: hub.state, to: user.id },
          "hub-health-monitor: alert sent",
        );
      } catch (err) {
        logger.error(
          { hubId: hub.hubId, state: hub.state, err: (err as Error).message },
          "hub-health-monitor: alert send failed",
        );
      }
    }
  }
}
