// packages/domain/hardware/actions.ts
import type {
  UUID,
  TimestampISO,
  DeviceKind,
  DeviceRole,
  DeviceVendor,
  SensorModel,
  CameraModel,
  SensorDevice,
  CameraDevice,
  DeviceAssignment,
  AssetId,
  AssetIdParts,
  AssetIdPrefix,
} from './types';
import {
  ASSET_ID_PREFIX,
  ASSET_ID_SEQUENCE_PAD,
  ASSET_ID_REGEX,
} from './constants';

// ---------------------------------------------------------------------------
// Role compatibility
// ---------------------------------------------------------------------------

type AnyDevice = SensorDevice | CameraDevice;

const SENSOR_ROLE_MAP: Record<SensorModel, DeviceRole[]> = {
  sc833f: ['primary_environment'],
  s05t: ['thermal_map'],
  bme280: ['primary_environment', 'ambient_weather'],
  hx711: ['weight'],
  inmp441: ['audio'],
  generic: ['primary_environment', 'ambient_weather', 'unknown'],
};

const CAMERA_ROLE_MAP: Record<CameraModel, DeviceRole[]> = {
  imx519: ['entrance_camera', 'apiary_camera'],
  g4_bullet: ['entrance_camera', 'apiary_camera'],
  g5_flex: ['entrance_camera', 'apiary_camera'],
  generic: ['entrance_camera', 'apiary_camera', 'unknown'],
};

export function compatibleRoles(device: AnyDevice): DeviceRole[] {
  if (device.kind === 'sensor') {
    return SENSOR_ROLE_MAP[device.model] ?? ['unknown'];
  }
  return CAMERA_ROLE_MAP[device.model] ?? ['unknown'];
}

export function isRoleCompatible(
  device: AnyDevice,
  role: DeviceRole,
): boolean {
  return compatibleRoles(device).includes(role);
}

// ---------------------------------------------------------------------------
// Assignment validation
// ---------------------------------------------------------------------------

export type AssignmentError =
  | 'device_inactive'
  | 'hive_id_required'
  | 'role_incompatible'
  | 'already_assigned_same_hive_and_role';

export interface AssignmentValidation {
  valid: boolean;
  errors: AssignmentError[];
}

export function validateAssignment(
  device: AnyDevice,
  hiveId: UUID | null,
  role: DeviceRole,
): AssignmentValidation {
  const errors: AssignmentError[] = [];

  if (!device.isActive) {
    errors.push('device_inactive');
  }
  if (hiveId === null) {
    errors.push('hive_id_required');
  }
  if (!isRoleCompatible(device, role)) {
    errors.push('role_incompatible');
  }
  if (device.hiveId !== null && device.hiveId === hiveId && device.role === role) {
    errors.push('already_assigned_same_hive_and_role');
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Assignment payload
// ---------------------------------------------------------------------------

export interface AssignmentIntent {
  deviceId: UUID;
  hiveId: UUID;
  role: DeviceRole;
  nowISO: TimestampISO;
}

export function buildAssignmentPayload(
  intent: AssignmentIntent,
): DeviceAssignment {
  return {
    deviceId: intent.deviceId,
    hiveId: intent.hiveId,
    role: intent.role,
    assignedAt: intent.nowISO,
  };
}

export function buildAssignment(
  device: AnyDevice,
  hiveId: UUID,
  role: DeviceRole,
  nowISO: TimestampISO,
): { assignment: DeviceAssignment; validation: AssignmentValidation } {
  const validation = validateAssignment(device, hiveId, role);
  const assignment = buildAssignmentPayload({
    deviceId: device.id,
    hiveId,
    role,
    nowISO,
  });
  return { assignment, validation };
}

// ---------------------------------------------------------------------------
// Unassignment
// ---------------------------------------------------------------------------

export interface UnassignmentResult {
  deviceId: UUID;
  previousHiveId: UUID;
  previousRole: DeviceRole;
}

export function buildUnassignment(
  device: AnyDevice,
): UnassignmentResult | null {
  if (device.hiveId === null) return null;
  return {
    deviceId: device.id,
    previousHiveId: device.hiveId,
    previousRole: device.role,
  };
}

// ---------------------------------------------------------------------------
// MAC reconciliation
// ---------------------------------------------------------------------------

export type MacChangeOutcome =
  | 'no_change'
  | 'first_mac'
  | 'mac_updated';

export interface MacReconciliation {
  outcome: MacChangeOutcome;
  previousMac: string | null;
  newMac: string;
}

export function reconcileMacChange(
  device: SensorDevice,
  observedMac: string,
): MacReconciliation {
  const normalizedObserved = observedMac.toUpperCase().trim();
  const normalizedCurrent = device.currentMacAddress?.toUpperCase().trim() ?? null;

  if (normalizedCurrent === null) {
    return {
      outcome: 'first_mac',
      previousMac: null,
      newMac: normalizedObserved,
    };
  }

  if (normalizedCurrent === normalizedObserved) {
    return {
      outcome: 'no_change',
      previousMac: normalizedCurrent,
      newMac: normalizedObserved,
    };
  }

  return {
    outcome: 'mac_updated',
    previousMac: normalizedCurrent,
    newMac: normalizedObserved,
  };
}

// ---------------------------------------------------------------------------
// Device identity matching
// ---------------------------------------------------------------------------

export function devicesMatchByIdentifier(
  a: AnyDevice,
  b: AnyDevice,
): boolean {
  return (
    a.kind === b.kind &&
    a.deviceIdentifier === b.deviceIdentifier &&
    a.vendor === b.vendor
  );
}

export function findExistingDevice(
  devices: AnyDevice[],
  identifier: string,
  vendor: DeviceVendor,
  kind: DeviceKind,
): AnyDevice | null {
  return (
    devices.find(
      (d) =>
        d.deviceIdentifier === identifier &&
        d.vendor === vendor &&
        d.kind === kind,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Asset ID helpers
// ---------------------------------------------------------------------------

export function formatAssetId(parts: AssetIdParts): AssetId {
  const padded = String(parts.sequence).padStart(ASSET_ID_SEQUENCE_PAD, '0');
  return `${ASSET_ID_PREFIX}-${parts.prefix}-${padded}`;
}

export function parseAssetId(assetId: string): AssetIdParts | null {
  if (!ASSET_ID_REGEX.test(assetId)) return null;
  const segments = assetId.split('-');
  // segments: ['BK', prefix, sequence]
  const prefix = segments[1] as AssetIdPrefix;
  const sequence = parseInt(segments[2], 10);
  return { prefix, sequence };
}

export function isValidAssetId(assetId: string): boolean {
  return ASSET_ID_REGEX.test(assetId);
}
