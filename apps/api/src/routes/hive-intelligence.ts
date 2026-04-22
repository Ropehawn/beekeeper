// apps/api/src/routes/hive-intelligence.ts
//
// GET /api/v1/hives/intelligence/:hiveId
//
// Computes what the sensors are telling us about the hive, not just which
// sensors exist. Returns current conditions, 24h/3d trends, plain-English
// insights, and per-source data freshness.
//
// Data sources:
//   sensor_readings      — UniFi columnar: tempF, humidity, lux
//   sensor_readings_raw  — BLE/hub metric rows: temp_c, humidity_rh,
//                          pressure_hpa, weight_g, audio_rms, battery_v
//
// Auth: requireAuth + requireRole("queen", "worker")

import { Router } from "express";
import { db } from "@beekeeper/db";
import { requireAuth, requireRole } from "../middleware/auth";

export const hiveIntelligenceRouter = Router();

// ── Role classification ────────────────────────────────────────────────────────
// Maps deploymentProfile → which sensing roles that sensor covers.

const PROFILE_ROLES: Record<string, string[]> = {
  internal_climate:             ["internalClimate"],
  ambient_reference:            ["externalClimate"],
  scale_only:                   ["scale"],
  audio_only:                   ["audio"],
  external_climate_scale_audio: ["externalClimate", "scale", "audio"],
  custom:                       [],
};

function rolesFor(profile: string | null): string[] {
  if (!profile) return [];
  return PROFILE_ROLES[profile] ?? [];
}

// ── Freshness thresholds ──────────────────────────────────────────────────────
// Based on reading timestamp, not sensor ping. A sensor that claims to cover
// scale but never produces weight readings is "offline" for scale, not "live".

const LIVE_S  = 300;   // 5 min
const STALE_S = 3600;  // 1 hour

type Freshness = "live" | "stale" | "offline" | "unavailable";

function computeFreshness(lastReadingAt: Date | null, assigned: boolean): Freshness {
  if (!assigned)          return "unavailable";
  if (!lastReadingAt)     return "offline";
  const ageS = (Date.now() - lastReadingAt.getTime()) / 1000;
  if (ageS < LIVE_S)      return "live";
  if (ageS < STALE_S)     return "stale";
  return "offline";
}

function ageSeconds(at: Date | null): number | null {
  if (!at) return null;
  return Math.round((Date.now() - at.getTime()) / 1000);
}

// ── Unit conversions ──────────────────────────────────────────────────────────

const cToF = (c: number) => (c * 9) / 5 + 32;
const gToLb = (g: number) => g / 453.592;

// ── Insight heuristics ────────────────────────────────────────────────────────
// Each function returns a plain-English string or null (no insight to surface).
//
// Rules:
//   Internal temp:  < 85°F low | 85–90 below optimal | 90–97 normal | > 97 elevated
//   Internal RH:    < 45% low  | 45–80 normal        | > 80 elevated
//   RH comparison:  internal > external + 15% → elevated relative to ambient
//   Weight 24h:     > +2 lb strong gain | +0.5 to +2 gaining | -0.3 to +0.5 stable |
//                   < -0.5 loss | < -2 significant loss
//   Audio ratio:    > 2.0x elevated | > 1.4x slightly elevated |
//                   < 0.6x reduced  | < 0.3x very low

function internalTempInsight(tempF: number | null, fresh: Freshness): string | null {
  if (tempF == null || fresh === "unavailable") return null;
  if (fresh === "offline") return "Internal climate data is stale — sensor may be offline";
  if (tempF < 85)   return `Brood temperature is low (${tempF.toFixed(1)}°F) — colony may need attention`;
  if (tempF < 90)   return `Brood temperature is below optimal range (${tempF.toFixed(1)}°F)`;
  if (tempF <= 97)  return "Brood climate is within normal range";
  if (tempF <= 104) return `Brood temperature is elevated (${tempF.toFixed(1)}°F) — check ventilation`;
  return `Brood temperature is critically high (${tempF.toFixed(1)}°F)`;
}

function internalHumidityInsight(rh: number | null, fresh: Freshness): string | null {
  if (rh == null || fresh === "unavailable" || fresh === "offline") return null;
  if (rh < 45) return `Internal humidity is low (${rh.toFixed(0)}%)`;
  if (rh > 80) return `Internal humidity is elevated (${rh.toFixed(0)}%) — check ventilation`;
  return null;
}

