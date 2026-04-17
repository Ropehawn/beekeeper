// packages/domain/hardware/selectors.ts
import type {
  UUID,
  TimestampISO,
  DeviceRole,
  ConnectionStatus,
  SignalFreshness,
  BatteryState,
  MetricKey,
  SensorDevice,
  CameraDevice,
  SignalHealth,
  MetricReading,
  ReadingSummary,
  HiveObservability,
  RegistryLifecycleStatus,
  SensorRegistryRecord,
  SensorDiscoveryRecord,
  SensorRegistryAssignment,
  ProvisioningEvent,
  CsvExportRow,
} from './types';
import {
  FRESH_THRESHOLD_MS,
  STALE_THRESHOLD_MS,
  BATTERY_OK_V,
  BATTERY_LOW_V,
  PREDICTION_REQUIRED_ROLES,
} from './constants';

// ---------------------------------------------------------------------------
// Device filtering
// ---------------------------------------------------------------------------

type AnyDevice = SensorDevice | CameraDevice;

export function devicesForHive(
  devices: AnyDevice[],
  hiveId: UUID,
): AnyDevice[] {
  return devices.filter((d) => d.hiveId === hiveId && d.isActive);
}

export function sensorsForHive(
  devices: AnyDevice[],
  hiveId: UUID,
): SensorDevice[] {
  return devicesForHive(devices, hiveId).filter(
    (d): d is SensorDevice => d.kind === 'sensor',
  );
}

export function camerasForHive(
  devices: AnyDevice[],
  hiveId: UUID,
): CameraDevice[] {
  return devicesForHive(devices, hiveId).filter(
    (d): d is CameraDevice => d.kind === 'camera',
  );
}

