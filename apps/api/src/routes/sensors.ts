import { Router } from "express";
import { db, Prisma } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";
import { fetchUnifiSensor, fetchAllUnifiSensors } from "../lib/unifi-client";

const router = Router();

// ── Shared helpers ────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Schemas ───────────────────────────────────────────────────────────────────

const LOCATION_ROLE_VALUES = [
  "apiary_ambient", "hive_exterior", "entrance", "inner_cover",
  "brood_box_upper", "brood_box_lower", "honey_super",
  "base_scale", "under_hive", "audio_probe", "custom",
] as const;

const deviceSchema = z.object({
  hiveId:        z.string().uuid().optional(),
  unifiDeviceId: z.string().min(1).max(255),
  name:          z.string().min(1).max(255),
  pollInterval:  z.number().int().min(10).max(3600).default(60),
  locationRole:  z.enum(LOCATION_ROLE_VALUES).nullable().optional(),
  locationNote:  z.string().max(500).nullable().optional(),
});

// ── GET /api/v1/sensors/test-connection ───────────────────────────────────────
// Tests connectivity to the UniFi cloud API using the server-side UNIFI_API_KEY.
// No credentials are passed from the browser — the key lives in Railway env vars.
//
// Returns: { connected: boolean, sensorCount?: number, error?: string }

router.get("/test-connection", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const apiKey = process.env.UNIFI_API_KEY;
  if (!apiKey) {
    return res.json({ connected: false, error: "UNIFI_API_KEY is not configured on this server" });
  }

  const hostId = process.env.UNIFI_HOST_ID;
  if (!hostId) {
    // UNIFI_HOST_ID is missing — fetch available hosts from api.ui.com so the
    // user can identify and set the correct one without a separate API call.
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let hostsBody = "";
      let hostsStatus = 0;
      try {
        const r = await fetch("https://api.ui.com/v1/hosts", {
          method:  "GET",
          headers: { "X-API-Key": apiKey, "Accept": "application/json" },
          signal:  controller.signal,
        });
        hostsStatus = r.status;
        hostsBody   = await r.text().catch(() => "");
      } finally {
        clearTimeout(timeout);
      }

      if (hostsStatus === 401 || hostsStatus === 403) {
        return res.json({ connected: false, error: `UNIFI_HOST_ID is not set. Also, UNIFI_API_KEY was rejected by api.ui.com (HTTP ${hostsStatus}) — check the key is a valid Site Manager API key.` });
      }

      let hosts: { id: string; hardwareId?: string; reportedState?: { hostname?: string } }[] = [];
      try { hosts = JSON.parse(hostsBody)?.data ?? []; } catch { /* ignore */ }

      const hostList = hosts.map(h => ({
        id:       h.id,
        hostname: h.reportedState?.hostname ?? h.hardwareId ?? "(unknown)",
      }));

      return res.json({
        connected: false,
        error:     "UNIFI_HOST_ID is not set. Add it to Railway env vars.",
        availableHosts: hostList,
        instructions: "Copy the 'id' of your Protect console from availableHosts and set it as UNIFI_HOST_ID in Railway.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return res.json({ connected: false, error: `UNIFI_HOST_ID is not set, and could not reach api.ui.com to list hosts: ${msg}` });
    }
  }

  // Both keys present — test the actual connector path with a diagnostic fetch
  try {
    const connectorUrl = `https://api.ui.com/v1/connector/consoles/${hostId}/proxy/protect/integration/v1/sensors`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let httpStatus = 0;
    let httpBody   = "";
    try {
      const r = await fetch(connectorUrl, {
        method:  "GET",
        headers: { "X-API-Key": apiKey, "Accept": "application/json" },
        signal:  controller.signal,
      });
      httpStatus = r.status;
      httpBody   = await r.text().catch(() => "");
    } finally {
      clearTimeout(timeout);
    }

    if (httpStatus === 401 || httpStatus === 403) {
      return res.json({ connected: false, error: `API key rejected by api.ui.com (HTTP ${httpStatus}) — regenerate UNIFI_API_KEY at account.ui.com` });
    }
    if (httpStatus === 404) {
      return res.json({ connected: false, error: `Protect console not found (HTTP 404) — UNIFI_HOST_ID may be wrong. Current value: ${hostId}` });
    }
    if (!String(httpStatus).startsWith("2")) {
      return res.json({ connected: false, error: `api.ui.com returned HTTP ${httpStatus}: ${httpBody.slice(0, 200)}` });
    }

    // 2xx — parse sensor count from the live response
    const sensors = await fetchAllUnifiSensors(apiKey, hostId);
    return res.json({ connected: true, sensorCount: sensors?.length ?? 0 });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.json({ connected: false, error: `Network error reaching api.ui.com: ${msg}` });
  }
});

