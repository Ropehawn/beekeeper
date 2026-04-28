// Hub endpoints for Tachyon (and similar) edge gateways.
//
// Auth model: hubs authenticate with `X-Hub-Key: <raw_key>`. We SHA-256 the raw
// key and compare against `hubs.api_key_hash`. Raw keys are only displayed once
// at registration time (via the admin UI — future).
//
// Endpoints:
//   POST /api/v1/hubs/register             (admin, JWT)  — creates a hub, returns raw key once
//   POST /api/v1/hubs/ingest               (hub,   key)  — batch upload of SensorReadingRaw rows
//   POST /api/v1/hubs/heartbeat            (hub,   key)  — liveness + diagnostics
//   GET  /api/v1/hubs/config               (hub,   key)  — hub pulls its config (device map)
//   POST /api/v1/hubs/photos/upload-url    (hub,   key)  — get presigned R2 PUT URL for a CSI capture
//   POST /api/v1/hubs/photos/confirm       (hub,   key)  — finalize a CSI capture after R2 upload
//   GET  /api/v1/hubs                      (admin, JWT)  — list hubs (no secrets)
//
// See INTELLIGENCE_SPEC §6 and HARDWARE_SPEC §10 for context.

import { Router } from "express";
import crypto from "crypto";
import { db, Prisma } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";
import {
  isR2Configured,
  getPresignedUploadUrl,
  headObject,
} from "../storage/r2";

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

// ── POST /api/v1/hubs/photos/upload-url ──────────────────────────────────────
// Capture daemon (hardware/tachyon-hub-py/camera_capture.py) calls this with
// metadata for a still about to be captured. We allocate the storage_key,
// write a CameraCapture row in pending state (storage_key set, file_size_bytes
// = 0 until confirm), and return a presigned PUT URL for direct R2 upload.
//
// Response: { id, storageKey, uploadUrl, expiresAt }

const photoUploadUrlSchema = z.object({
  cameraIndex:   z.number().int().min(0).max(7),
  capturedAt:    z.string().datetime(),
  hiveId:        z.string().uuid().nullable().optional(),
  width:         z.number().int().positive().optional(),
  height:        z.number().int().positive().optional(),
  format:        z.enum(["jpeg", "png", "raw"]).default("jpeg"),
  capturePhase:  z.enum(["scheduled", "burst", "manual"]).default("scheduled"),
  meta:          z.record(z.unknown()).optional(),
});

router.post("/photos/upload-url", requireHubKey, async (req: HubRequest, res) => {
  const parsed = photoUploadUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  if (!isR2Configured()) {
    return res.status(503).json({
      error: "R2 storage not available",
      detail: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME must be configured",
    });
  }

  const { cameraIndex, capturedAt, hiveId, width, height, format, capturePhase, meta } = parsed.data;
  const hubId = req.hub!.id;

  // Storage key layout: hubs/{hubId}/cameras/{idx}/YYYY/MM/DD/{captureId}.{ext}
  // Lets us list/scan by hub, by camera, or by date with prefix queries.
  const captureId = crypto.randomUUID();
  const ext = format === "raw" ? "raw" : format;
  const dt = new Date(capturedAt);
  const yyyy = dt.getUTCFullYear();
  const mm   = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(dt.getUTCDate()).padStart(2, "0");
  const storageKey = `hubs/${hubId}/cameras/${cameraIndex}/${yyyy}/${mm}/${dd}/${captureId}.${ext}`;
  const mimeType = format === "jpeg" ? "image/jpeg"
                  : format === "png" ? "image/png"
                  : "application/octet-stream";

  // Create the row in pending state. file_size_bytes will be filled in on confirm.
  const row = await db.cameraCapture.create({
    data: {
      id:             captureId,
      hubId,
      hiveId:         hiveId ?? null,
      cameraIndex,
      capturedAt:     dt,
      storageKey,
      fileSizeBytes:  0,
      width:          width ?? null,
      height:         height ?? null,
      format,
      capturePhase,
      metaJson:       meta ? (meta as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
    select: { id: true, storageKey: true },
  });

  const { url, expiresAt } = await getPresignedUploadUrl(storageKey, mimeType, 600);

  return res.json({
    id:         row.id,
    storageKey: row.storageKey,
    uploadUrl:  url,
    expiresAt:  expiresAt.toISOString(),
  });
});

// ── POST /api/v1/hubs/photos/confirm ─────────────────────────────────────────
// Daemon calls this AFTER successfully PUTting the image bytes to R2.
// We HeadObject to verify the file exists and write the actual file size in.
// Without this confirm step, capture rows are pending and can be GC'd by a
// future cleanup job (anything > 1h old with file_size_bytes = 0).

const photoConfirmSchema = z.object({
  id: z.string().uuid(),
});

router.post("/photos/confirm", requireHubKey, async (req: HubRequest, res) => {
  const parsed = photoConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }

  const row = await db.cameraCapture.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, hubId: true, storageKey: true, fileSizeBytes: true },
  });
  if (!row) return res.status(404).json({ error: "not found" });
  if (row.hubId !== req.hub!.id) return res.status(403).json({ error: "wrong hub" });

  const head = await headObject(row.storageKey);
  if (!head.exists) {
    return res.status(409).json({
      error: "object_not_in_r2",
      hint: "PUT to the presigned URL before calling confirm",
    });
  }

  await db.cameraCapture.update({
    where: { id: row.id },
    data:  { fileSizeBytes: head.contentLength ?? 0 },
  });

  logger.info({ hubId: row.hubId, captureId: row.id, bytes: head.contentLength }, "hub.photo.confirmed");
  return res.json({ id: row.id, fileSizeBytes: head.contentLength });
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