export function unassignedDevices(devices: AnyDevice[]): AnyDevice[] {
  return devices.filter((d) => d.hiveId === null && d.isActive);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export function devicesByRole(
  devices: AnyDevice[],
): Partial<Record<DeviceRole, AnyDevice[]>> {
  const grouped: Partial<Record<DeviceRole, AnyDevice[]>> = {};
  for (const d of devices) {
    if (!grouped[d.role]) grouped[d.role] = [];
    grouped[d.role]!.push(d);
  }
  return grouped;
}

export interface DevicesByHiveResult {
  assigned: Record<UUID, AnyDevice[]>;
  unassigned: AnyDevice[];
}

export function devicesByHive(devices: AnyDevice[]): DevicesByHiveResult {
  const assigned: Record<UUID, AnyDevice[]> = {};
  const unassigned: AnyDevice[] = [];
  for (const d of devices) {
    if (d.hiveId === null) {
      unassigned.push(d);
    } else {
      if (!assigned[d.hiveId]) assigned[d.hiveId] = [];
      assigned[d.hiveId].push(d);
    }
  }
  return { assigned, unassigned };
}

// ---------------------------------------------------------------------------
// Signal health lookup
// ---------------------------------------------------------------------------

export function signalHealthForDevice(
  healthRecords: SignalHealth[],
  deviceId: UUID,
): SignalHealth | null {
  return healthRecords.find((h) => h.deviceId === deviceId) ?? null;
}

export function signalHealthForHive(
  healthRecords: SignalHealth[],
  devices: AnyDevice[],
  hiveId: UUID,
): SignalHealth[] {
  const deviceIds = new Set(devicesForHive(devices, hiveId).map((d) => d.id));
  return healthRecords.filter((h) => deviceIds.has(h.deviceId));
}

// ---------------------------------------------------------------------------
// Connection severity
// ---------------------------------------------------------------------------

export type ConnectionSeverity = 'healthy' | 'degraded' | 'down' | 'unknown';

const SEVERITY_RANK: Record<ConnectionSeverity, number> = {
  down: 3,
  degraded: 2,
  unknown: 1,
  healthy: 0,
};

export function connectionSeverity(
  status: ConnectionStatus,
): ConnectionSeverity {
  switch (status) {
    case 'connected':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'offline':
      return 'down';
    case 'unknown':
      return 'unknown';
  }
}

export function worstConnectionSeverity(
  healthRecords: SignalHealth[],
): ConnectionSeverity {
  if (healthRecords.length === 0) return 'unknown';

  let worst: ConnectionSeverity = 'healthy';
  for (const h of healthRecords) {
    const s = connectionSeverity(h.connectionStatus);
    if (SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Signal freshness
// ---------------------------------------------------------------------------


export function deriveSignalFreshness(
  lastSeenAt: TimestampISO | null,
  nowMs: number,
): SignalFreshness {
  if (lastSeenAt === null) return 'missing';
  const ageMs = nowMs - new Date(lastSeenAt).getTime();
  if (ageMs <= FRESH_THRESHOLD_MS) return 'fresh';
  if (ageMs <= STALE_THRESHOLD_MS) return 'stale';
  return 'missing';
}

export function deriveBatteryState(voltage: number | null): BatteryState {
  if (voltage === null) return 'unknown';
  if (voltage >= BATTERY_OK_V) return 'ok';
  if (voltage >= BATTERY_LOW_V) return 'low';
  return 'critical';
}

// ---------------------------------------------------------------------------
// Metric reading selectors
// ---------------------------------------------------------------------------

export function latestReading(
  summary: ReadingSummary,
  metric: MetricKey,
): MetricReading | null {
  return summary.latest[metric] ?? null;
}

export function latestReadingValue(
  summary: ReadingSummary,
  metric: MetricKey,
): number | null {
  return summary.latest[metric]?.value ?? null;
}

export function readingSummaryForDevice(
  summaries: ReadingSummary[],
  deviceId: UUID,
): ReadingSummary | null {
  return summaries.find((s) => s.deviceId === deviceId) ?? null;
}

export function readingSummariesForHive(
  summaries: ReadingSummary[],
  hiveId: UUID,
): ReadingSummary[] {
  return summaries.filter((s) => s.hiveId === hiveId);
}

export function availableMetrics(summary: ReadingSummary): MetricKey[] {
  return Object.keys(summary.latest) as MetricKey[];
}

// ---------------------------------------------------------------------------
// Hive observability
// ---------------------------------------------------------------------------

export function buildHiveObservability(
  hiveId: UUID,
  devices: AnyDevice[],
  healthRecords: SignalHealth[],
  summaries: ReadingSummary[],
): HiveObservability {
  const hiveDevices = devicesForHive(devices, hiveId);
  const hubIds = new Set(
    hiveDevices.map((d) => d.hubId).filter((id): id is UUID => id !== null),
  );
  const hubId = hubIds.size === 1 ? [...hubIds][0] : null;

  return {
    hiveId,
    hubId,
    devices: hiveDevices,
    signalHealth: signalHealthForHive(healthRecords, devices, hiveId),
    readingSummaries: readingSummariesForHive(summaries, hiveId),
  };
}

export function hiveHasRole(
  obs: HiveObservability,
  role: DeviceRole,
): boolean {
  return obs.devices.some((d) => d.role === role && d.isActive);
}

export function hiveMissingRoles(
  obs: HiveObservability,
  requiredRoles: DeviceRole[],
): DeviceRole[] {
  return requiredRoles.filter((role) => !hiveHasRole(obs, role));
}

export function hiveDeviceCount(obs: HiveObservability): {
  sensors: number;
  cameras: number;
  total: number;
} {
  let sensors = 0;
  let cameras = 0;
  for (const d of obs.devices) {
    if (d.kind === 'sensor') sensors++;
    else cameras++;
  }
  return { sensors, cameras, total: sensors + cameras };
}

// ---------------------------------------------------------------------------
// Prediction readiness inputs
// ---------------------------------------------------------------------------

export interface PredictionReadinessInput {
  hiveId: UUID;
  availableRoles: DeviceRole[];
  missingRoles: DeviceRole[];
  signalFreshness: Record<UUID, SignalFreshness>;
  hasEnvironmental: boolean;
  hasThermal: boolean;
  hasWeight: boolean;
  hasAudio: boolean;
  hasCamera: boolean;
  overallConnectionSeverity: ConnectionSeverity;
}


export function buildPredictionReadinessInput(
  obs: HiveObservability,
): PredictionReadinessInput {
  const available = [...new Set(obs.devices.map((d) => d.role))];
  const missing = hiveMissingRoles(obs, PREDICTION_REQUIRED_ROLES);

  const signalFreshness: Record<UUID, SignalFreshness> = {};
  for (const h of obs.signalHealth) {
    signalFreshness[h.deviceId] = h.freshness;
  }

  return {
    hiveId: obs.hiveId,
    availableRoles: available,
    missingRoles: missing,
    signalFreshness,
    hasEnvironmental: hiveHasRole(obs, 'primary_environment'),
    hasThermal: hiveHasRole(obs, 'thermal_map'),
    hasWeight: hiveHasRole(obs, 'weight'),
    hasAudio: hiveHasRole(obs, 'audio'),
    hasCamera: hiveHasRole(obs, 'entrance_camera'),
    overallConnectionSeverity: worstConnectionSeverity(obs.signalHealth),
  };
}

// ---------------------------------------------------------------------------
// Registry / Provisioning selectors
// These selectors operate on static/administrative registry state only.
// No live signal or metric data crosses this boundary.
// ---------------------------------------------------------------------------

// --- Lookup by identifier ---

export function registryRecordByQrId(
  records: SensorRegistryRecord[],
  qrId: string,
): SensorRegistryRecord | null {
  return records.find((r) => r.deviceIdentifier === qrId) ?? null;
}

export function registryRecordByMac(
  records: SensorRegistryRecord[],
  mac: string,
): SensorRegistryRecord | null {
  const normalized = mac.toUpperCase().trim();
  return (
    records.find(
      (r) => r.currentMacAddress?.toUpperCase().trim() === normalized,
    ) ?? null
  );
}

export function registryRecordsByDeviceIdentifier(
  records: SensorRegistryRecord[],
  deviceIdentifier: string,
): SensorRegistryRecord[] {
  return records.filter((r) => r.deviceIdentifier === deviceIdentifier);
}

// --- Assignment lookup ---

export function activeAssignmentForRegistry(
  assignments: SensorRegistryAssignment[],
  registryId: UUID,
): SensorRegistryAssignment | null {
  return assignments.find((a) => a.registryId === registryId) ?? null;
}

// --- Filtering by assignment state ---

export function assignedRegistryRecords(
  records: SensorRegistryRecord[],
): SensorRegistryRecord[] {
  return records.filter((r) => r.lifecycleStatus === 'assigned');
}

export function unassignedRegistryRecords(
  records: SensorRegistryRecord[],
): SensorRegistryRecord[] {
  return records.filter(
    (r) =>
      r.lifecycleStatus === 'provisioned' ||
      r.lifecycleStatus === 'unassigned',
  );
}

// --- Grouping by lifecycle status ---

export function registryRecordsByLifecycleStatus(
  records: SensorRegistryRecord[],
): Partial<Record<RegistryLifecycleStatus, SensorRegistryRecord[]>> {
  const grouped: Partial<Record<RegistryLifecycleStatus, SensorRegistryRecord[]>> = {};
  for (const r of records) {
    if (!grouped[r.lifecycleStatus]) grouped[r.lifecycleStatus] = [];
    grouped[r.lifecycleStatus]!.push(r);
  }
  return grouped;
}

// --- Provisioning event selectors ---

export function latestProvisioningEvent(
  events: ProvisioningEvent[],
  registryId: UUID,
): ProvisioningEvent | null {
  const forRecord = events.filter((e) => e.registryId === registryId);
  if (forRecord.length === 0) return null;
  return forRecord.reduce((latest, e) =>
    e.occurredAt > latest.occurredAt ? e : latest,
  );
}

export function provisioningEventsForRecord(
  events: ProvisioningEvent[],
  registryId: UUID,
): ProvisioningEvent[] {
  return events
    .filter((e) => e.registryId === registryId)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
}

// --- Label print readiness ---

// A record is printable when it is provisioned (or beyond) and has not
// yet had a label printed. Retired records are excluded.
export function isRegistryRecordPrintable(
  record: SensorRegistryRecord,
): boolean {
  if (record.labelPrinted) return false;
  return (
    record.lifecycleStatus === 'provisioned' ||
    record.lifecycleStatus === 'assigned' ||
    record.lifecycleStatus === 'unassigned'
  );
}

export function unprintedRegistryRecords(
  records: SensorRegistryRecord[],
): SensorRegistryRecord[] {
  return records.filter(isRegistryRecordPrintable);
}

// --- CSV export ---

export function registryRecordToCsvRow(
  record: SensorRegistryRecord,
  assignment: SensorRegistryAssignment | null,
): CsvExportRow {
  return {
    id: record.id,
    name: record.name,
    vendor: record.vendor,
    model: record.model,
    transport: record.transport,
    deviceIdentifier: record.deviceIdentifier,
    macAddress: record.currentMacAddress ?? '',
    lifecycleStatus: record.lifecycleStatus,
    role: record.role,
    hiveId: assignment?.hiveId ?? record.hiveId ?? '',
    hubId: record.hubId ?? '',
    provisionedAt: record.provisionedAt ?? '',
    assignedAt: assignment?.assignedAt ?? record.assignedAt ?? '',
    labelPrinted: record.labelPrinted ? 'true' : 'false',
    notes: record.notes ?? '',
  };
}

export function registryRecordsToCsvRows(
  records: SensorRegistryRecord[],
  assignments: SensorRegistryAssignment[],
): CsvExportRow[] {
  return records.map((r) => {
    const assignment =
      assignments.find((a) => a.registryId === r.id) ?? null;
    return registryRecordToCsvRow(r, assignment);
  });
}

// --- Discovery matching ---

// Returns records that are likely the same physical device as the discovery
// record, ranked by match confidence:
//   1. MAC address match (strongest — same physical hardware)
//   2. deviceIdentifier match (strong — same provisioned identifier)
//   3. vendor + model match (weak — narrows to device class only)
export type DiscoveryMatchStrength = 'mac' | 'identifier' | 'vendor_model';

export interface DiscoveryMatch {
  record: SensorRegistryRecord;
  strength: DiscoveryMatchStrength;
}

export function findDiscoveryMatches(
  records: SensorRegistryRecord[],
  discovery: SensorDiscoveryRecord,
): DiscoveryMatch[] {
  const matches: DiscoveryMatch[] = [];
  const normalizedDiscoveredMac =
    discovery.observedMacAddress?.toUpperCase().trim() ?? null;

  for (const record of records) {
    const normalizedRecordMac =
      record.currentMacAddress?.toUpperCase().trim() ?? null;

    if (
      normalizedDiscoveredMac !== null &&
      normalizedRecordMac !== null &&
      normalizedDiscoveredMac === normalizedRecordMac
    ) {
      matches.push({ record, strength: 'mac' });
      continue;
    }

    if (record.deviceIdentifier === discovery.discoveredIdentifier) {
      matches.push({ record, strength: 'identifier' });
      continue;
    }

    if (
      record.vendor === discovery.vendor &&
      record.model === discovery.model
    ) {
      matches.push({ record, strength: 'vendor_model' });
    }
  }

  // Sort: mac > identifier > vendor_model
  const STRENGTH_RANK: Record<DiscoveryMatchStrength, number> = {
    mac: 0,
    identifier: 1,
    vendor_model: 2,
  };
  return matches.sort(
    (a, b) => STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength],
  );
}
