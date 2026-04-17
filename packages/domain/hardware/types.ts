// packages/domain/hardware/types.ts
export type TimestampISO = string;
export type UUID = string;

// ---------------------------------------------------------------------------
// BeeKeeper stable asset identity
// assetId    — BeeKeeper-assigned stable identity (e.g. BK-SEN-000241).
//              Survives firmware reflashes, MAC changes, and re-provisioning.
// deviceIdentifier — native/vendor identity (serial, BLE name, etc.).
//              Assigned by the vendor or the hub at discovery time.
// currentMacAddress — current transport/runtime identity.
//              Changes on firmware reflash or hardware swap.
// ---------------------------------------------------------------------------

export type AssetId = string;

export type AssetType =
  | 'sensor'
  | 'camera'
  | 'weight_assembly'
  | 'hub'
  | 'acoustic_assembly'
  | 'environment_assembly';

export type AssetIdPrefix =
  | 'SEN'
  | 'CAM'
  | 'WGT'
  | 'HUB'
  | 'AUD'
  | 'ENV';

export interface AssetIdParts {
  prefix: AssetIdPrefix;
  sequence: number;
}

export type HubPlatform = 'tachyon' | 'esp32c6' | 'custom';
export type DeviceTransport = 'ble' | 'gpio' | 'csi' | 'cloud' | 'manual';
export type DeviceKind = 'sensor' | 'camera';
export type DeviceRole =
  | 'primary_environment'
  | 'thermal_map'
  | 'weight'
  | 'audio'
  | 'entrance_camera'
  | 'apiary_camera'
  | 'ambient_weather'
  | 'unknown';
export type DeviceVendor =
  | 'tachyon'
  | 'unifi_protect'
  | 'sensorpush'
  | 'ecowitt'
  | 'mokosmart'
  | 'fanstel'
  | 'generic';
export type SensorModel =
  | 'sc833f'
  | 's05t'
  | 'hx711'
  | 'bme280'
  | 'inmp441'
  | 'generic';
export type CameraModel =
  | 'imx519'
  | 'g4_bullet'
  | 'g5_flex'
  | 'generic';
export type ConnectionStatus = 'connected' | 'degraded' | 'offline' | 'unknown';
export type SignalFreshness = 'fresh' | 'stale' | 'missing';
export type BatteryState = 'ok' | 'low' | 'critical' | 'unknown';
export type MetricKey =
  | 'temp_c'
  | 'humidity_rh'
  | 'pressure_hpa'
  | 'weight_g'
  | 'accel_x'
  | 'accel_y'
  | 'accel_z'
  | 'battery_v'
  | 'rssi_dbm'
  | 'audio_level'
  | 'bee_count'
  | 'varroa_detected';
export interface Hub {
  id: UUID;
  assetId: AssetId | null;         // BeeKeeper stable asset identity
  apiaryId: UUID | null;
  name: string;
  platform: HubPlatform;
  firmwareVersion: string | null;
  isActive: boolean;
  lastHeartbeatAt: TimestampISO | null;
  createdAt: TimestampISO;
  updatedAt: TimestampISO;
}
export interface BaseDevice {
  id: UUID;
  hubId: UUID | null;
  hiveId: UUID | null;
  name: string;
  kind: DeviceKind;
  role: DeviceRole;
  vendor: DeviceVendor;
  transport: DeviceTransport;
  isActive: boolean;
  provisionedAt: TimestampISO | null;
  createdAt: TimestampISO;
  updatedAt?: TimestampISO;
}
export interface SensorDevice extends BaseDevice {
  kind: 'sensor';
  model: SensorModel;
  deviceIdentifier: string;
  currentMacAddress: string | null;
  pollingIntervalSec: number | null;
}
export interface CameraDevice extends BaseDevice {
  kind: 'camera';
  assetId: AssetId | null;         // BeeKeeper stable asset identity
  model: CameraModel;
  deviceIdentifier: string;
  streamUrl: string | null;
  snapshotUrl: string | null;
}
export interface DeviceAssignment {
  deviceId: UUID;
  hiveId: UUID;
  role: DeviceRole;
  assignedAt: TimestampISO;
}
export interface SignalHealth {
  deviceId: UUID;
  connectionStatus: ConnectionStatus;
  freshness: SignalFreshness;
  lastSeenAt: TimestampISO | null;
  batteryState: BatteryState;
  batteryVoltage: number | null;
  rssiDbm: number | null;
}
export interface MetricReading {
  metric: MetricKey;
  value: number;
  unit: string;
  recordedAt: TimestampISO;
}
export interface ReadingSummary {
  deviceId: UUID;
  hiveId: UUID | null;
  latest: Partial<Record<MetricKey, MetricReading>>;
}
export interface SensorCandidate {
  discoveredIdentifier: string;
  name: string;
  vendor: DeviceVendor;
  model: SensorModel;
  transport: DeviceTransport;
  isReachable: boolean;
}
export interface CameraCandidate {
  discoveredIdentifier: string;
  name: string;
  vendor: DeviceVendor;
  model: CameraModel;
  transport: DeviceTransport;
  isReachable: boolean;
}
export interface HiveObservability {
  hiveId: UUID;
  hubId: UUID | null;
  devices: Array<SensorDevice | CameraDevice>;
  signalHealth: SignalHealth[];
  readingSummaries: ReadingSummary[];
}

