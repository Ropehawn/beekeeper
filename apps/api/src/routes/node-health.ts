import { Router } from "express";
import { db } from "@beekeeper/db";
import { requireAuth, requireRole } from "../middleware/auth";

export const nodeHealthRouter = Router();

nodeHealthRouter.get(
  "/node-health",
  requireAuth,
  requireRole("queen", "worker"),
  async (_req, res) => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Fetch all readings in the last 24h, newest first.
      // We only need the latest record per deviceMac, so we select the minimum
      // set of fields and reduce in-memory to avoid a GROUP BY / window query.
      const rows = await db.sensorReadingRaw.findMany({
        where: { recordedAt: { gte: since } },
        select: {
          deviceMac:  true,
          vendor:     true,
          signalRssi: true,
          recordedAt: true,
        },
        orderBy: { recordedAt: "desc" },
      });

      // Reduce to one snapshot per deviceMac (first occurrence = latest due to sort)
      const seen = new Map<string, {
        deviceMac:  string;
        vendor:     string;
        signalRssi: number | null;
        lastSeenAt: string;
        ageSec:     number;
        status:     "green" | "yellow" | "red";
      }>();

      const now = Date.now();

      for (const row of rows) {
        const mac = row.deviceMac ?? "unknown";
        if (seen.has(mac)) continue;

        const ageSec = Math.floor((now - row.recordedAt.getTime()) / 1000);
        // Green: seen within last 10 min, Yellow: 10–60 min, Red: >60 min
        const status: "green" | "yellow" | "red" =
          ageSec < 600 ? "green" : ageSec < 3600 ? "yellow" : "red";

        seen.set(mac, {
          deviceMac:  mac,
          vendor:     row.vendor,
          signalRssi: row.signalRssi ?? null,
          lastSeenAt: row.recordedAt.toISOString(),
          ageSec,
          status,
        });
      }

      // Sort worst-first: red → yellow → green, then by age descending within tier
      const statusOrder: Record<string, number> = { red: 0, yellow: 1, green: 2 };
      const items = [...seen.values()].sort((a, b) => {
        const so = statusOrder[a.status] - statusOrder[b.status];
        return so !== 0 ? so : b.ageSec - a.ageSec;
      });

      res.json({ items, count: items.length });
    } catch (err) {
      res.status(500).json({ error: "Failed to load node health" });
    }
  }
);
