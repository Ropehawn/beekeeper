import { Router } from "express";
import { db } from "@beekeeper/db";
import { requireAuth, requireRole } from "../middleware/auth";

export const nodeHealthRouter = Router();

// Metrics that indicate a sensor capability is present
const BME_METRICS  = new Set(["temperature_c", "humidity_pct", "pressure_pa"]);
const HX_METRICS   = new Set(["weight_g", "hx711_raw_counts"]);
const MIC_METRICS  = new Set(["audio_rms_dbfs", "audio_peak_dbfs",
                               "audio_band_low_dbfs", "audio_band_midlow_dbfs",
                               "audio_band_midhigh_dbfs", "audio_band_high_dbfs"]);

// Metrics we surface in the response
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

      // Single query: newest-first, only the fields we need.
      // We reduce in-memory rather than using a GROUP BY so the query stays
      // on a single covered index (recordedAt DESC).
      const rows = await db.sensorReadingRaw.findMany({
        where: { recordedAt: { gte: since } },
        select: {
          deviceMac:  true,
          vendor:     true,
          metric:     true,
          value:      true,
          signalRssi: true,
          recordedAt: true,
        },
        orderBy: { recordedAt: "desc" },
      });

      // Per-device accumulator
      interface DeviceAccum {
        deviceMac:  string;
        vendor:     string;
        signalRssi: number | null;
        lastSeenAt: Date;
        // Latest value per tracked metric (first hit wins because rows are newest-first)
        metrics:    Partial<Record<TrackedMetric, number>>;
        // Capability flags inferred from any row for this device in the window
        hasBme:     boolean;
        hasHx:      boolean;
        hasMic:     boolean;
      }

      const accum = new Map<string, DeviceAccum>();
      const now = Date.now();

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

        // Track capability flags from every row (a device may not send all
        // metrics in every advertisement burst)
        if (BME_METRICS.has(row.metric))  dev.hasBme = true;
        if (HX_METRICS.has(row.metric))   dev.hasHx  = true;
        if (MIC_METRICS.has(row.metric))  dev.hasMic = true;

        // Capture latest value per tracked metric (rows are newest-first;
        // first time we see a metric = most recent reading)
        const m = row.metric as TrackedMetric;
        if (TRACKED_METRICS.includes(m) && !(m in dev.metrics)) {
          dev.metrics[m] = row.value;
        }
      }

      // Build response items
      const items = [...accum.values()].map((dev) => {
        const ageSec = Math.floor((now - dev.lastSeenAt.getTime()) / 1000);
        // Green: < 15 s   Yellow: 15–60 s   Red: > 60 s
        const status: "green" | "yellow" | "red" =
          ageSec < 15 ? "green" : ageSec < 60 ? "yellow" : "red";

        return {
          deviceMac:    dev.deviceMac,
          vendor:       dev.vendor,
          signalRssi:   dev.signalRssi,
          lastSeenAt:   dev.lastSeenAt.toISOString(),
          ageSec,
          status,
          // Latest metric values (undefined keys omitted by JSON.stringify)
          temperature_c:    dev.metrics.temperature_c    ?? null,
          humidity_pct:     dev.metrics.humidity_pct     ?? null,
          pressure_pa:      dev.metrics.pressure_pa      ?? null,
          weight_g:         dev.metrics.weight_g         ?? null,
          hx711_raw_counts: dev.metrics.hx711_raw_counts ?? null,
          audio_rms_dbfs:   dev.metrics.audio_rms_dbfs   ?? null,
          // Capability flags
          bme:  dev.hasBme,
          hx:   dev.hasHx,
          mic:  dev.hasMic,
        };
      });

      // Sort worst-first: red → yellow → green, then by ageSec desc within tier
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