// ---------------------------------------------------------------------------
// Registry / Provisioning types
// These types describe the lifecycle of a device from discovery through
// assignment. They are static/administrative — no live signal data.
// ---------------------------------------------------------------------------

export type RegistryLifecycleStatus =
  | 'discovered'    // seen on the network, not yet claimed
  | 'pending'       // claimed, awaiting provisioning confirmation
  | 'provisioned'   // fully registered and ready to assign
  | 'assigned'      // currently assigned to a hive
  | 'unassigned'    // provisioned but not currently assigned
  | 'retired'       // decommissioned, no longer in service
  | 'unknown';

export type RegistrySearchField =
  | 'name'
  | 'mac_address'
  | 'device_identifier'
  | 'vendor'
  | 'model'
  | 'hive_id'
  | 'lifecycle_status'
  | 'hub_id';

export type AssignmentTargetType = 'hive' | 'apiary' | 'unassigned';

export type ProvisioningEventType =
  | 'discovered'
  | 'claimed'
  | 'provisioned'
  | 'assigned'
  | 'reassigned'
  | 'unassigned'
  | 'mac_updated'
  | 'firmware_updated'
  | 'retired'
  | 'reactivated';

// A stable registry record for a sensor. Represents the device's
// administrative identity and current lifecycle state. Does not
// carry live signal or metric data.
export interface SensorRegistryRecord {
  id: UUID;
  assetId: AssetId;                // BeeKeeper stable asset identity — required at provisioning
  deviceIdentifier: string;
  vendor: DeviceVendor;
  model: SensorModel;
  transport: DeviceTransport;
  kind: 'sensor';
  name: string;
  lifecycleStatus: RegistryLifecycleStatus;
  currentMacAddress: string | null;
  hubId: UUID | null;
  hiveId: UUID | null;
  role: DeviceRole;
  pollingIntervalSec: number | null;
  firmwareVersion: string | null;
  notes: string | null;
  labelPrinted: boolean;
  provisionedAt: TimestampISO | null;
  assignedAt: TimestampISO | null;
  retiredAt: TimestampISO | null;
  createdAt: TimestampISO;
  updatedAt: TimestampISO;
}

// A transient discovery record representing a device seen on the
// network that has not yet been claimed into the registry.
export interface SensorDiscoveryRecord {
  discoveredIdentifier: string;
  vendor: DeviceVendor;
  model: SensorModel;
  transport: DeviceTransport;
  kind: 'sensor';
  observedMacAddress: string | null;
  isReachable: boolean;
  firstSeenAt: TimestampISO;
  lastSeenAt: TimestampISO;
}

// A resolved link between a registry record and a SensorDevice,
// used after provisioning to associate the canonical device record
// with its registry identity.
export interface SensorLink {
  registryId: UUID;
  deviceId: UUID;
  linkedAt: TimestampISO;
}

// An assignment record in the provisioning workflow context.
// Distinct from DeviceAssignment (which belongs to the live device graph)
// — this carries extra context needed by the provisioning UI/workflow.
export interface SensorRegistryAssignment {
  registryId: UUID;
  deviceId: UUID;
  hiveId: UUID;
  role: DeviceRole;
  targetType: AssignmentTargetType;
  assignedAt: TimestampISO;
  assignedBy: UUID | null; // user/actor id
}

// An immutable audit event recording a state transition in the
// provisioning lifecycle of a device.
export interface ProvisioningEvent {
  id: UUID;
  registryId: UUID;
  eventType: ProvisioningEventType;
  actorId: UUID | null;
  occurredAt: TimestampISO;
  payload: Record<string, unknown>;
}

// A job record for printing a physical device label.
// Created when a device is provisioned; fulfilled by the label printer.
export interface LabelPrintJob {
  id: UUID;
  registryId: UUID;
  deviceIdentifier: string;
  vendor: DeviceVendor;
  model: SensorModel;
  name: string;
  macAddress: string | null;
  queuedAt: TimestampISO;
  printedAt: TimestampISO | null;
  isPrinted: boolean;
}

// Query parameters for filtering the sensor registry.
export interface RegistrySearchQuery {
  field: RegistrySearchField;
  value: string;
  lifecycleStatus?: RegistryLifecycleStatus;
  kind?: DeviceKind;
  limit?: number;
  offset?: number;
}

// Paginated result set for a registry search.
export interface RegistrySearchResult {
  records: SensorRegistryRecord[];
  total: number;
  query: RegistrySearchQuery;
}

// A flat row for CSV export of registry records.
// All values are strings to survive spreadsheet round-trips.
export interface CsvExportRow {
  id: string;
  name: string;
  vendor: string;
  model: string;
  transport: string;
  deviceIdentifier: string;
  macAddress: string;
  lifecycleStatus: string;
  role: string;
  hiveId: string;
  hubId: string;
  provisionedAt: string;
  assignedAt: string;
  labelPrinted: string;
  notes: string;
}