// ── GET /api/v1/sensors/discover ──────────────────────────────────────────────
// Lists all sensors from the UniFi cloud API using the server-side UNIFI_API_KEY.
// Used by the Sensor Configuration UI to discover devices before assigning them.
//
// Returns: { sensors: UnifiDiscoveredSensor[] }

router.get("/discover", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const apiKey = process.env.UNIFI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "UNIFI_API_KEY is not configured on this server" });
  }

  const hostId = process.env.UNIFI_HOST_ID;
  if (!hostId) {
    return res.status(503).json({ error: "UNIFI_HOST_ID is not configured — use GET /sensors/test-connection to discover your console ID" });
  }

  const sensors = await fetchAllUnifiSensors(apiKey, hostId);
  if (sensors === null) {
    return res.status(502).json({
      error: "Could not reach Protect console via api.ui.com — check UNIFI_API_KEY and UNIFI_HOST_ID",
    });
  }

  logger.info({ count: sensors.length }, "UniFi sensor discovery completed");
  return res.json({ sensors });
});

// ── GET /api/v1/sensors/devices ───────────────────────────────────────────────
// Returns all active registered sensor devices from the database, with hive name.
// Used to populate the Assigned Sensors table in Sensor Configuration.
//
// Returns: [{ id, deviceId, name, hiveId, hiveName, pollInterval, createdAt }]

router.get("/devices", requireAuth, async (req, res) => {
  const devices = await db.sensorDevice.findMany({
    where:   { isActive: true },
    orderBy: { createdAt: "asc" },
  });

  // Fetch hive names for devices that have a hiveId
  const hiveIds = [...new Set(devices.map(d => d.hiveId).filter(Boolean))] as string[];
  const hives = hiveIds.length > 0
    ? await db.hive.findMany({ where: { id: { in: hiveIds } }, select: { id: true, name: true } })
    : [];
  const hiveMap = Object.fromEntries(hives.map(h => [h.id, h.name]));

  return res.json(devices.map(d => ({
    id:           d.id,
    deviceId:     d.deviceId,
    name:         d.name,
    hiveId:       d.hiveId,
    hiveName:     d.hiveId ? (hiveMap[d.hiveId] ?? null) : null,
    pollInterval: d.pollInterval,
    locationRole: d.locationRole ?? null,
    locationNote: d.locationNote ?? null,
    createdAt:    d.createdAt,
  })));
});

// ── POST /api/v1/sensors/devices ──────────────────────────────────────────────
// Register (or update) a UniFi Protect sensor device and link it to a hive.
// Idempotent: re-registering the same unifiDeviceId updates name / hiveId / pollInterval.
//
// vendor is hardcoded as "unifi_protect" — no multi-vendor abstraction yet.
//
// Returns: the SensorDevice row (201 on create, 200 on update).

router.post("/devices", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const body = deviceSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const { hiveId, unifiDeviceId, name, pollInterval, locationRole, locationNote } = body.data;

  if (hiveId) {
    const hive = await db.hive.findUnique({ where: { id: hiveId }, select: { id: true } });
    if (!hive) return res.status(404).json({ error: "Hive not found" });
  }

  const existing = await db.sensorDevice.findFirst({
    where: { vendor: "unifi_protect", deviceId: unifiDeviceId },
  });

  if (existing) {
    const updated = await db.sensorDevice.update({
      where: { id: existing.id },
      data: {
        hiveId:       hiveId ?? null,
        name,
        pollInterval,
        isActive:     true,
        locationRole: locationRole ?? null,
        locationNote: locationNote ?? null,
      },
    });
    return res.json(updated);
  }

  const created = await db.sensorDevice.create({
    data: {
      id:           crypto.randomUUID(),
      vendor:       "unifi_protect",
      deviceId:     unifiDeviceId,
      name,
      hiveId:       hiveId ?? null,
      pollInterval,
      locationRole: locationRole ?? null,
      locationNote: locationNote ?? null,
      config:       { type: "sensor" } as unknown as Prisma.InputJsonValue,
    },
  });

  res.status(201).json(created);
});

