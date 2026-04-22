// apps/api/src/routes/hive-coverage.ts
//
// GET /api/v1/hives/status/:hiveId    — per-sensor live status + readings (hive detail page)
// GET /api/v1/hives/coverage/:hiveId  — single hive bucket coverage
// GET /api/v1/hives/coverage          — all active hives coverage (coverage dashboard)
//
// Draws from BOTH sensor tables:
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

  // allDevices: every sensor assigned to this hive, regardless of profile.
  // The client uses this to show assigned sensors even when none cover a bucket.
  const allDevices = hiveDevices.map(deviceEntry);

  return {
    hiveId:              hive.id,
    hiveName:            hive.name,
    assignedCount:       hiveDevices.length,
    withoutProfileCount: hiveDevices.filter(d =>
      !d.deploymentProfile || d.deploymentProfile === "custom"
    ).length,
    allDevices,
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

// ── Human-friendly label maps ──────────────────────────────────────────────────

const PROFILE_LABELS: Record<string, string> = {
  internal_climate:             "Internal climate",
  ambient_reference:            "Ambient reference",
  scale_only:                   "Scale",
  audio_only:                   "Audio",
  external_climate_scale_audio: "External climate + scale + audio",
  custom:                       "Custom",
};

const LOCATION_LABELS: Record<string, string> = {
  apiary_ambient:  "Apiary ambient",
  hive_exterior:   "Hive exterior",
  entrance:        "Entrance",
  inner_cover:     "Inner cover",
  brood_box_upper: "Brood box (upper)",
  brood_box_lower: "Brood box (lower)",
  honey_super:     "Honey super",
  base_scale:      "Base scale",
  under_hive:      "Under hive",
  audio_probe:     "Audio probe",
  custom:          "Custom",
};

function humanizeProfile(p: string | null): string | null {
  if (!p) return null;
  return PROFILE_LABELS[p] ?? p.replace(/_/g, " ");
}

function humanizeRole(r: string | null): string | null {
  if (!r) return null;
  return LOCATION_LABELS[r] ?? r.split("_").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// ── Reading display metadata — server controls all labels and formatting ───────

const READING_META: Record<string, { label: string; format: (v: number) => string }> = {
  temp_c:       { label: "Temperature", format: v => `${((v * 9) / 5 + 32).toFixed(1)}°F` },
  temp_f:       { label: "Temperature", format: v => `${v.toFixed(1)}°F` },
  humidity_rh:  { label: "Humidity",    format: v => `${v.toFixed(0)}%` },
  pressure_hpa: { label: "Pressure",    format: v => `${v.toFixed(0)} hPa` },
  weight_g:     { label: "Weight",      format: v => `${(v / 453.592).toFixed(2)} lb` },
  audio_rms:    { label: "Audio RMS",   format: v => `${v.toFixed(3)}` },
  lux:          { label: "Light",       format: v => `${Math.round(v)} lux` },
  battery_v:    { label: "Battery",     format: v => `${v.toFixed(2)}V` },
};

const METRIC_DISPLAY_ORDER = [
  "temp_c", "temp_f", "humidity_rh", "pressure_hpa",
  "weight_g", "audio_rms", "lux", "battery_v",
];

// ── Live status thresholds ─────────────────────────────────────────────────────

function computeLiveStatus(lastSeenAt: Date | null): "live" | "stale" | "offline" | "no_data" {
  if (!lastSeenAt) return "no_data";
  const ageS = (Date.now() - lastSeenAt.getTime()) / 1000;
  if (ageS < 15)  return "live";
  if (ageS < 60)  return "stale";
  return "offline";
}

// ── Gap summary — internal bucket keys → plain-English sentences ──────────────

const GAP_MESSAGES: Record<string, string> = {
  internalClimate: "Missing internal climate sensor",
  externalClimate: "Missing external climate reference",
  scale:           "Missing scale sensor",
  audio:           "Missing audio sensor",
};

function computeGaps(profiles: Array<string | null>): string[] {
  const covered = new Set<string>();
  for (const p of profiles) {
    for (const b of bucketsFor(p)) covered.add(b);
  }
  return Object.entries(GAP_MESSAGES)
    .filter(([key]) => !covered.has(key))
    .map(([, msg]) => msg);
}

// ── GET /api/v1/hives/status/:hiveId ──────────────────────────────────────────
// Per-sensor live status + latest readings for the hive detail page.
// Returns one entry per assigned sensor with live/stale/offline status,
// last seen, and latest readings — all labels computed server-side.

hiveCoverageRouter.get(
  "/status/:hiveId",
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

      // ── 1. Assigned sensors from both tables ─────────────────────────────
      const [unifiDevices, registryDevices] = await Promise.all([
        db.sensorDevice.findMany({
          where:  { hiveId, isActive: true },
          select: { id: true, deviceId: true, name: true,
                    locationRole: true, deploymentProfile: true },
        }),
        db.sensorRegistry.findMany({
          where:  { hiveId, lifecycleStatus: { notIn: ["retired"] } },
          select: { id: true, deviceIdentifier: true, name: true,
                    currentMacAddress: true, locationRole: true, deploymentProfile: true },
        }),
      ]);

      // ── 2. Batch-fetch readings (24 h window) ────────────────────────────
      const readingWindow  = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const unifiDeviceIds = unifiDevices.map(d => d.id);

      const [unifiReadings, rawReadings] = await Promise.all([
        unifiDeviceIds.length > 0
          ? db.sensorReading.findMany({
              where:   { deviceId: { in: unifiDeviceIds }, recordedAt: { gte: readingWindow } },
              orderBy: { recordedAt: "desc" },
              select:  { deviceId: true, tempF: true, humidity: true,
                         lux: true, weight: true, recordedAt: true },
            })
          : Promise.resolve([] as Array<{ deviceId: string; tempF: number | null; humidity: number | null; lux: number | null; weight: number | null; recordedAt: Date }>),

        db.sensorReadingRaw.findMany({
          where:   { hiveId, recordedAt: { gte: readingWindow } },
          orderBy: { recordedAt: "desc" },
          select:  { deviceMac: true, deviceId: true, metric: true,
                     value: true, unit: true, recordedAt: true },
        }),
      ]);

      // ── 3. Index readings for O(1) lookup ────────────────────────────────

      const latestUnifi = new Map<string, typeof unifiReadings[number]>();
      for (const r of unifiReadings) {
        if (!latestUnifi.has(r.deviceId)) latestUnifi.set(r.deviceId, r);
      }

      type RawRow = typeof rawReadings[number];
      const rawByMac:        Map<string, Map<string, RawRow>> = new Map();
      const rawByDeviceUuid: Map<string, Map<string, RawRow>> = new Map();

      for (const r of rawReadings) {
        if (r.deviceMac) {
          if (!rawByMac.has(r.deviceMac)) rawByMac.set(r.deviceMac, new Map());
          const m = rawByMac.get(r.deviceMac)!;
          if (!m.has(r.metric)) m.set(r.metric, r);
        }
        if (r.deviceId) {
          if (!rawByDeviceUuid.has(r.deviceId)) rawByDeviceUuid.set(r.deviceId, new Map());
          const m = rawByDeviceUuid.get(r.deviceId)!;
          if (!m.has(r.metric)) m.set(r.metric, r);
        }
      }

      // ── 4. Helpers ───────────────────────────────────────────────────────

      function buildReadings(
        metricMap: Map<string, RawRow> | undefined,
      ): Array<{ label: string; displayValue: string; recordedAt: string }> {
        if (!metricMap) return [];
        return [...metricMap.entries()]
          .filter(([metric]) => READING_META[metric] != null)
          .sort(([a], [b]) => {
            const ai = METRIC_DISPLAY_ORDER.indexOf(a);
            const bi = METRIC_DISPLAY_ORDER.indexOf(b);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          })
          .map(([metric, row]) => ({
            label:        READING_META[metric].label,
            displayValue: READING_META[metric].format(row.value),
            recordedAt:   row.recordedAt.toISOString(),
          }));
      }

      function latestTimestamp(metricMap: Map<string, RawRow> | undefined): Date | null {
        if (!metricMap || metricMap.size === 0) return null;
        return [...metricMap.values()].reduce<Date | null>(
          (best, r) => (!best || r.recordedAt > best ? r.recordedAt : best),
          null,
        );
      }

      // ── 5. Build sensor entries ──────────────────────────────────────────

      const sensors: object[] = [];

      for (const d of unifiDevices) {
        const unifi      = latestUnifi.get(d.id);
        const rawMap     = rawByDeviceUuid.get(d.id);
        const rawLastSeen = latestTimestamp(rawMap);
        const lastSeenAt = [unifi?.recordedAt ?? null, rawLastSeen]
          .filter((t): t is Date => t != null)
          .reduce<Date | null>((best, t) => (!best || t > best ? t : best), null);

        const readings: Array<{ label: string; displayValue: string; recordedAt: string }> = [];
        if (unifi) {
          const ts = unifi.recordedAt.toISOString();
          if (unifi.tempF    != null) readings.push({ label: "Temperature", displayValue: `${unifi.tempF.toFixed(1)}°F`,              recordedAt: ts });
          if (unifi.humidity != null) readings.push({ label: "Humidity",    displayValue: `${unifi.humidity.toFixed(0)}%`,            recordedAt: ts });
          if (unifi.lux      != null) readings.push({ label: "Light",       displayValue: `${Math.round(unifi.lux)} lux`,             recordedAt: ts });
          if (unifi.weight   != null) readings.push({ label: "Weight",      displayValue: `${(unifi.weight / 453.592).toFixed(2)} lb`, recordedAt: ts });
        }
        const existingLabels = new Set(readings.map(r => r.label));
        for (const r of buildReadings(rawMap)) {
          if (!existingLabels.has(r.label)) readings.push(r);
        }

        sensors.push({
          id:               d.id,
          name:             d.name ?? d.deviceId,
          deviceId:         d.deviceId,
          source:           "unifi",
          profileLabel:     humanizeProfile(d.deploymentProfile ?? null),
          locationRoleLabel: humanizeRole(d.locationRole ?? null),
          liveStatus:       computeLiveStatus(lastSeenAt),
          lastSeenAt:       lastSeenAt?.toISOString() ?? null,
          lastSeenAgo:      lastSeenAt ? Math.round((Date.now() - lastSeenAt.getTime()) / 1000) : null,
          readings,
        });
      }

      for (const d of registryDevices) {
        const mac        = d.currentMacAddress;
        const rawMap     = mac ? rawByMac.get(mac) : undefined;
        const lastSeenAt = latestTimestamp(rawMap);

        sensors.push({
          id:               d.id,
          name:             d.name,
          deviceId:         d.deviceIdentifier,
          source:           "ble",
          profileLabel:     humanizeProfile(d.deploymentProfile ?? null),
          locationRoleLabel: humanizeRole(d.locationRole ?? null),
          liveStatus:       computeLiveStatus(lastSeenAt),
          lastSeenAt:       lastSeenAt?.toISOString() ?? null,
          lastSeenAgo:      lastSeenAt ? Math.round((Date.now() - lastSeenAt.getTime()) / 1000) : null,
          readings:         buildReadings(rawMap),
        });
      }

      // ── 6. Gap summary ───────────────────────────────────────────────────
      const gaps = computeGaps([
        ...unifiDevices.map(d => d.deploymentProfile ?? null),
        ...registryDevices.map(d => d.deploymentProfile ?? null),
      ]);

      return res.json({ hiveId: hive.id, hiveName: hive.name, sensors, gaps });

    } catch (err) {
      return res.status(500).json({ error: "Failed to load sensor status" });
    }
  },
);
