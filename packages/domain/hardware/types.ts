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

// ---------------------------------------------------------------------------
// Tachyon-native sensor identity reconciliation types
//
// These types describe the identity reconciliation layer that sits between
// Tachyon discovery events and the BeeKeeper registry. A Tachyon hub may
// observe a sensor via any combination of three signals:
//
//   assetId           — scanned from a physical QR label (strongest, stable)
//   deviceIdentifier  — advertised by the vendor firmware (strong, may be null)
//   observedMacAddress — seen at the transport layer (weak, changes on reflash)
//
// reconcileSensorIdentity() in actions.ts uses these types to produce a
// SensorReconciliationResult that callers can act on without ambiguity.
// ---------------------------------------------------------------------------

/**
 * The type of match found when reconciling an observed sensor against
 * the registry. Each value represents a distinct outcome in the decision tree.
 */
export type ReconciliationMatchType =
  | 'exact_match'          // observation matches a registry record with no conflicts
  | 'mac_change'           // assetId matched but MAC differs (firmware reflash / swap)
  | 'identifier_match'     // matched by deviceIdentifier only; no assetId on observation
  | 'ambiguous_match'      // multiple candidates found — human must resolve
  | 'new_unlinked_device'; // no match found; device is not yet in the registry

/**
 * The specific signal that drove the reconciliation outcome.
 * Provides an audit-readable reason alongside the match type.
 */
export type ReconciliationReason =
  | 'asset_id_exact'            // assetId matched a registry record; MAC consistent
  | 'asset_id_with_mac_change'  // assetId matched; MAC in registry differs from observed
  | 'device_identifier_match'   // deviceIdentifier matched a single registry record
  | 'mac_address_match'         // MAC matched a single registry record; no assetId present
  | 'multiple_candidates'       // more than one record matched — cannot auto-resolve
  | 'no_candidates';            // no registry record matched any available signal

/**
 * An observed sensor identity snapshot — the set of signals that a Tachyon
 * hub can report about a device at discovery or periodic scan time.
 *
 * All three identity fields are nullable because discovery paths vary:
 *   - QR scan   → assetId known; MAC and identifier may not be available yet
 *   - BLE advert → MAC + identifier visible; no assetId unless device broadcasts it
 *   - Cloud poll  → identifier present; MAC may be hidden by the cloud layer
 */
export interface SensorIdentityObservation {
  /** BeeKeeper stable identity scanned from QR label or advertised by device. */
  assetId: AssetId | null;
  /** Vendor/native device identifier (BLE name, serial number, etc.). */
  deviceIdentifier: string | null;
  /** MAC address seen at this observation moment (transport identity). */
  observedMacAddress: string | null;
  /** When this observation was captured (ISO 8601). */
  observedAt: TimestampISO;
}

/**
 * The result of reconciling a SensorIdentityObservation against the registry.
 *
 * Always explicit — callers must read matchType and manualReviewRequired
 * before taking any action. Never silently auto-links ambiguous cases.
 */
export interface SensorReconciliationResult {
  matchType: ReconciliationMatchType;
  reason: ReconciliationReason;
  /** The matched registry record. Null for ambiguous_match and new_unlinked_device. */
  matchedRecord: SensorRegistryRecord | null;
  /** The MAC stored in the registry at reconciliation time (normalized, uppercase). */
  previousMac: string | null;
  /** The MAC seen in this observation (normalized, uppercase). */
  observedMac: string | null;
  /**
   * True when the matched record's MAC should be updated to observedMac.
   * Only true for mac_change and identifier_match-with-different-MAC cases.
   */
  relinkRequired: boolean;
  /**
   * True when this result must not be acted on without human confirmation.
   * Always true for ambiguous_match; never true for new_unlinked_device.
   */
  manualReviewRequired: boolean;
  /**
   * All candidate records considered during reconciliation.
   * Non-empty for ambiguous_match — useful for building a conflict-resolution UI.
   * Sorted deterministically by record.id (ascending) so callers receive a stable
   * ordering regardless of the order in which records were passed to the function.
   */
  candidates: SensorRegistryRecord[];
  /**
   * True when a higher-tier signal resolved to a matched record, but a
   * lower-tier signal (typically observedMacAddress) pointed to a *different*
   * registry record at the same time.
   *
   * Does NOT change matchType — the higher-tier match still wins.
   * Does NOT block buildAssetLinkIntent.
   * Exists purely to surface the disagreement for audit trails, operator
   * review, and callers that want to run a MAC uniqueness pre-flight before
   * executing relinkRequired.
   *
   * Always false for ambiguous_match and new_unlinked_device.
   */
  crossTierConflict: boolean;
}

/**
 * An intent to link a discovered observation to an existing registry record.
 * Built by buildAssetLinkIntent() from a resolved SensorReconciliationResult.
 *
 * This is a pure value object — callers execute it against the persistence layer.
 */
export interface AssetLinkIntent {
  /** The registry record to update. */
  registryId: UUID;
  /** The observed MAC address to write to the record (may be null). */
  observedMacAddress: string | null;
  /** The vendor identifier to write to the record (may be null). */
  deviceIdentifier: string | null;
  /** The actor who initiated the link (null for automated reconciliation). */
  actorId: UUID | null;
  /** When this intent was created (ISO 8601). */
  linkedAt: TimestampISO;
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
