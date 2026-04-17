/**
 * apps/web/src/pages/hardware-registry.ts
 *
 * Ownership:
 *   Page-level controller for the hardware registry / provisioning lane.
 *   Owns the in-memory page state for registry data and coordinates
 *   data loading via the hardware-registry adapter.
 *
 * Responsibilities:
 *   - Define and own the RegistryPageState shape
 *   - Load and refresh sensor/camera device records from the API
 *   - Run on-demand sensor/camera discovery scans
 *   - Expose read-only state to rendering layer (not yet wired)
 *
 * Does NOT own:
 *   - DOM rendering or event binding (rendering layer, not yet built)
 *   - API transport (hardware-registry adapter owns that)
 *   - Live observability data (readings, signal health, battery state)
 *   - Assignment/provisioning write actions (next phase)
 *
 * Current status:
 *   Read-only. No DOM wiring. Not yet called from public/index.html.
 *   Safe to import without side effects — state is module-local and
 *   not mutated until an explicit load/refresh function is called.
 */

import type {
  ProtectConnectionStatus,
  SensorDeviceRecord,
  CameraDeviceRecord,
  DiscoveredSensor,
  DiscoveredCamera,
} from '../adapters/hardware-registry';

import {
  testProtectConnection,
  fetchSensorDevices,
  fetchCameraDevices,
  runSensorDiscovery,
  runCameraDiscovery,
} from '../adapters/hardware-registry';

// ---------------------------------------------------------------------------
// Page state shape
// ---------------------------------------------------------------------------

export interface RegistryLoadState {
  status: 'idle' | 'loading' | 'success' | 'error';
  error: string | null;
}

export interface RegistryPageState {
  /** UniFi Protect API connectivity status. null until first checked. */
  connection: ProtectConnectionStatus | null;
  connectionLoad: RegistryLoadState;

  /** Devices already registered in the BeeKeeper database. */
  sensorDevices: SensorDeviceRecord[];
  sensorDevicesLoad: RegistryLoadState;

  cameraDevices: CameraDeviceRecord[];
  cameraDevicesLoad: RegistryLoadState;

  /** Devices visible on the UniFi Protect console (discovered, not yet registered). */
  discoveredSensors: DiscoveredSensor[];
  sensorDiscoveryLoad: RegistryLoadState;

  discoveredCameras: DiscoveredCamera[];
  cameraDiscoveryLoad: RegistryLoadState;
}

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

function idleLoad(): RegistryLoadState {
  return { status: 'idle', error: null };
}

export function createInitialRegistryPageState(): RegistryPageState {
  return {
    connection: null,
    connectionLoad: idleLoad(),

    sensorDevices: [],
    sensorDevicesLoad: idleLoad(),

    cameraDevices: [],
    cameraDevicesLoad: idleLoad(),

    discoveredSensors: [],
    sensorDiscoveryLoad: idleLoad(),

    discoveredCameras: [],
    cameraDiscoveryLoad: idleLoad(),
  };
}

// ---------------------------------------------------------------------------
// Module-level state
// Mutable by controller functions only. Rendering layer reads via getState().
// ---------------------------------------------------------------------------

let _state: RegistryPageState = createInitialRegistryPageState();

/** Return a shallow copy of the current page state. */
export function getRegistryPageState(): RegistryPageState {
  return { ..._state };
}

// ---------------------------------------------------------------------------
// Internal state helpers
// ---------------------------------------------------------------------------

function setLoad(
  key: keyof RegistryPageState,
  loadKey: keyof RegistryPageState,
  status: RegistryLoadState['status'],
  error: string | null = null,
): void {
  _state = {
    ..._state,
    [loadKey]: { status, error },
  };
  // Reset data field to empty on loading start so consumers don't read stale data
  if (status === 'loading') {
    const isArray = Array.isArray(_state[key]);
    _state = {
      ..._state,
      [key]: isArray ? [] : null,
    };
  }
}

function applyResult<K extends keyof RegistryPageState>(
  dataKey: K,
  loadKey: keyof RegistryPageState,
  value: RegistryPageState[K],
): void {
  _state = {
    ..._state,
    [dataKey]: value,
    [loadKey]: { status: 'success', error: null } satisfies RegistryLoadState,
  };
}

