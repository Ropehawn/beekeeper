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

// ── Coverage bucket keys ──────────────────────────────────────────────────────

type BucketKey = "internalClimate" | "externalClimate" | "scale" | "audio";
const BUCKETS: BucketKey[] = ["internalClimate", "externalClimate", "scale", "audio"];

// ── deploymentProfile → which buckets it satisfies ───────────────────────────
// custom and null contribute nothing in v1 — explicit rather than silent.

const PROFILE_BUCKETS: Record<string, BucketKey[]> = {
  external_climate_scale_audio: ["externalClimate", "scale", "audio"],
  internal_climate:             ["internalClimate"],
  ambient_reference:            ["externalClimate"],
  scale_only:                   ["scale"],
  audio_only:                   ["audio"],
  custom:                       [],
};

function bucketsFor(profile: string | null): BucketKey[] {
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

        // Per-bucket device lists
        const bucketDevices: Record<BucketKey, typeof devices> = {
          internalClimate: [],
          externalClimate: [],
          scale:           [],
          audio:           [],
        };

        for (const d of hiveDevices) {
          const covered = bucketsFor(d.deploymentProfile);
          for (const b of covered) {
            bucketDevices[b].push(d);
          }
        }

        // Coverage flags
        const coverage: Record<BucketKey, boolean> = {
          internalClimate: bucketDevices.internalClimate.length > 0,
          externalClimate: bucketDevices.externalClimate.length > 0,
          scale:           bucketDevices.scale.length > 0,
          audio:           bucketDevices.audio.length > 0,
        };

        // Serialise device lists to a clean shape
        const deviceEntry = (d: typeof devices[number]) => ({
          id:                d.id,
          name:              d.name ?? d.deviceId,
          deviceId:          d.deviceId,
          locationRole:      d.locationRole      ?? null,
          deploymentProfile: d.deploymentProfile ?? null,
        });

        return {
          hiveId:   hive.id,
          hiveName: hive.name,
          coverage,
          devices: {
            internalClimate: bucketDevices.internalClimate.map(deviceEntry),
            externalClimate: bucketDevices.externalClimate.map(deviceEntry),
            scale:           bucketDevices.scale.map(deviceEntry),
            audio:           bucketDevices.audio.map(deviceEntry),
          },
          // Derived: count of missing buckets — used for sort by caller
          _missingCount: BUCKETS.filter(b => !coverage[b]).length,
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
