// apps/api/src/routes/hive-coverage.ts
//
// GET /api/v1/hives/coverage
//
// For every hive, compute which of the four sensing buckets
// (internalClimate, externalClimate, scale, audio) are covered
// by the active SensorDevices assigned to it, using deploymentProfile
// as the authoritative source of that mapping.
//
// Auth:   requireAuth + requireRole("queen", "worker")
// Stable: additive-only — no schema changes, reads existing columns.

import { Router } from "express";
import { db } from "@beekeeper/db";
import { requireAuth, requireRole } from "../middleware/auth";

export const hiveCoverageRouter = Router();

// ── Coverage bucket definitions ───────────────────────────────────────────────
// Ordered list — determines display order on the client.
// Adding a new bucket here is the only change needed to add it everywhere.

interface BucketDef {
  key:   string;
  label: string;
}

const BUCKET_DEFS: BucketDef[] = [
  { key: "internalClimate", label: "Internal Climate"  },
  { key: "externalClimate", label: "External Climate"  },
  { key: "scale",           label: "Scale"             },
  { key: "audio",           label: "Audio"             },
];

// ── deploymentProfile → which bucket keys it satisfies ───────────────────────
// custom and null contribute nothing in v1 — explicit rather than silent.

const PROFILE_BUCKETS: Record<string, string[]> = {
  external_climate_scale_audio: ["externalClimate", "scale", "audio"],
  internal_climate:             ["internalClimate"],
  ambient_reference:            ["externalClimate"],
  scale_only:                   ["scale"],
  audio_only:                   ["audio"],
  custom:                       [],
};

function bucketsFor(profile: string | null): string[] {
  if (!profile) return [];
  return PROFILE_BUCKETS[profile] ?? [];
}

// ── Route ─────────────────────────────────────────────────────────────────────

hiveCoverageRouter.get(
  "/coverage",
  requireAuth,
  requireRole("queen", "worker"),
  async (_req, res) => {
    try {
      // ── 1. Load all hives ───────────────────────────────────────────────────
      const hives = await db.hive.findMany({
        where:   { status: "active" },
        select:  { id: true, name: true },
        orderBy: { name: "asc" },
      });

      if (hives.length === 0) {
        return res.json({ items: [], count: 0 });
      }

      const hiveIds = hives.map(h => h.id);

      // ── 2. Load active sensor devices for these hives ───────────────────────
      const devices = await db.sensorDevice.findMany({
        where: {
          hiveId:   { in: hiveIds },
          isActive: true,
        },
        select: {
          id:                true,
          deviceId:          true,
          name:              true,
          hiveId:            true,
          locationRole:      true,
          deploymentProfile: true,
        },
      });

      // Index devices by hiveId for O(1) lookup
      const devicesByHive = new Map<string, typeof devices>();
      for (const d of devices) {
        if (!d.hiveId) continue;
        if (!devicesByHive.has(d.hiveId)) devicesByHive.set(d.hiveId, []);
        devicesByHive.get(d.hiveId)!.push(d);
      }

      // ── 3. Build coverage items ─────────────────────────────────────────────
      const items = hives.map(hive => {
        const hiveDevices = devicesByHive.get(hive.id) ?? [];

        // Per-bucket device accumulator (keyed by bucket key string)
        const bucketDevices = new Map<string, typeof devices>();
        for (const { key } of BUCKET_DEFS) bucketDevices.set(key, []);

        for (const d of hiveDevices) {
          for (const b of bucketsFor(d.deploymentProfile)) {
            bucketDevices.get(b)?.push(d);
          }
        }

        // Serialise device to clean shape
        const deviceEntry = (d: typeof devices[number]) => ({
          id:                d.id,
          name:              d.name ?? d.deviceId,
          deviceId:          d.deviceId,
          locationRole:      d.locationRole      ?? null,
          deploymentProfile: d.deploymentProfile ?? null,
        });

        // Build the ordered buckets array — labels come from BUCKET_DEFS, not the client
        const buckets = BUCKET_DEFS.map(({ key, label }) => {
          const list = bucketDevices.get(key) ?? [];
          return {
            key,
            label,
            covered: list.length > 0,
            devices: list.map(deviceEntry),
          };
        });

        const missingCount       = buckets.filter(b => !b.covered).length;
        const assignedCount      = hiveDevices.length;
        const withoutProfileCount = hiveDevices.filter(d => !d.deploymentProfile || d.deploymentProfile === "custom").length;

        return {
          hiveId:              hive.id,
          hiveName:            hive.name,
          assignedCount,
          withoutProfileCount,
          buckets,
          _missingCount: missingCount,
        };
      });

      // ── 4. Sort worst-first (most missing buckets), then alpha by name ──────
      items.sort((a, b) => {
        const diff = b._missingCount - a._missingCount;
        if (diff !== 0) return diff;
        return a.hiveName.localeCompare(b.hiveName);
      });

      // Strip the internal sort key before sending
      const payload = items.map(({ _missingCount: _mc, ...rest }) => rest);

      return res.json({ items: payload, count: payload.length });

    } catch (err) {
      return res.status(500).json({ error: "Failed to load hive coverage" });
    }
  },
);