function applyError(loadKey: keyof RegistryPageState, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  _state = {
    ..._state,
    [loadKey]: { status: 'error', error: message } satisfies RegistryLoadState,
  };
}

// ---------------------------------------------------------------------------
// Connection check
// ---------------------------------------------------------------------------

/**
 * Check whether the server can reach the UniFi Protect API.
 * Updates state.connection and state.connectionLoad.
 */
export async function checkProtectConnection(): Promise<void> {
  setLoad('connection', 'connectionLoad', 'loading');
  try {
    const result = await testProtectConnection();
    applyResult('connection', 'connectionLoad', result);
  } catch (err) {
    applyError('connectionLoad', err);
  }
}

// ---------------------------------------------------------------------------
// Sensor devices
// ---------------------------------------------------------------------------

/**
 * Fetch all sensor devices registered in the BeeKeeper database.
 * Updates state.sensorDevices and state.sensorDevicesLoad.
 */
export async function refreshSensorDevices(): Promise<void> {
  setLoad('sensorDevices', 'sensorDevicesLoad', 'loading');
  try {
    const devices = await fetchSensorDevices();
    applyResult('sensorDevices', 'sensorDevicesLoad', devices);
  } catch (err) {
    applyError('sensorDevicesLoad', err);
  }
}

// ---------------------------------------------------------------------------
// Camera devices
// ---------------------------------------------------------------------------

/**
 * Fetch all camera devices registered in the BeeKeeper database.
 * Updates state.cameraDevices and state.cameraDevicesLoad.
 */
