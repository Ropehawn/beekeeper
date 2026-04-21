import { Router } from "express";
import { db } from "@beekeeper/db";
import { requireAuth, requireRole } from "../middleware/auth";

export const nodeHealthRouter = Router();

// Metrics that indicate a sensor capability is present
const BME_METRICS = new Set(["temperature_c", "humidity_pct", "pressure_pa"]);
const HX_METRICS  = new Set(["weight_g", "hx711_raw_counts"]);
const MIC_METRICS = new Set([
  "audio_rms_dbfs", "audio_peak_dbfs",
  "audio_band_low_dbfs", "audio_band_midlow_dbfs",
  "audio_band_midhigh_dbfs", "audio_band_high_dbfs",
]);

const TRACKED_METRICS = [
  "temperature_c",
  "humidity_pct",
  "pressure_pa",
  "weight_g",
  "hx711_raw_counts",
  "audio_rms_dbfs",
] as const;
type TrackedMetric = typeof TRACKED_METRICS[number];

nodeHealthRouter.get(
  "/node-health",
  requireAuth,
  requireRole("queen", "worker"),
  async (_req, res) => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // ── 1. Fetch all readings from the last 24 h ─────────────────────────
      const rows = await db.sensorReadingRaw.findMany({
        where:   { recordedAt: { gte: since } },
        select:  {
          deviceMac:  true,
          vendor:     true,
          metric:     true,
          value:      true,
          signalRssi: true,
          recordedAt: true,
        },
        orderBy: { recordedAt: "desc" },
      });

      // ── 2. Reduce rows → one accumulator per deviceMac ───────────────────
      interface DeviceAccum {
        deviceMac:  string;
        vendor:     string;
        signalRssi: number | null;
        lastSeenAt: Date;
        metrics:    Partial<Record<TrackedMetric, number>>;
        hasBme:     boolean;
        hasHx:      boolean;
        hasMic:     boolean;
      }

      const accum = new Map<string, DeviceAccum>();

      for (const row of rows) {
        const mac = row.deviceMac ?? "unknown";

        if (!accum.has(mac)) {
          accum.set(mac, {
            deviceMac:  mac,
            vendor:     row.vendor,
            signalRssi: row.signalRssi ?? null,
            lastSeenAt: row.recordedAt,
            metrics:    {},
            hasBme:     false,
            hasHx:      false,
            hasMic:     false,
          });
        }

        const dev = accum.get(mac)!;

        if (BME_METRICS.has(row.metric)) dev.hasBme = true;
        if (HX_METRICS.has(row.metric))  dev.hasHx  = true;
        if (MIC_METRICS.has(row.metric)) dev.hasMic = true;

        const m = row.metric as TrackedMetric;
        if (TRACKED_METRICS.includes(m) && !(m in dev.metrics)) {
          dev.metrics[m] = row.value;
        }
      }

      // ── 3. Resolve hive context via sensor_devices.currentMac ────────────
      const macs = [...accum.keys()].filter((m) => m !== "unknown");

      // Batch lookup: SensorDevice where currentMac IN macs
      const devices = macs.length
        ? await db.sensorDevice.findMany({
            where:  { currentMac: { in: macs } },
            select: {
              id: true, deviceId: true, currentMac: true,
              hiveId: true, name: true, locationRole: true, locationNote: true,
              deploymentProfile: true,
            },
          })
        : [];

      // Build mac → context map
      const macToDevice = new Map<string, {
        sensorDeviceId:   string;
        sensorQrId:       string;
        hiveId:           string | null;
        deviceLabel:      string | null;
        locationRole:     string | null;
        locationNote:     string | null;
        deploymentProfile: string | null;
      }>();
      const hiveIdSet   = new Set<string>();
      for (const d of devices) {
        if (!d.currentMac) continue;
        macToDevice.set(d.currentMac.toUpperCase(), {
          sensorDeviceId:   d.id,
          sensorQrId:       d.deviceId,
          hiveId:           d.hiveId            ?? null,
          deviceLabel:      d.name              ?? null,
          locationRole:     d.locationRole      ?? null,
          locationNote:     d.locationNote      ?? null,
          deploymentProfile: d.deploymentProfile ?? null,
        });
        if (d.hiveId) hiveIdSet.add(d.hiveId);
      }

      // Batch lookup: Hive names
      const hives = hiveIdSet.size
        ? await db.hive.findMany({
            where:  { id: { in: [...hiveIdSet] } },
            select: { id: true, name: true },
          })
        : [];

      const hiveIdToName = new Map<string, string>(hives.map((h) => [h.id, h.name]));

      // ── 4. Build response items ───────────────────────────────────────────
      const now = Date.now();

      const items = [...accum.values()].map((dev) => {
        const ageSec = Math.floor((now - dev.lastSeenAt.getTime()) / 1000);
        // green < 15 s   yellow 15–60 s   red > 60 s
        const status: "green" | "yellow" | "red" =
          ageSec < 15 ? "green" : ageSec < 60 ? "yellow" : "red";

        const macUpper        = dev.deviceMac.toUpperCase();
        const devEntry        = macToDevice.get(macUpper);
        const sensorDeviceId  = devEntry?.sensorDeviceId  ?? null;
        const sensorQrId      = devEntry?.sensorQrId      ?? null;
        const hiveId          = devEntry?.hiveId          ?? null;
        const hiveName        = hiveId ? (hiveIdToName.get(hiveId) ?? null) : null;
        const deviceLabel     = devEntry?.deviceLabel      ?? null;
        const locationRole    = devEntry?.locationRole     ?? null;
        const locationNote    = devEntry?.locationNote     ?? null;
        const deploymentProfile = devEntry?.deploymentProfile ?? null;

        return {
          deviceMac:    dev.deviceMac,
          vendor:       dev.vendor,
          signalRssi:   dev.signalRssi,
          lastSeenAt:   dev.lastSeenAt.toISOString(),
          ageSec,
          status,
          // Device identity
          sensorDeviceId,
          sensorQrId,
          // Hive context
          hiveId,
          hiveName,
          deviceLabel,
          locationRole,
          locationNote,
          deploymentProfile,
          // Latest metric values
          temperature_c:    dev.metrics.temperature_c    ?? null,
          humidity_pct:     dev.metrics.humidity_pct     ?? null,
          pressure_pa:      dev.metrics.pressure_pa      ?? null,
          weight_g:         dev.metrics.weight_g         ?? null,
          hx711_raw_counts: dev.metrics.hx711_raw_counts ?? null,
          audio_rms_dbfs:   dev.metrics.audio_rms_dbfs   ?? null,
          // Capability flags
          bme: dev.hasBme,
          hx:  dev.hasHx,
          mic: dev.hasMic,
        };
      });

      // Worst-first: red → yellow → green, then by ageSec desc within tier
      const statusOrder: Record<string, number> = { red: 0, yellow: 1, green: 2 };
      items.sort((a, b) => {
        const so = statusOrder[a.status] - statusOrder[b.status];
        return so !== 0 ? so : b.ageSec - a.ageSec;
      });

      res.json({ items, count: items.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to load node health" });
    }
  }
);
