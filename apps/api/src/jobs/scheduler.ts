/**
 * Cron Scheduler
 *
 * Registers all background jobs using node-cron.
 * Imported once in server.ts after all routes are registered.
 *
 * All jobs are fire-and-forget: errors are caught inside each job function
 * so a failing job never crashes the server process.
 *
 * Set DISABLE_SCHEDULER=1 to skip job registration (useful on replica instances
 * or in environments where the cron should not run, e.g. during testing).
 */

import cron from "node-cron";
import { runAlertNotifications } from "./alert-notifications";
import { runSensorPolling } from "./sensor-polling";
import { logger } from "../lib/logger";

// ── Observability ─────────────────────────────────────────────────────────────

interface LastRun {
  at:     Date | null;
  status: "ok" | "error" | "timeout" | null;
  error:  string | null;
}

let _lastRun: LastRun = { at: null, status: null, error: null };
let _lastSensorRun: LastRun = { at: null, status: null, error: null };

/** Returns a snapshot of the last cron execution for the /health/scheduler endpoint. */
export function getSchedulerStatus() {
  return {
    schedulerEnabled: !process.env.DISABLE_SCHEDULER,
    lastRunAt:        _lastRun.at?.toISOString() ?? null,
    lastRunStatus:    _lastRun.status,
    lastRunError:     _lastRun.error,
    schedule:         "daily 08:00 UTC",
    sensorPolling: {
      lastRunAt:     _lastSensorRun.at?.toISOString() ?? null,
      lastRunStatus: _lastSensorRun.status,
      lastRunError:  _lastSensorRun.error,
      schedule:      "every 15 minutes",
    },
  };
}

// ── Guard ─────────────────────────────────────────────────────────────────────

if (process.env.DISABLE_SCHEDULER) {
  logger.info({ reason: "DISABLE_SCHEDULER" }, "Scheduler disabled — job registration skipped");
} else {
  // ── Timeout helper ──────────────────────────────────────────────────────────

  /** Rejects after `ms` milliseconds — guards against indefinitely hung jobs. */
  function withTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Job timed out after ${ms / 1_000}s`)), ms)
    );
  }

  const JOB_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

  // ── Alert Notification Digest ───────────────────────────────────────────────
  // Runs once per day at 08:00 UTC.
  // Sends a digest email to all active queen/worker users for any hive alerts
  // that have not been notified within their cooldown window.

  const _task = cron.schedule("0 8 * * *", async () => {
    const job = "alert-notifications";
    const startMs = Date.now();
    logger.info({ job }, "Cron job started");
    try {
      await Promise.race([runAlertNotifications(), withTimeout(JOB_TIMEOUT_MS)]);
      const duration_ms = Date.now() - startMs;
      _lastRun = { at: new Date(), status: "ok", error: null };
      logger.info({ job, duration_ms }, "Cron job completed");
    } catch (err) {
      const duration_ms = Date.now() - startMs;
      const msg    = err instanceof Error ? err.message : String(err);
      const status = msg.startsWith("Job timed out") ? "timeout" : "error";
      _lastRun = { at: new Date(), status, error: msg };
      if (status === "timeout") {
        logger.error({ job, duration_ms, timeout_ms: JOB_TIMEOUT_MS }, "Cron job timed out");
      } else {
        logger.error({ job, duration_ms, err: msg }, "Cron job failed");
      }
    }
  }, { timezone: "UTC" });

  // ── Sensor Polling ──────────────────────────────────────────────────────────
  // Runs every 5 minutes. Polls all active sensor devices and stores readings.

  const _sensorTask = cron.schedule("*/15 * * * *", async () => {
    const job = "sensor-polling";
    const startMs = Date.now();
    logger.info({ job }, "Cron job started");
    try {
      await Promise.race([runSensorPolling(), withTimeout(JOB_TIMEOUT_MS)]);
      const duration_ms = Date.now() - startMs;
      _lastSensorRun = { at: new Date(), status: "ok", error: null };
      logger.info({ job, duration_ms }, "Cron job completed");
    } catch (err) {
      const duration_ms = Date.now() - startMs;
      const msg    = err instanceof Error ? err.message : String(err);
      const status = msg.startsWith("Job timed out") ? "timeout" : "error";
      _lastSensorRun = { at: new Date(), status, error: msg };
      logger.error({ job, duration_ms, err: msg }, "Cron job failed");
    }
  }, { timezone: "UTC" });

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  function _stopScheduler(signal: string) {
    logger.info({ signal }, "Scheduler received signal — stopping cron tasks");
    _task.stop();
    _sensorTask.stop();
  }

  process.on("SIGTERM", () => _stopScheduler("SIGTERM"));
  process.on("SIGINT",  () => _stopScheduler("SIGINT"));

  logger.info({ job: "alert-notifications", schedule: "0 8 * * * UTC" }, "Cron job registered");
  logger.info({ job: "sensor-polling", schedule: "*/15 * * * * UTC" }, "Cron job registered");
}