export async function refreshCameraDevices(): Promise<void> {
  setLoad('cameraDevices', 'cameraDevicesLoad', 'loading');
  try {
    const devices = await fetchCameraDevices();
    applyResult('cameraDevices', 'cameraDevicesLoad', devices);
  } catch (err) {
    applyError('cameraDevicesLoad', err);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Run the UniFi Protect sensor discovery scan.
 * Returns devices visible on the console regardless of registration status.
 * Updates state.discoveredSensors and state.sensorDiscoveryLoad.
 */
export async function discoverSensors(): Promise<void> {
  setLoad('discoveredSensors', 'sensorDiscoveryLoad', 'loading');
  try {
    const sensors = await runSensorDiscovery();
    applyResult('discoveredSensors', 'sensorDiscoveryLoad', sensors);
  } catch (err) {
    applyError('sensorDiscoveryLoad', err);
  }
}

/**
 * Run the UniFi Protect camera discovery scan.
 * Returns cameras visible on the console regardless of registration status.
 * Updates state.discoveredCameras and state.cameraDiscoveryLoad.
 */
export async function discoverCameras(): Promise<void> {
  setLoad('discoveredCameras', 'cameraDiscoveryLoad', 'loading');
  try {
    const cameras = await runCameraDiscovery();
    applyResult('discoveredCameras', 'cameraDiscoveryLoad', cameras);
  } catch (err) {
    applyError('cameraDiscoveryLoad', err);
  }
}

// ---------------------------------------------------------------------------
// Composite load
// ---------------------------------------------------------------------------

/**
 * Load all initial registry data in parallel:
 *   - Protect connection check
 *   - Registered sensor devices
 *   - Registered camera devices
 *
 * Discovery scans are intentionally excluded — they poll the UniFi cloud
 * and should only run on explicit user action, not on page load.
 *
 * Safe to call multiple times (idempotent state resets on each call).
 */
export async function loadRegistryPage(): Promise<void> {
  await Promise.all([
    checkProtectConnection(),
    refreshSensorDevices(),
    refreshCameraDevices(),
  ]);
}

// ---------------------------------------------------------------------------
// View-model helpers
// Pure functions. Accept RegistryPageState; return view-ready values.
// No DOM access, no side effects, no module state reads.
// ---------------------------------------------------------------------------

/**
 * The four states the connection banner can be in.
 * 'idle'    — checkProtectConnection has not been called yet.
 * 'loading' — request is in flight.
 * 'success' — server confirmed connectivity (result.connected may still be false).
 * 'error'   — network/fetch failure; state.connection is null.
 */
export type ConnectionBannerState = 'idle' | 'loading' | 'success' | 'error';

/**
 * Derive the display state for the Protect connection status banner.
 * Maps connectionLoad.status directly; callers inspect state.connection
 * for connected/sensorCount/error details when status === 'success'.
 */
export function getConnectionBannerState(
  state: RegistryPageState,
): ConnectionBannerState {
  return state.connectionLoad.status;
}

// --- Registered device counts ---

/** Number of sensor devices currently registered in the BeeKeeper database. */
export function registeredSensorCount(state: RegistryPageState): number {
  return state.sensorDevices.length;
}

/** Number of camera devices currently registered in the BeeKeeper database. */
export function registeredCameraCount(state: RegistryPageState): number {
  return state.cameraDevices.length;
}

// --- Discovery counts ---

/** Number of sensors returned by the most recent discovery scan. */
export function discoveredSensorCount(state: RegistryPageState): number {
  return state.discoveredSensors.length;
}

/** Number of cameras returned by the most recent discovery scan. */
export function discoveredCameraCount(state: RegistryPageState): number {
  return state.discoveredCameras.length;
}

// --- Empty states ---

/**
 * True when sensor discovery has completed successfully and returned
 * zero results. Distinct from 'idle' (not run yet) or 'loading'.
 */
export function isSensorDiscoveryEmpty(state: RegistryPageState): boolean {
  return (
    state.sensorDiscoveryLoad.status === 'success' &&
    state.discoveredSensors.length === 0
  );
}

/**
 * True when camera discovery has completed successfully and returned
 * zero results. Distinct from 'idle' (not run yet) or 'loading'.
 */
export function isCameraDiscoveryEmpty(state: RegistryPageState): boolean {
  return (
    state.cameraDiscoveryLoad.status === 'success' &&
    state.discoveredCameras.length === 0
  );
}

/**
 * True when the sensor device list has loaded successfully and is empty.
 * Use to decide whether to show the "No sensors assigned yet" empty state.
 */
export function isSensorRegistryEmpty(state: RegistryPageState): boolean {
  return (
    state.sensorDevicesLoad.status === 'success' &&
    state.sensorDevices.length === 0
  );
}

/**
 * True when the camera device list has loaded successfully and is empty.
 * Use to decide whether to show the "No cameras assigned yet" empty state.
 */
export function isCameraRegistryEmpty(state: RegistryPageState): boolean {
  return (
    state.cameraDevicesLoad.status === 'success' &&
    state.cameraDevices.length === 0
  );
}

// --- Loading / readiness ---

/**
 * True when any registry lane (connection, sensors, cameras, or either
 * discovery scan) is currently in flight.
 * Use to show a page-level loading indicator or disable global actions.
 */
export function isAnyLaneLoading(state: RegistryPageState): boolean {
  return (
    state.connectionLoad.status === 'loading' ||
    state.sensorDevicesLoad.status === 'loading' ||
    state.cameraDevicesLoad.status === 'loading' ||
    state.sensorDiscoveryLoad.status === 'loading' ||
    state.cameraDiscoveryLoad.status === 'loading'
  );
}

/**
 * True when the page has at least one piece of actionable data:
 * a known connection result, at least one registered device, or
 * at least one discovery result.
 *
 * False while the page is still in its initial loading state or if
 * all loads have failed. Use to decide whether to render the main
 * registry layout vs. a full-page loading/error screen.
 */
export function hasActionableData(state: RegistryPageState): boolean {
  return (
    state.connection !== null ||
    state.sensorDevices.length > 0 ||
    state.cameraDevices.length > 0 ||
    state.discoveredSensors.length > 0 ||
    state.discoveredCameras.length > 0
  );
}

// ---------------------------------------------------------------------------
// Renderer re-exports — bridge only
// Bundled here so the single /dist/pages/hardware-registry.js import gives the
// bridge access to renderers without a second dynamic import.
// Remove this block when the rendering layer is wired directly into the app.
// ---------------------------------------------------------------------------
export { renderRegistryTable, renderCameraRegistryTable } from '../components/hardware/registry-table';
export { renderDiscoveryPanel, renderCameraDiscoveryPanel } from '../components/hardware/discovery-panel';