// ── GET /api/v1/sensors/devices/generate-id ──────────────────────────────────
// Returns a unique 5-char alphanumeric device ID not currently in use.
// Avoids visually ambiguous characters (I, O, 0, 1).
// Called by the Register modal's "Generate ID" button.
//
// Returns: { deviceId: string }

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no I/O/0/1

router.get("/devices/generate-id", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const id = Array.from({ length: 5 }, () =>
      ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
    ).join('');
    const conflict = await db.sensorDevice.findUnique({ where: { deviceId: id }, select: { id: true } });
    if (!conflict) return res.json({ deviceId: id });
  }

  return res.status(500).json({ error: "Could not generate a unique ID — try again" });
});

// ── POST /api/v1/sensors/devices/register ────────────────────────────────────
// Admin path to register any MAC-based sensor device from the browser UI.
// Mirrors the hub-key-authenticated /hubs/devices/provision endpoint but
// requires a JWT (queen/worker). Used for C6 boards and any sensor that
// appears in node health without a sensor_devices row.
//
// Idempotent:
//   - If the MAC is already bound to this deviceId → update name/hive/location
//   - If the MAC is already bound to a DIFFERENT deviceId → 409
//   - If the deviceId already exists with a different MAC → relink MAC
//   - Otherwise → create new row
//
// Once created, the hub daemon picks up the MAC→deviceId mapping on its next
// cache refresh (GET /hubs/devices) so future readings carry the device ID.
//
// Returns: { device, created: boolean }

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

const registerDeviceSchema = z.object({
  deviceId:     z.string().min(1).max(50),
  mac:          z.string().regex(MAC_RE, "must be XX:XX:XX:XX:XX:XX"),
  name:         z.string().min(1).max(255),
  vendor:       z.string().min(1).max(100).default("generic"),
  hiveId:       z.string().uuid().nullable().optional(),
  locationRole: z.enum(LOCATION_ROLE_VALUES).nullable().optional(),
  locationNote: z.string().max(500).nullable().optional(),
});

router.post("/devices/register", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const body = registerDeviceSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const { deviceId, mac, name, vendor, hiveId, locationRole, locationNote } = body.data;
  const macUpper = mac.toUpperCase();

  if (hiveId) {
    const hive = await db.hive.findUnique({ where: { id: hiveId }, select: { id: true } });
    if (!hive) return res.status(404).json({ error: "Hive not found" });
  }

  try {
    // MAC conflict: if this MAC is bound to a DIFFERENT deviceId, reject
    const macConflict = await db.sensorDevice.findFirst({
      where: { currentMac: macUpper, deviceId: { not: deviceId } },
    });
    if (macConflict) {
      return res.status(409).json({
        error:                "MAC already registered to a different device ID",
        existingDeviceId:     macConflict.deviceId,
      });
    }

    // Check if deviceId already exists (relink scenario)
    const existing = await db.sensorDevice.findUnique({ where: { deviceId } });

    if (existing) {
      const updated = await db.sensorDevice.update({
        where: { id: existing.id },
        data: {
          currentMac:   macUpper,
          name,
          vendor,
          hiveId:       hiveId ?? null,
          locationRole: locationRole ?? null,
          locationNote: locationNote ?? null,
          isActive:     true,
        },
      });
      logger.info({ deviceId, mac: macUpper, relinked: existing.currentMac !== macUpper }, "sensor.admin_register.updated");
      return res.json({ device: updated, created: false });
    }

    const created = await db.sensorDevice.create({
      data: {
        id:           crypto.randomUUID(),
        deviceId,
        currentMac:   macUpper,
        vendor,
        name,
        hiveId:       hiveId ?? null,
        locationRole: locationRole ?? null,
        locationNote: locationNote ?? null,
        provisionedAt: new Date(),
        config:        { type: "sensor", registered_via: "admin_ui" } as unknown as Prisma.InputJsonValue,
      },
    });

    logger.info({ deviceId, mac: macUpper, vendor }, "sensor.admin_register.created");
    return res.status(201).json({ device: created, created: true });

  } catch (err: any) {
    logger.error({ err: err.message, deviceId, mac: macUpper }, "sensor.admin_register.error");
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
});

