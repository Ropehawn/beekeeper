// packages/domain/hardware/constants.ts
import type { DeviceRole, AssetType, AssetIdPrefix } from './types';

// ---------------------------------------------------------------------------
// Signal freshness thresholds
// ---------------------------------------------------------------------------

export const FRESH_THRESHOLD_MS = 5 * 60 * 1000;
export const STALE_THRESHOLD_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Battery voltage thresholds
// ---------------------------------------------------------------------------

export const BATTERY_OK_V = 2.8;
export const BATTERY_LOW_V = 2.4;

// ---------------------------------------------------------------------------
// Prediction readiness — required device roles
// ---------------------------------------------------------------------------

export const PREDICTION_REQUIRED_ROLES: readonly DeviceRole[] = [
  'primary_environment',
  'thermal_map',
  'weight',
  'audio',
  'entrance_camera',
] as const;

// ---------------------------------------------------------------------------
// Observability capability groups
// ---------------------------------------------------------------------------

export const ENVIRONMENTAL_ROLES: readonly DeviceRole[] = [
  'primary_environment',
  'ambient_weather',
] as const;

export const VISION_ROLES: readonly DeviceRole[] = [
  'entrance_camera',
  'apiary_camera',
] as const;

export const STRUCTURAL_ROLES: readonly DeviceRole[] = [
  'weight',
  'thermal_map',
] as const;

export const ACOUSTIC_ROLES: readonly DeviceRole[] = [
  'audio',
] as const;

// ---------------------------------------------------------------------------
// Asset ID formatting
// ---------------------------------------------------------------------------

// Global namespace prefix applied to every BeeKeeper asset ID.
export const ASSET_ID_PREFIX = 'BK' as const;

// Zero-padded width for the numeric sequence segment (e.g. 000241).
export const ASSET_ID_SEQUENCE_PAD = 6 as const;

// Mapping from AssetType to the short prefix used in the formatted ID.
export const ASSET_ID_PREFIXES: Record<AssetType, AssetIdPrefix> = {
  sensor:               'SEN',
  camera:               'CAM',
  weight_assembly:      'WGT',
  hub:                  'HUB',
  acoustic_assembly:    'AUD',
  environment_assembly: 'ENV',
} as const;

// Validates a formatted BeeKeeper asset ID, e.g. BK-SEN-000241.
// Pattern: BK - <3-letter prefix> - <6-digit sequence>
export const ASSET_ID_REGEX = /^BK-(SEN|CAM|WGT|HUB|AUD|ENV)-\d{6}$/;