function humidityComparisonInsight(internalRh: number | null, externalRh: number | null): string | null {
  if (internalRh == null || externalRh == null) return null;
  const diff = internalRh - externalRh;
  if (diff > 20) return "Internal humidity is significantly elevated relative to ambient conditions";
  if (diff > 10) return "Internal humidity is elevated relative to ambient conditions";
  return null;
}

function weightDeltaInsight(deltaLb: number): string {
  const abs = Math.abs(deltaLb).toFixed(1);
  if (deltaLb > 2)    return `Hive gained ${abs} lb in the last 24 hours — strong nectar flow likely`;
  if (deltaLb > 0.5)  return `Hive is gaining weight (+${abs} lb in 24h) — active foraging likely`;
  if (deltaLb > -0.3) return "Hive weight is stable over the last 24 hours";
  if (deltaLb > -1)   return `Hive lost ${abs} lb in the last 24 hours`;
  return `Hive lost ${abs} lb in the last 24 hours — significant loss, consider inspection`;
}

function audioInsight(ratio: number): string | null {
  if (ratio > 2.0)  return "Audio activity is significantly elevated vs recent baseline";
  if (ratio > 1.4)  return "Audio activity is elevated vs recent baseline";
  if (ratio < 0.3)  return "Audio activity is very low vs recent baseline";
  if (ratio < 0.6)  return "Audio activity is reduced vs recent baseline";
  return null;
}

// ── Route ─────────────────────────────────────────────────────────────────────

