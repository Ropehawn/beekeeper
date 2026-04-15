import { Router } from "express";
import { db } from "@beekeeper/db";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { logger } from "../lib/logger";
import { fetchAllUnifiCameras, fetchCameraSnapshot } from "../lib/unifi-client";

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const deviceSchema = z.object({
  hiveId:        z.string().uuid().optional(),
  unifiDeviceId: z.string().min(1).max(255),
  name:          z.string().min(1).max(255),
});

// ── GET /api/v1/cameras/discover ─────────────────────────────────────────────
// Lists all cameras on the UniFi Protect console.

router.get("/discover", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const apiKey = process.env.UNIFI_API_KEY;
  const hostId = process.env.UNIFI_HOST_ID;
  if (!apiKey || !hostId) {
    return res.status(503).json({ error: "UniFi Protect not configured (UNIFI_API_KEY / UNIFI_HOST_ID)" });
  }

  const cameras = await fetchAllUnifiCameras(apiKey, hostId);
  if (!cameras) {
    return res.status(502).json({ error: "Could not reach UniFi Protect — check connection" });
  }

  res.json({ cameras });
});

// ── GET /api/v1/cameras/devices ──────────────────────────────────────────────
// List registered camera devices with hive names.

router.get("/devices", requireAuth, async (_req, res) => {
  const devices = await db.cameraDevice.findMany({
    where: { isActive: true },
    include: { hive: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });

  res.json(devices.map(d => ({
    id:            d.id,
    unifiDeviceId: d.unifiDeviceId,
    name:          d.name,
    hiveId:        d.hiveId,
    hiveName:      d.hive?.name ?? null,
    createdAt:     d.createdAt,
  })));
});

// ── POST /api/v1/cameras/devices ─────────────────────────────────────────────
// Register or update a camera device (upsert by unifiDeviceId).

router.post("/devices", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const body = deviceSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid input", details: body.error.flatten() });
  }

  const { unifiDeviceId, name, hiveId } = body.data;

  // Upsert: if a device with this unifiDeviceId already exists, update it
  const existing = await db.cameraDevice.findFirst({
    where: { unifiDeviceId, isActive: true },
  });

  if (existing) {
    const updated = await db.cameraDevice.update({
      where: { id: existing.id },
      data: { name, hiveId: hiveId ?? null },
    });
    return res.json(updated);
  }

  const device = await db.cameraDevice.create({
    data: {
      unifiDeviceId,
      name,
      hiveId: hiveId ?? null,
    },
  });

  res.status(201).json(device);
});

// ── DELETE /api/v1/cameras/devices/:id ───────────────────────────────────────
// Soft-delete a camera device.

router.delete("/devices/:id", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role === "spectator") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  const device = await db.cameraDevice.findUnique({ where: { id: req.params.id as string } });
  if (!device) return res.status(404).json({ error: "Camera device not found" });

  await db.cameraDevice.update({
    where: { id: device.id },
    data: { isActive: false },
  });

  res.json({ deleted: true });
});

// ── GET /api/v1/cameras/snapshot/:unifiDeviceId ──────────────────────────────
// Proxy endpoint: fetches a snapshot from UniFi Protect and returns the JPEG.
// The browser loads this as an <img src="...">.

router.get("/snapshot/:unifiDeviceId", requireAuth, async (req, res) => {
  const apiKey = process.env.UNIFI_API_KEY;
  const hostId = process.env.UNIFI_HOST_ID;
  if (!apiKey || !hostId) {
    return res.status(503).json({ error: "UniFi Protect not configured" });
  }

  const deviceId = req.params.unifiDeviceId as string;
  const buffer = await fetchCameraSnapshot(deviceId, apiKey, hostId);
  if (!buffer) {
    logger.warn({ deviceId }, "Snapshot fetch returned null — UniFi Protect may be unreachable or camera offline");
    return res.status(502).json({ error: "Could not fetch snapshot from UniFi Protect" });
  }

  res.set({
    "Content-Type":  "image/jpeg",
    "Cache-Control": "public, max-age=2",
    "Content-Length": String(buffer.length),
  });
  res.send(buffer);
});

// ── GET /api/v1/cameras/debug-snapshot/:unifiDeviceId ─────────────────────────
// Debug endpoint: tests multiple URL patterns and returns status codes.

router.get("/debug-snapshot/:unifiDeviceId", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.role !== "queen") {
    return res.status(403).json({ error: "Queen role required" });
  }

  const apiKey = process.env.UNIFI_API_KEY;
  const hostId = process.env.UNIFI_HOST_ID;
  if (!apiKey || !hostId) {
    return res.json({ error: "Not configured" });
  }

  const cameraId = req.params.unifiDeviceId as string;
  const urls = [
    `https://api.ui.com/v1/connector/consoles/${hostId}/proxy/protect/integration/v1/cameras/${cameraId}/snapshot`,
    `https://api.ui.com/v1/connector/consoles/${hostId}/proxy/protect/integration/v1/cameras/${cameraId}/snapshot?highQuality=false`,
    `https://api.ui.com/v1/connector/consoles/${hostId}/proxy/protect/api/cameras/${cameraId}/snapshot`,
    `https://api.ui.com/v1/connector/consoles/${hostId}/proxy/protect/v1/cameras/${cameraId}/snapshot`,
    `https://api.ui.com/v1/connector/consoles/${hostId}/proxy/protect/cameras/${cameraId}/snapshot`,
  ];

  const results = [];
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(url, {
        method: "GET",
        headers: { "X-API-Key": apiKey },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const ct = r.headers.get("content-type") || "";
      const size = r.headers.get("content-length") || "unknown";
      results.push({ url: url.replace(apiKey, "***"), status: r.status, contentType: ct, size });
    } catch (e: unknown) {
      results.push({ url: url.replace(apiKey, "***"), error: e instanceof Error ? e.message : String(e) });
    }
  }

  res.json({ cameraId, hostId: hostId.substring(0, 20) + "...", results });
});

export { router as camerasRouter };