// ── PATCH /api/v1/sensors/devices/:id ────────────────────────────────────────
// Partial update of any sensor device — works for all vendors (unifi_protect,
// tachyon, etc.). Only supplied fields are updated; omitted fields are unchanged.
// Used by the Node Health "Edit" modal to set name, hive, and location fields.
//
// Returns: the updated SensorDevice row.

const patchDeviceSchema = z.object({
  name:         z.string().min(1).max(255).optional(),
  hiveId:       z.string().uuid().nullable().optional(),
  locationRole: z.enum(LOCATION_ROLE_VALUES).nullable().optional(),
  locationNote: z.string().max(500).nullable().optional(),
});

router.patch("/devices/:id", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const id = String(req.params.id);
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid device ID" });
  }

  const body = patchDeviceSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const device = await db.sensorDevice.findUnique({ where: { id }, select: { id: true } });
  if (!device) return res.status(404).json({ error: "Device not found" });

  if (body.data.hiveId) {
    const hive = await db.hive.findUnique({ where: { id: body.data.hiveId }, select: { id: true } });
    if (!hive) return res.status(404).json({ error: "Hive not found" });
  }

  // Build update — only include fields explicitly present in the request body
  const data: Record<string, unknown> = {};
  if (body.data.name         !== undefined) data.name         = body.data.name;
  if (body.data.hiveId       !== undefined) data.hiveId       = body.data.hiveId;
  if (body.data.locationRole !== undefined) data.locationRole = body.data.locationRole;
  if (body.data.locationNote !== undefined) data.locationNote = body.data.locationNote;

  const updated = await db.sensorDevice.update({ where: { id }, data });
  logger.info({ deviceId: id, fields: Object.keys(data) }, "Sensor device patched");
  return res.json(updated);
});

// ── DELETE /api/v1/sensors/devices/:id ───────────────────────────────────────
// Soft-deletes a sensor device by setting isActive: false.
// Does NOT delete the row or any readings — historical data is preserved.
//
// Returns: { ok: true }

router.delete("/devices/:id", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const id = String(req.params.id);
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid device ID" });
  }

  const device = await db.sensorDevice.findUnique({ where: { id }, select: { id: true } });
  if (!device) return res.status(404).json({ error: "Device not found" });

  await db.sensorDevice.update({ where: { id }, data: { isActive: false } });
  logger.info({ deviceId: id }, "Sensor device deactivated");
  return res.json({ ok: true });
});

// ── GET /api/v1/sensors/latest?hiveId=uuid ───────────────────────────────────
// Returns the most recent sensor reading for a hive with a read-through cache.
//
// Cache strategy (fresh threshold: 60 seconds):
//   1. Check DB for a reading younger than 60 s — return immediately if found.
//   2. If stale / no reading, call the UniFi cloud API (UNIFI_API_KEY).
//      On success: store in DB, return the fresh reading.
//      On failure: fall back to the most recent DB reading, however old.
//   3. If no DB reading exists and UniFi call fails, return null.
//
// Open to all authenticated roles (spectators can view sensor data).
//
// Returns: { hiveId, deviceId, deviceName, tempF, humidity, lux, recordedAt, minutesAgo }
//          or null if the hive has no sensor device or data cannot be retrieved.
//
// minutesAgo lets the frontend flag staleness:
//   < 5  min → fresh  (green dot)
//   5–30 min → stale  (yellow)
//   > 30 min → offline (grey)

const FRESH_THRESHOLD_MS = 60_000;

function formatReading(hiveId: string, reading: {
  deviceId:  string;
  tempF:     number | null;
  humidity:  number | null;
  lux:       number | null;
  recordedAt: Date;
  device:    { name: string | null; deviceId: string };
}) {
  const minutesAgo = Math.round((Date.now() - reading.recordedAt.getTime()) / 60_000);
  return {
    hiveId,
    deviceId:   reading.deviceId,
    deviceName: reading.device.name ?? null,
    tempF:      reading.tempF,
    humidity:   reading.humidity,
    lux:        reading.lux,
    recordedAt: reading.recordedAt,
    minutesAgo,
  };
}