hiveIntelligenceRouter.get(
  "/intelligence/:hiveId",
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

      // ── 1. Assigned sensors ─────────────────────────────────────────────────
      const [unifiDevices, registryDevices] = await Promise.all([
        db.sensorDevice.findMany({
          where:  { hiveId, isActive: true },
          select: { id: true, currentMac: true, deploymentProfile: true },
        }),
        db.sensorRegistry.findMany({
          where:  { hiveId, lifecycleStatus: { notIn: ["retired"] } },
          select: { id: true, currentMacAddress: true, deploymentProfile: true },
        }),
      ]);

      // ── 2. Build role → { unifiIds, macs, assigned } map ───────────────────
      type RoleSet = { unifiIds: string[]; macs: string[]; assigned: boolean };
      const ALL_ROLES = ["internalClimate", "externalClimate", "scale", "audio"] as const;
      const roleMap = new Map<string, RoleSet>(
        ALL_ROLES.map(r => [r, { unifiIds: [], macs: [], assigned: false }]),
      );

      for (const d of unifiDevices) {
        for (const role of rolesFor(d.deploymentProfile ?? null)) {
          const rs = roleMap.get(role);
          if (!rs) continue;
          rs.assigned = true;
          rs.unifiIds.push(d.id);
          if (d.currentMac) rs.macs.push(d.currentMac.toUpperCase());
        }
      }
      for (const d of registryDevices) {
        for (const role of rolesFor(d.deploymentProfile ?? null)) {
          const rs = roleMap.get(role);
          if (!rs) continue;
          rs.assigned = true;
          if (d.currentMacAddress) rs.macs.push(d.currentMacAddress.toUpperCase());
        }
      }

      const allUnifiIds = unifiDevices.map(d => d.id);
      const allMacs     = [
        ...unifiDevices.map(d => d.currentMac).filter((m): m is string => m != null),
        ...registryDevices.map(d => d.currentMacAddress).filter((m): m is string => m != null),
      ].map(m => m.toUpperCase());

      // ── 3. Batch-fetch readings ─────────────────────────────────────────────
      const window7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const rawOrFilter = [
        ...(allMacs.length      > 0 ? [{ deviceMac: { in: allMacs } }] : []),
        ...(allUnifiIds.length  > 0 ? [{ deviceId:  { in: allUnifiIds } }] : []),
        { hiveId },
      ];
      const hasAnyDevice = allUnifiIds.length > 0 || allMacs.length > 0;

      const [
        latestUnifi,
        rawLatest,
        weightHistoryRaw,
        audioHistoryRaw,
      ] = await Promise.all([
        // Latest UniFi reading per device (tempF, humidity, lux)
        allUnifiIds.length > 0
          ? db.sensorReading.findMany({
              where:   { deviceId: { in: allUnifiIds }, recordedAt: { gte: window7d } },
              orderBy: { recordedAt: "desc" },
              select:  { deviceId: true, tempF: true, humidity: true,
                         lux: true, recordedAt: true },
            })
          : Promise.resolve([] as Array<{ deviceId: string; tempF: number | null; humidity: number | null; lux: number | null; recordedAt: Date }>),

        // Latest raw reading per (identifier, metric) — current conditions
        hasAnyDevice
          ? db.sensorReadingRaw.findMany({
              where:   { recordedAt: { gte: window7d }, OR: rawOrFilter },
              orderBy: { recordedAt: "desc" },
              select:  { deviceMac: true, deviceId: true, metric: true,
                         value: true, recordedAt: true },
            })
          : Promise.resolve([] as Array<{ deviceMac: string | null; deviceId: string | null; metric: string; value: number; recordedAt: Date }>),

        // Weight time-series for trend computation
        hasAnyDevice
          ? db.sensorReadingRaw.findMany({
              where:   { metric: "weight_g", recordedAt: { gte: window7d }, OR: rawOrFilter },
              orderBy: { recordedAt: "asc" },
              select:  { value: true, recordedAt: true },
            })
          : Promise.resolve([] as Array<{ value: number; recordedAt: Date }>),

        // Audio time-series for baseline
        hasAnyDevice
          ? db.sensorReadingRaw.findMany({
              where:   { metric: "audio_rms", recordedAt: { gte: window7d }, OR: rawOrFilter },
              orderBy: { recordedAt: "desc" },
              select:  { value: true, recordedAt: true },
            })
          : Promise.resolve([] as Array<{ value: number; recordedAt: Date }>),
      ]);

      // ── 4. Index readings ───────────────────────────────────────────────────

      // Latest UniFi reading by device UUID (ordered desc, first wins)
      const unifiByUuid = new Map<string, typeof latestUnifi[number]>();
      for (const r of latestUnifi) {
        if (!unifiByUuid.has(r.deviceId)) unifiByUuid.set(r.deviceId, r);
      }

      // Latest raw by (mac|uuid → metric → row)
      type RawRow = typeof rawLatest[number];
      const rawByMac:  Map<string, Map<string, RawRow>> = new Map();
      const rawByUuid: Map<string, Map<string, RawRow>> = new Map();

      for (const r of rawLatest) {
        if (r.deviceMac) {
          const mac = r.deviceMac.toUpperCase();
          if (!rawByMac.has(mac)) rawByMac.set(mac, new Map());
          const m = rawByMac.get(mac)!;
          if (!m.has(r.metric)) m.set(r.metric, r);
        }
        if (r.deviceId) {
          if (!rawByUuid.has(r.deviceId)) rawByUuid.set(r.deviceId, new Map());
          const m = rawByUuid.get(r.deviceId)!;
          if (!m.has(r.metric)) m.set(r.metric, r);
        }
      }

      // ── 5. Role-scoped lookup helpers ───────────────────────────────────────

      function rawForRole(role: string, metric: string): RawRow | null {
        const rs = roleMap.get(role);
        if (!rs) return null;
        let best: RawRow | null = null;
        for (const mac of rs.macs) {
          const row = rawByMac.get(mac)?.get(metric);
          if (row && (!best || row.recordedAt > best.recordedAt)) best = row;
        }
        for (const uid of rs.unifiIds) {
          const row = rawByUuid.get(uid)?.get(metric);
          if (row && (!best || row.recordedAt > best.recordedAt)) best = row;
        }
        return best;
      }

      function unifiForRole(role: string): typeof latestUnifi[number] | null {
        const rs = roleMap.get(role);
        if (!rs) return null;
        let best: typeof latestUnifi[number] | null = null;
        for (const uid of rs.unifiIds) {
          const r = unifiByUuid.get(uid);
          if (r && (!best || r.recordedAt > best.recordedAt)) best = r;
        }
        return best;
      }

      // ── 6. Extract current values ───────────────────────────────────────────
      // Temperature / humidity: prefer BLE raw (richer), fall back to UniFi columnar.
      // Weight, pressure, audio: raw only (UniFi never populates these).

      function resolveTemp(role: string): [number | null, Date | null] {
        const raw   = rawForRole(role, "temp_c");
        const unifi = unifiForRole(role);
        if (raw)               return [cToF(raw.value), raw.recordedAt];
        if (unifi?.tempF != null) return [unifi.tempF, unifi.recordedAt];
        return [null, null];
      }

      function resolveHumidity(role: string): [number | null, Date | null] {
        const raw   = rawForRole(role, "humidity_rh");
        const unifi = unifiForRole(role);
        if (raw)                   return [raw.value, raw.recordedAt];
        if (unifi?.humidity != null) return [unifi.humidity, unifi.recordedAt];
        return [null, null];
      }

      const [internalTempF, internalTempAt]  = resolveTemp("internalClimate");
      const [internalRh,    internalRhAt]    = resolveHumidity("internalClimate");
      const [externalTempF, externalTempAt]  = resolveTemp("externalClimate");
      const [externalRh,    externalRhAt]    = resolveHumidity("externalClimate");

      const pressureRow = rawForRole("externalClimate", "pressure_hpa");
      const pressureHpa = pressureRow?.value ?? null;
      const pressureAt  = pressureRow?.recordedAt ?? null;

      const weightRow = rawForRole("scale", "weight_g");
      const weightLb  = weightRow ? gToLb(weightRow.value) : null;
      const weightAt  = weightRow?.recordedAt ?? null;

      const audioRow  = rawForRole("audio", "audio_rms");
      const audioRms  = audioRow?.value ?? null;
      const audioAt   = audioRow?.recordedAt ?? null;

      // ── 7. Per-source freshness (based on actual reading timestamps) ─────────

      const internalFresh = computeFreshness(
        internalTempAt ?? internalRhAt,
        roleMap.get("internalClimate")!.assigned,
      );
      const externalFresh = computeFreshness(
        externalTempAt ?? externalRhAt ?? pressureAt,
        roleMap.get("externalClimate")!.assigned,
      );
      const scaleFresh = computeFreshness(weightAt, roleMap.get("scale")!.assigned);
      const audioFresh = computeFreshness(audioAt,  roleMap.get("audio")!.assigned);

      // ── 8. Weight trends ────────────────────────────────────────────────────

      function weightDeltaLb(periodMs: number): number | null {
        if (weightHistoryRaw.length < 2) return null;
        const sorted = [...weightHistoryRaw].sort((a, b) =>
          b.recordedAt.getTime() - a.recordedAt.getTime(),
        );
        const latest  = sorted[0];
        const cutoff  = new Date(latest.recordedAt.getTime() - periodMs);
        const anchor  = sorted.find(r => r.recordedAt <= cutoff);
        if (!anchor) return null;
        return gToLb(latest.value) - gToLb(anchor.value);
      }

      const delta24h = weightDeltaLb(24 * 60 * 60 * 1000);
      const delta3d  = weightDeltaLb(3 * 24 * 60 * 60 * 1000);

      // ── 9. Audio baseline (median of readings >5 min old in the 7d window) ──

      let audioBaseline: number | null = null;
      const baselineCutoff = new Date(Date.now() - 5 * 60 * 1000);
      const baselinePoints = audioHistoryRaw
        .filter(r => r.recordedAt < baselineCutoff)
        .map(r => r.value)
        .sort((a, b) => a - b);
      if (baselinePoints.length >= 5) {
        audioBaseline = baselinePoints[Math.floor(baselinePoints.length / 2)];
      }

      // ── 10. Conditions array ────────────────────────────────────────────────

      type ConditionItem = {
        label:        string;
        displayValue: string;
        rawValue:     number;
        unit:         string;
        freshness:    Freshness;
        lastSeenAgo:  number | null;
        recordedAt:   string | null;
      };

      const conditions: ConditionItem[] = [];

      function addCond(
        label: string, value: number | null, at: Date | null,
        fresh: Freshness, unit: string, fmt: (v: number) => string,
      ) {
        if (value == null) return;
        conditions.push({
          label, displayValue: fmt(value), rawValue: value, unit,
          freshness: fresh, lastSeenAgo: ageSeconds(at), recordedAt: at?.toISOString() ?? null,
        });
      }

      addCond("Internal temperature", internalTempF, internalTempAt, internalFresh, "°F",  v => `${v.toFixed(1)}°F`);
      addCond("Internal humidity",    internalRh,    internalRhAt,   internalFresh, "%",   v => `${v.toFixed(0)}%`);
      addCond("External temperature", externalTempF, externalTempAt, externalFresh, "°F",  v => `${v.toFixed(1)}°F`);
      addCond("External humidity",    externalRh,    externalRhAt,   externalFresh, "%",   v => `${v.toFixed(0)}%`);
      addCond("Atmospheric pressure", pressureHpa,   pressureAt,     externalFresh, "hPa", v => `${v.toFixed(0)} hPa`);
      addCond("Hive weight",          weightLb,      weightAt,       scaleFresh,    "lb",  v => `${v.toFixed(2)} lb`);
      addCond("Audio level",          audioRms,      audioAt,        audioFresh,    "RMS", v => v.toFixed(4));

      // ── 11. Trends array ────────────────────────────────────────────────────

      type TrendItem = {
        label:        string;
        displayValue: string;
        direction:    "up" | "down" | "stable";
        period:       string;
        freshness:    Freshness;
      };

      const trends: TrendItem[] = [];

      function direction(delta: number): "up" | "down" | "stable" {
        return delta > 0.1 ? "up" : delta < -0.1 ? "down" : "stable";
      }

      if (delta24h != null) {
        const s = delta24h >= 0 ? "+" : "";
        trends.push({ label: "Weight change (24h)", displayValue: `${s}${delta24h.toFixed(2)} lb`,
          direction: direction(delta24h), period: "24h", freshness: scaleFresh });
      }
      if (delta3d != null) {
        const s = delta3d >= 0 ? "+" : "";
        trends.push({ label: "Weight change (3 days)", displayValue: `${s}${delta3d.toFixed(2)} lb`,
          direction: direction(delta3d), period: "3d", freshness: scaleFresh });
      }
      if (audioRms != null && audioBaseline != null && audioBaseline > 0) {
        const ratio = audioRms / audioBaseline;
        const pct   = Math.round((ratio - 1) * 100);
        const s     = pct >= 0 ? "+" : "";
        trends.push({ label: "Audio vs 7-day baseline", displayValue: `${s}${pct}%`,
          direction: ratio > 1.1 ? "up" : ratio < 0.9 ? "down" : "stable",
          period: "7d_baseline", freshness: audioFresh });
      }

      // ── 12. Insights ────────────────────────────────────────────────────────

      const insights: string[] = [];

      // Internal climate
      if (!roleMap.get("internalClimate")!.assigned) {
        insights.push("No internal climate sensor assigned to this hive");
      } else {
        const ti = internalTempInsight(internalTempF, internalFresh);
        if (ti) insights.push(ti);
        const hi = internalHumidityInsight(internalRh, internalFresh);
        if (hi) insights.push(hi);
        const ci = humidityComparisonInsight(internalRh, externalRh);
        if (ci) insights.push(ci);
      }

      // Scale
      if (!roleMap.get("scale")!.assigned) {
        insights.push("No scale sensor assigned — weight data unavailable");
      } else if (scaleFresh === "offline") {
        insights.push("Scale data is stale — sensor may be offline");
      } else if (delta24h != null) {
        insights.push(weightDeltaInsight(delta24h));
      }

      // Audio
      if (!roleMap.get("audio")!.assigned) {
        insights.push("No audio monitoring assigned");
      } else if (audioFresh === "offline") {
        insights.push("Audio sensor is offline");
      } else if (audioRms != null && audioBaseline != null && audioBaseline > 0) {
        const ai = audioInsight(audioRms / audioBaseline);
        if (ai) insights.push(ai);
      }

      // External climate (only flag if offline — absence is less critical)
      if (roleMap.get("externalClimate")!.assigned && externalFresh === "offline") {
        insights.push("External climate reference is offline");
      }

      // ── 13. Sources ─────────────────────────────────────────────────────────

      const sources = {
        internalClimate: {
          freshness:   internalFresh,
          lastSeenAgo: ageSeconds(internalTempAt ?? internalRhAt),
          assigned:    roleMap.get("internalClimate")!.assigned,
        },
        externalClimate: {
          freshness:   externalFresh,
          lastSeenAgo: ageSeconds(externalTempAt ?? externalRhAt ?? pressureAt),
          assigned:    roleMap.get("externalClimate")!.assigned,
        },
        scale: {
          freshness:   scaleFresh,
          lastSeenAgo: ageSeconds(weightAt),
          assigned:    roleMap.get("scale")!.assigned,
        },
        audio: {
          freshness:   audioFresh,
          lastSeenAgo: ageSeconds(audioAt),
          assigned:    roleMap.get("audio")!.assigned,
        },
      };

      return res.json({
        hiveId:   hive.id,
        hiveName: hive.name,
        conditions,
        trends,
        insights,
        sources,
      });

    } catch (err) {
      return res.status(500).json({ error: "Failed to load hive intelligence" });
    }
  },
);
