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
  SensorRegistryRecord,
  SensorIdentityObservation,
  SensorReconciliationResult,
  AssetLinkIntent,
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

// ---------------------------------------------------------------------------
// Tachyon-native sensor identity reconciliation
// ---------------------------------------------------------------------------

/** Sort registry records by id ascending — stable, input-order-independent. */
function sortById(records: SensorRegistryRecord[]): SensorRegistryRecord[] {
  return records.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Reconcile a Tachyon SensorIdentityObservation against the sensor registry.
 *
 * Decision tree (highest-confidence signal evaluated first):
 *
 *   1. assetId present
 *      └─ 0 registry matches → fall through to step 2
 *      └─ 2+ matches (data error) → ambiguous_match / multiple_candidates
 *      └─ 1 match, MAC consistent (or no MAC to compare) → exact_match / asset_id_exact
 *      └─ 1 match, MAC differs → mac_change / asset_id_with_mac_change, relinkRequired
 *
 *   2. deviceIdentifier present
 *      └─ 0 matches → fall through to step 3
 *      └─ 2+ matches → ambiguous_match / multiple_candidates
 *      └─ 1 match → identifier_match / device_identifier_match
 *                   (relinkRequired if MAC also differs)
 *
 *   3. observedMacAddress present
 *      └─ 0 matches → fall through to step 4
 *      └─ 2+ matches → ambiguous_match / multiple_candidates
 *      └─ 1 match → exact_match / mac_address_match
 *
 *   4. No signal matched → new_unlinked_device / no_candidates
 *
 * Rules:
 *   - Never silently acts on ambiguous results (manualReviewRequired = true)
 *   - assetId is trusted over MAC — a MAC change on a known assetId is auto-resolvable
 *   - A null observed MAC is not treated as a MAC conflict (absence ≠ mismatch)
 *   - Returns an explicit result object for every case; never throws or returns null
 */
export function reconcileSensorIdentity(
  records: SensorRegistryRecord[],
  observation: SensorIdentityObservation,
): SensorReconciliationResult {
  const normalizedObservedMac =
    observation.observedMacAddress?.toUpperCase().trim() ?? null;

  // ── Step 1: match by assetId ─────────────────────────────────────────────
  if (observation.assetId !== null) {
    const byAssetId = records.filter((r) => r.assetId === observation.assetId);

    if (byAssetId.length > 1) {
      // assetId should be globally unique — data integrity issue.
      return {
        matchType: 'ambiguous_match',
        reason: 'multiple_candidates',
        matchedRecord: null,
        previousMac: null,
        observedMac: normalizedObservedMac,
        relinkRequired: false,
        manualReviewRequired: true,
        crossTierConflict: false,
        candidates: sortById(byAssetId),
      };
    }

    if (byAssetId.length === 1) {
      const record = byAssetId[0];
      const normalizedRecordMac =
        record.currentMacAddress?.toUpperCase().trim() ?? null;

      // MAC "changed" only when both sides are non-null and differ.
      // A null observation MAC means the transport layer didn't report one —
      // not a conflict.
      const macChanged =
        normalizedObservedMac !== null &&
        normalizedRecordMac !== null &&
        normalizedObservedMac !== normalizedRecordMac;

      // Cross-tier conflict: does the observed MAC belong to a *different*
      // registry record? If so, executing relinkRequired without a uniqueness
      // check would produce a MAC collision in the registry.
      const crossTierConflict =
        normalizedObservedMac !== null &&
        records.some(
          (r) =>
            r.id !== record.id &&
            r.currentMacAddress?.toUpperCase().trim() === normalizedObservedMac,
        );

      return {
        matchType: macChanged ? 'mac_change' : 'exact_match',
        reason: macChanged ? 'asset_id_with_mac_change' : 'asset_id_exact',
        matchedRecord: record,
        previousMac: normalizedRecordMac,
        observedMac: normalizedObservedMac,
        relinkRequired: macChanged,
        manualReviewRequired: false,
        crossTierConflict,
        candidates: [record],
      };
    }
    // byAssetId.length === 0 — assetId not yet in registry; fall through.
  }

  // ── Step 2: match by deviceIdentifier ───────────────────────────────────
  if (observation.deviceIdentifier !== null) {
    const byIdentifier = records.filter(
      (r) => r.deviceIdentifier === observation.deviceIdentifier,
    );

    if (byIdentifier.length > 1) {
      return {
        matchType: 'ambiguous_match',
        reason: 'multiple_candidates',
        matchedRecord: null,
        previousMac: null,
        observedMac: normalizedObservedMac,
        relinkRequired: false,
        manualReviewRequired: true,
        crossTierConflict: false,
        candidates: sortById(byIdentifier),
      };
    }

    if (byIdentifier.length === 1) {
      const record = byIdentifier[0];
      const normalizedRecordMac =
        record.currentMacAddress?.toUpperCase().trim() ?? null;

      // MAC differs on an identifier match → a relink is needed but not
      // ambiguous (the identifier is the authoritative signal here).
      const relinkRequired =
        normalizedObservedMac !== null &&
        normalizedRecordMac !== null &&
        normalizedObservedMac !== normalizedRecordMac;

      // Cross-tier conflict: the observed MAC points to a different record.
      const crossTierConflict =
        normalizedObservedMac !== null &&
        records.some(
          (r) =>
            r.id !== record.id &&
            r.currentMacAddress?.toUpperCase().trim() === normalizedObservedMac,
        );

      return {
        matchType: 'identifier_match',
        reason: 'device_identifier_match',
        matchedRecord: record,
        previousMac: normalizedRecordMac,
        observedMac: normalizedObservedMac,
        relinkRequired,
        manualReviewRequired: false,
        crossTierConflict,
        candidates: [record],
      };
    }
    // byIdentifier.length === 0 — fall through.
  }

  // ── Step 3: match by MAC address (transport identity, last resort) ───────
  if (normalizedObservedMac !== null) {
    const byMac = records.filter(
      (r) =>
        r.currentMacAddress?.toUpperCase().trim() === normalizedObservedMac,
    );

    if (byMac.length > 1) {
      return {
        matchType: 'ambiguous_match',
        reason: 'multiple_candidates',
        matchedRecord: null,
        previousMac: null,
        observedMac: normalizedObservedMac,
        relinkRequired: false,
        manualReviewRequired: true,
        crossTierConflict: false,
        candidates: sortById(byMac),
      };
    }

    if (byMac.length === 1) {
      const record = byMac[0];
      return {
        matchType: 'exact_match',
        reason: 'mac_address_match',
        matchedRecord: record,
        previousMac: normalizedObservedMac, // matched on this MAC — same value
        observedMac: normalizedObservedMac,
        relinkRequired: false,
        manualReviewRequired: false,
        crossTierConflict: false,
        candidates: [record],
      };
    }
  }

  // ── Step 4: no signal matched ─────────────────────────────────────────────
  return {
    matchType: 'new_unlinked_device',
    reason: 'no_candidates',
    matchedRecord: null,
    previousMac: null,
    observedMac: normalizedObservedMac,
    relinkRequired: false,
    manualReviewRequired: false,
    crossTierConflict: false,
    candidates: [],
  };
}

/**
 * Build an AssetLinkIntent from a resolved SensorReconciliationResult.
 *
 * Returns null when:
 *   - matchedRecord is null (ambiguous_match or new_unlinked_device)
 *   - manualReviewRequired is true (caller must obtain human confirmation first)
 *
 * Pass the original observation so the intent carries the deviceIdentifier
 * that Tachyon reported — useful for updating stale registry fields.
 */
export function buildAssetLinkIntent(
  result: SensorReconciliationResult,
  observation: SensorIdentityObservation,
  actorId: UUID | null,
  nowISO: TimestampISO,
): AssetLinkIntent | null {
  if (result.matchedRecord === null) return null;
  if (result.manualReviewRequired) return null;

  return {
    registryId: result.matchedRecord.id,
    observedMacAddress: result.observedMac,
    deviceIdentifier: observation.deviceIdentifier,
    actorId,
    linkedAt: nowISO,
  };
}
