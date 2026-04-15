/**
 * Structured Logger
 *
 * Thin wrapper around console that emits newline-delimited JSON to stdout.
 * Interface matches pino's calling convention — logger.info(fields, message) —
 * so swapping to pino later requires only changing this file, not call sites.
 *
 * Log level is controlled by the LOG_LEVEL environment variable:
 *   debug | info | warn | error   (default: info)
 *
 * Sensitive data rules:
 *   - Never pass raw email addresses; use hashEmail() from this module.
 *   - Never pass credential values (JWT_SECRET, DATABASE_URL, etc.).
 *   - Pass err.message only; stack traces are debug-level only.
 */

import * as crypto from "crypto";

// ── Level ordering ────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function activeLevel(): Level {
  const v = (process.env.LOG_LEVEL || "info").toLowerCase();
  return (v in LEVELS ? v : "info") as Level;
}

// ── Core emit ─────────────────────────────────────────────────────────────────

function emit(level: Level, fields: Record<string, unknown>, msg: string): void {
  // Suppress logs during tests unless explicitly enabled via LOG_LEVEL.
  // Production behavior is unaffected — NODE_ENV is never "test" in production.
  // To re-enable during a test run: LOG_LEVEL=debug npx vitest run
  if (process.env.NODE_ENV === "test" && !process.env.LOG_LEVEL) return;

  if (LEVELS[level] < LEVELS[activeLevel()]) return;

  const entry: Record<string, unknown> = {
    level,
    time:    new Date().toISOString(),
    service: "beekeeper-api",
    msg,
    ...fields,
  };

  // Errors go to stderr; everything else to stdout
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + "\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

export const logger = {
  debug: (fields: Record<string, unknown>, msg: string) => emit("debug", fields, msg),
  info:  (fields: Record<string, unknown>, msg: string) => emit("info",  fields, msg),
  warn:  (fields: Record<string, unknown>, msg: string) => emit("warn",  fields, msg),
  error: (fields: Record<string, unknown>, msg: string) => emit("error", fields, msg),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns an 8-char hex prefix of SHA-256(normalised email).
 * Safe to include in logs: useful for correlating events, not reversible.
 *
 *   hashEmail("User@Example.COM") → "a3f1b2c9"
 */
export function hashEmail(email: string): string {
  return crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 8);
}