// ── Sensor Device Provisioning ──────────────────────────────────────────────
// These endpoints are called by the Tachyon provisioning tool to create/update
// sensor_devices records in Postgres. The provisioning tool is the source of
// truth for QR code → MAC binding. Hive assignment is handled separately by
// the BeeKeeper web app's apiary configuration UI.

const provisionSchema = z.object({
  sensorId: z.string().min(3).max(10),       // QR code ID, e.g., "T7K2M"
  mac: z.string().min(11).max(17),           // BLE MAC, e.g., "CF:66:52:74:C1:B2"
  vendor: z.string().default("tachyon_ble_sc833f"),
  name: z.string().optional(),
  events: z.array(z.any()).optional(),        // provisioning event log
  temp_c: z.number().optional(),
  humidity: z.number().optional(),
  rssi: z.number().optional(),
});

/**
 * POST /api/v1/hubs/devices/provision — create or update a sensor device.
 * Idempotent: if sensorId already exists, updates MAC (relink). If MAC
 * is already bound to a different sensorId, returns 409.
 * Auth: hub key (called from Tachyon provisioning tool).
 */
router.post("/devices/provision", requireHubKey, async (req: HubRequest, res) => {
  const parsed = provisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }

  const { sensorId, mac, vendor, name, events, temp_c, humidity, rssi } = parsed.data;
  const macUpper = mac.toUpperCase();

  try {
    // Invariant: one MAC → one sensor device
    const macConflict = await db.sensorDevice.findFirst({
      where: { currentMac: macUpper, deviceId: { not: sensorId } },
    });
    if (macConflict) {
      return res.status(409).json({
        error: "mac_already_linked",
        existingDeviceId: macConflict.deviceId,
      });
    }

    // Find existing device by sensorId (deviceId field)
    const existing = await db.sensorDevice.findUnique({ where: { deviceId: sensorId } });

    if (existing) {
      // Relink — update MAC, preserve everything else
      const oldMac = existing.currentMac;
      const existingConfig = (existing.config as any) || {};
      const existingEvents: any[] = existingConfig.events || [];

      existingEvents.push({
        type: "relinked",
        at: new Date().toISOString(),
        old_mac: oldMac,
        new_mac: macUpper,
      });

      const updated = await db.sensorDevice.update({
        where: { id: existing.id },
        data: {
          currentMac: macUpper,
          config: { ...existingConfig, events: existingEvents },
        },
      });

      logger.info({ deviceId: sensorId, oldMac, newMac: macUpper }, "sensor.relinked");
      return res.json({ device: updated, relinked: true, oldMac });
    } else {
      // New device
      const created = await db.sensorDevice.create({
        data: {
          vendor,
          deviceId: sensorId,
          name: name || sensorId,
          currentMac: macUpper,
          provisionedAt: new Date(),
          config: {
            events: events || [
              { type: "provisioned", at: new Date().toISOString() },
              { type: "linked", at: new Date().toISOString(), mac: macUpper, rssi, temp_c, humidity },
            ],
          },
        },
      });

      logger.info({ deviceId: sensorId, mac: macUpper }, "sensor.provisioned");
      return res.json({ device: created, relinked: false });
    }
  } catch (err: any) {
    logger.error({ err: err.message, deviceId: sensorId }, "sensor.provision.error");
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
});

/**
 * GET /api/v1/hubs/devices — list all sensor devices.
 * Used by daemon to build MAC → device_id cache.
 * Auth: hub key.
 */
router.get("/devices", requireHubKey, async (req: HubRequest, res) => {
  const devices = await db.sensorDevice.findMany({
    where: { isActive: true },
    select: {
      id: true,
      deviceId: true,
      currentMac: true,
      vendor: true,
      name: true,
      hiveId: true,
      isActive: true,
    },
  });

  // Build MAC → device_id lookup for daemon
  const macMap: Record<string, string> = {};
  for (const d of devices) {
    if (d.currentMac) macMap[d.currentMac.toUpperCase()] = d.id;
  }

  return res.json({ devices, macMap });
});

/**
 * DELETE /api/v1/hubs/devices/:sensorId — unlink a sensor device.
 * Sets isActive=false, clears currentMac. Does not delete — preserves history.
 */
router.delete("/devices/:sensorId", requireHubKey, async (req: HubRequest, res) => {
  const sensorId = req.params.sensorId as string;
  const device = await db.sensorDevice.findFirst({ where: { deviceId: sensorId } });
  if (!device) return res.status(404).json({ error: "not found" });

  const existingConfig = (device.config as any) || {};
  const existingEvents = existingConfig.events || [];
  existingEvents.push({ type: "unlinked", at: new Date().toISOString() });

  await db.sensorDevice.update({
    where: { id: device.id },
    data: {
      currentMac: null,
      isActive: false,
      config: { ...existingConfig, events: existingEvents },
    },
  });

  logger.info({ deviceId: sensorId }, "sensor.unlinked");
  return res.json({ ok: true });
});

export { router as hubsRouter };