router.get("/latest", requireAuth, async (req, res) => {
  const hiveId = req.query.hiveId as string | undefined;
  if (!hiveId || !UUID_RE.test(hiveId)) {
    return res.status(400).json({ error: "hiveId query parameter is required (UUID)" });
  }

  // ── 1. Find active devices for this hive ──────────────────────────────────
  const devices = await db.sensorDevice.findMany({
    where:  { hiveId, isActive: true },
    select: { id: true, deviceId: true, name: true },
  });

  if (devices.length === 0) return res.json(null);

  // ── 2. Check for a fresh cached reading (< 60 s old) ─────────────────────
  const freshCutoff = new Date(Date.now() - FRESH_THRESHOLD_MS);
  const freshReading = await db.sensorReading.findFirst({
    where:   { deviceId: { in: devices.map(d => d.id) }, recordedAt: { gte: freshCutoff } },
    orderBy: { recordedAt: "desc" },
    include: { device: { select: { name: true, deviceId: true } } },
  });

  if (freshReading) {
    return res.json(formatReading(hiveId, freshReading));
  }

  // ── 3. Cache miss — call the UniFi cloud API ──────────────────────────────
  const apiKey = process.env.UNIFI_API_KEY;
  const hostId = process.env.UNIFI_HOST_ID;
  if (apiKey && hostId) {
    for (const device of devices) {
      const unifiData = await fetchUnifiSensor(device.deviceId, apiKey, hostId);
      if (!unifiData) continue;

      // Convert °C → °F and persist
      const tempF = unifiData.tempC != null ? (unifiData.tempC * 9) / 5 + 32 : null;
      const stored = await db.sensorReading.create({
        data: {
          id:         crypto.randomUUID(),
          deviceId:   device.id,
          tempF,
          humidity:   unifiData.humidity,
          lux:        unifiData.lux,
          weight:     null,
          recordedAt: new Date(),
        },
        include: { device: { select: { name: true, deviceId: true } } },
      });

      logger.info(
        { hiveId, unifiDeviceId: device.deviceId, tempF },
        "Sensor reading fetched from UniFi cloud and stored"
      );
      return res.json(formatReading(hiveId, stored));
    }

    logger.warn({ hiveId }, "UniFi cloud API returned no data — falling back to stale DB reading");
  }

  // ── 4. UniFi unavailable (no key or all calls failed) — return stale or null
  const staleReading = await db.sensorReading.findFirst({
    where:   { deviceId: { in: devices.map(d => d.id) } },
    orderBy: { recordedAt: "desc" },
    include: { device: { select: { name: true, deviceId: true } } },
  });

  if (!staleReading) return res.json(null);
  return res.json(formatReading(hiveId, staleReading));
});

// ── GET /api/v1/sensors/history ───────────────────────────────────────────────
// Returns time-series sensor readings for charting.
// Query params: hiveId (required), hours (default 168 = 7 days), limit (default 2000)

router.get("/history", requireAuth, async (req, res) => {
  const hiveId = req.query.hiveId as string | undefined;
  if (!hiveId || !UUID_RE.test(hiveId)) {
    return res.status(400).json({ error: "hiveId query parameter is required (UUID)" });
  }

  const hours = Math.min(parseInt((req.query.hours as string) || "168"), 720); // max 30 days
  const limit = Math.min(parseInt((req.query.limit as string) || "2000"), 5000);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const devices = await db.sensorDevice.findMany({
    where: { hiveId, isActive: true },
    select: { id: true },
  });

  if (devices.length === 0) return res.json([]);

  const readings = await db.sensorReading.findMany({
    where: {
      deviceId: { in: devices.map(d => d.id) },
      recordedAt: { gte: since },
    },
    orderBy: { recordedAt: "asc" },
    take: limit,
    select: { tempF: true, humidity: true, lux: true, recordedAt: true },
  });

  res.json(readings);
});

export { router as sensorsRouter };
