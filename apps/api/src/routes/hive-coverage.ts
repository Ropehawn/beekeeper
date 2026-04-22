// apps/api/src/routes/hive-coverage.ts
//
// GET /api/v1/hives/coverage/:hiveId  — single hive
// GET /api/v1/hives/coverage          — all active hives
//
// For every hive, compute which of the four sensing buckets
// (internalClimate, externalClimate, scale, audio) are covered
// by sensors assigned to it, drawing from BOTH sensor tables:
//
//   sensor_devices  — UniFi Protect + manually registered sensors
//   sensor_registry — BLE/Tachyon sensors provisioned via the hub flow
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

// ── Normalised device shape — same for both sensor tables ─────────────────────

interface RawDevice {
  id:                string;
  deviceId:          string;   // short identifier printed on label (e.g. "4AYHX")
  name:              string;   // display name
  hiveId:            string | null;
  locationRole:      string | null;
  deploymentProfile: string | null;
}

// ── Fetch from both tables and normalise ──────────────────────────────────────

async function fetchDevicesForHives(hiveIds: string[]): Promise<RawDevice[]> {
  const [devices, registry] = await Promise.all([
    // sensor_devices: UniFi Protect + manually registered
    db.sensorDevice.findMany({
      where:  { hiveId: { in: hiveIds }, isActive: true },
      select: { id: true, deviceId: true, name: true, hiveId: true,
                locationRole: true, deploymentProfile: true },
    }),

    // sensor_registry: BLE/Tachyon sensors provisioned via the hub
    // lifecycleStatus filters: exclude retired sensors
    db.sensorRegistry.findMany({
      where:  {
        hiveId:          { in: hiveIds },
        lifecycleStatus: { notIn: ["retired"] },
      },
      select: { id: true, deviceIdentifier: true, name: true, hiveId: true,
                locationRole: true, deploymentProfile: true },
    }),
  ]);

  const fromDevices: RawDevice[] = devices.map(d => ({
    id:                d.id,
    deviceId:          d.deviceId,
    name:              d.name ?? d.deviceId,
    hiveId:            d.hiveId ?? null,
    locationRole:      d.locationRole      ?? null,
    deploymentProfile: d.deploymentProfile ?? null,
  }));

  const fromRegistry: RawDevice[] = registry.map(r => ({
    id:                r.id,
    deviceId:          r.deviceIdentifier,
    name:              r.name,
    hiveId:            r.hiveId ?? null,
    locationRole:      r.locationRole      ?? null,
    deploymentProfile: r.deploymentProfile ?? null,
  }));

  return [...fromDevices, ...fromRegistry];
}

// ── Build coverage item for one hive ─────────────────────────────────────────

function buildCoverageItem(
  hive: { id: string; name: string },
  hiveDevices: RawDevice[],
) {
  const bucketDevices = new Map<string, RawDevice[]>();
  for (const { key } of BUCKET_DEFS) bucketDevices.set(key, []);

  for (const d of hiveDevices) {
    for (const b of bucketsFor(d.deploymentProfile)) {
      bucketDevices.get(b)?.push(d);
    }
  }

  const deviceEntry = (d: RawDevice) => ({
    id:                d.id,
    name:              d.name,
    deviceId:          d.deviceId,
    locationRole:      d.locationRole,
    deploymentProfile: d.deploymentProfile,
  });

  const buckets = BUCKET_DEFS.map(({ key, label }) => {
    const list = bucketDevices.get(key) ?? [];
    return { key, label, covered: list.length > 0, devices: list.map(deviceEntry) };
  });

  return {
    hiveId:              hive.id,
    hiveName:            hive.name,
    assignedCount:       hiveDevices.length,
    withoutProfileCount: hiveDevices.filter(d =>
      !d.deploymentProfile || d.deploymentProfile === "custom"
    ).length,
    buckets,
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/v1/hives/coverage/:hiveId — single-hive coverage (used by hive detail page)
hiveCoverageRouter.get(
  "/coverage/:hiveId",
  requireAuth,
  requireRole("queen", "worker"),
  async (req, res) => {
    try {
      const hiveId = String(req.params.hiveId);
      const hive = await db.hive.findUnique({
        where:  { id: hiveId },
        select: { id: true, name: true, status: true },
      });
      if (!hive || hive.status !== "active") {
        return res.status(404).json({ error: "Hive not found" });
      }
      const devices = await fetchDevicesForHives([hiveId]);
      return res.json(buildCoverageItem(hive, devices));
    } catch (err) {
      return res.status(500).json({ error: "Failed to load hive coverage" });
    }
  },
);

// GET /api/v1/hives/coverage — all active hives
hiveCoverageRouter.get(
  "/coverage",
  requireAuth,
  requireRole("queen", "worker"),
  async (_req, res) => {
    try {
      const hives = await db.hive.findMany({
        where:   { status: "active" },
        select:  { id: true, name: true },
        orderBy: { name: "asc" },
      });

      if (hives.length === 0) {
        return res.json({ items: [], count: 0 });
      }

      const hiveIds = hives.map(h => h.id);

      const allDevices = await fetchDevicesForHives(hiveIds);

      // Index by hiveId for O(1) lookup
      const devicesByHive = new Map<string, RawDevice[]>();
      for (const d of allDevices) {
        if (!d.hiveId) continue;
        if (!devicesByHive.has(d.hiveId)) devicesByHive.set(d.hiveId, []);
        devicesByHive.get(d.hiveId)!.push(d);
      }

      const items = hives.map(hive => {
        const item = buildCoverageItem(hive, devicesByHive.get(hive.id) ?? []);
        return { ...item, _missingCount: item.buckets.filter(b => !b.covered).length };
      });

      items.sort((a, b) => {
        const diff = b._missingCount - a._missingCount;
        if (diff !== 0) return diff;
        return a.hiveName.localeCompare(b.hiveName);
      });

      const payload = items.map(({ _missingCount: _mc, ...rest }) => rest);
      return res.json({ items: payload, count: payload.length });

    } catch (err) {
      return res.status(500).json({ error: "Failed to load hive coverage" });
    }
  },
);
