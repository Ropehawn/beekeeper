// Hub endpoints for Tachyon (and similar) edge gateways.
//
// Auth model: hubs authenticate with `X-Hub-Key: <raw_key>`. We SHA-256 the raw
// key and compare against `hubs.api_key_hash`. Raw keys are only displayed once
// at registration time (via the admin UI — future).
//
// Endpoints:
//   POST /api/v1/hubs/register        (admin, JWT)  — creates a hub, returns raw key once
//   POST /api/v1/hubs/ingest          (hub,   key)  — batch upload of SensorReadingRaw rows
//   POST /api/v1/hubs/heartbeat       (hub,   key)  — liveness + diagnostics
//   GET  /api/v1/hubs/config          (hub,   key)  — hub pulls its config (device map)
//   GET  /api/v1/hubs                 (admin, JWT)  — list hubs (no secrets)
//
// See INTELLIGENCE_SPEC §6 and HARDWARE_SPEC §10 for context.

import { Router } from "express";
import crypto from "crypto";
import { db, Prisma } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Middleware: validate X-Hub-Key header, attach `req.hub` to the request.
 * Does NOT fall back to JWT — hub routes are key-only.
 */
interface HubRequest extends AuthRequest {
  hub?: { id: string; apiaryId: string | null; name: string };
}

async function requireHubKey(
  req: HubRequest,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  const rawKey = req.header("x-hub-key");
  if (!rawKey || rawKey.length < 24) {
    return res.status(401).json({ error: "Missing or malformed X-Hub-Key header" });
  }

  const hash = sha256(rawKey);
  const hub = await db.hub.findUnique({
    where: { apiKeyHash: hash },
    select: { id: true, apiaryId: true, name: true, isActive: true },
  });

  if (!hub || !hub.isActive) {
    return res.status(401).json({ error: "Invalid or inactive hub key" });
  }

  req.hub = { id: hub.id, apiaryId: hub.apiaryId, name: hub.name };
  next();
}

// ── POST /api/v1/hubs/register ───────────────────────────────────────────────
// Admin-only. Creates a hub and returns the raw API key ONCE.

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  apiaryId: z.string().uuid().optional(),
  platform: z.enum(["tachyon", "esp32c6", "custom"]).default("tachyon"),
});

router.post("/register", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role !== "queen") {
    return res.status(403).json({ error: "Only queen role can register hubs" });
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }

  // Generate a 32-byte random key, base64url-encoded — 43 chars.
  const rawKey = crypto.randomBytes(32).toString("base64url");

  const hub = await db.hub.create({
    data: {
      name: parsed.data.name,
      apiaryId: parsed.data.apiaryId ?? null,
      platform: parsed.data.platform,
      apiKeyHash: sha256(rawKey),
    },
    select: { id: true, name: true, platform: true, apiaryId: true, createdAt: true },
  });

  logger.info({ hubId: hub.id, name: hub.name }, "hub.register");

  res.status(201).json({
    hub,
    apiKey: rawKey,
    warning: "Save this key now. It is never displayed again.",
  });
});

// ── GET /api/v1/hubs ─────────────────────────────────────────────────────────
// Admin-only list (never returns secrets).

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const hubs = await db.hub.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      platform: true,
      apiaryId: true,
      lastHeartbeat: true,
      lastUptimeSec: true,
      lastCpuTempC: true,
      lastStorageFreeGb: true,
      firmwareVersion: true,
      isActive: true,
      createdAt: true,
    },
  });

  res.json({ hubs });
});

// ── POST /api/v1/hubs/ingest ─────────────────────────────────────────────────
// Hub-key auth. Batch sensor reading upload.

const readingSchema = z.object({
  deviceMac: z.string().optional(),
  deviceId: z.string().uuid().optional(),
  hiveId: z.string().uuid().optional(),
  vendor: z.string().min(1).max(64),
  metric: z.string().min(1).max(64),
  value: z.number().finite(),
  unit: z.string().min(1).max(32),
  quality: z.number().min(0).max(1).optional(),
  batteryV: z.number().optional(),
  signalRssi: z.number().optional(),
  rawPayload: z.record(z.unknown()).optional(),
  recordedAt: z.string().datetime(),
});

const ingestSchema = z.object({
  readings: z.array(readingSchema).min(1).max(500),
});

router.post("/ingest", requireHubKey, async (req: HubRequest, res) => {
  const parsed = ingestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }

  const { readings } = parsed.data;
  const hubId = req.hub!.id;

  const rows = readings.map((r) => ({
    hubId,
    deviceMac: r.deviceMac ?? null,
    deviceId: r.deviceId ?? null,
    hiveId: r.hiveId ?? null,
    vendor: r.vendor,
    metric: r.metric,
    value: r.value,
    unit: r.unit,
    quality: r.quality ?? null,
    batteryV: r.batteryV ?? null,
    signalRssi: r.signalRssi ?? null,
    rawPayload: (r.rawPayload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    recordedAt: new Date(r.recordedAt),
  }));

  const result = await db.sensorReadingRaw.createMany({ data: rows, skipDuplicates: false });

  logger.info({ hubId, count: result.count }, "hub.ingest");

  res.status(202).json({ accepted: result.count });
});

// ── POST /api/v1/hubs/heartbeat ──────────────────────────────────────────────

const heartbeatSchema = z.object({
  uptimeSec: z.number().int().min(0).optional(),
  cpuTempC: z.number().optional(),
  storageFreeGb: z.number().optional(),
  firmwareVersion: z.string().max(64).optional(),
});

router.post("/heartbeat", requireHubKey, async (req: HubRequest, res) => {
  const parsed = heartbeatSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }

  await db.hub.update({
    where: { id: req.hub!.id },
    data: {
      lastHeartbeat: new Date(),
      lastUptimeSec: parsed.data.uptimeSec ?? null,
      lastCpuTempC: parsed.data.cpuTempC ?? null,
      lastStorageFreeGb: parsed.data.storageFreeGb ?? null,
      firmwareVersion: parsed.data.firmwareVersion ?? undefined,
    },
  });

  res.json({ ok: true });
});

// ── GET /api/v1/hubs/config ──────────────────────────────────────────────────
// Hub pulls its device registry + schedule config.

router.get("/config", requireHubKey, async (req: HubRequest, res) => {
  const hub = await db.hub.findUnique({
    where: { id: req.hub!.id },
    select: {
      id: true,
      name: true,
      platform: true,
      apiaryId: true,
      deviceRegistry: true,
    },
  });

  res.json({
    hub,
    scheduleDefaults: {
      sensorIntervalSec: 60,
      heartbeatIntervalSec: 300,
      audioClipEverySec: 3600,
      audioClipDurationSec: 10,
      cameraBurstEverySec: 300,
      cameraBurstDurationSec: 10,
      cameraActiveHours: { start: "06:00", end: "20:00" },
    },
  });
});

export { router as hubsRouter };
