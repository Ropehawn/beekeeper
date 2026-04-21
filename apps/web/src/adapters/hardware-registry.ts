/**
 * apps/web/src/adapters/hardware-registry.ts
 *
 * Ownership:
 *   All HTTP calls that belong to the hardware registry / provisioning lane.
 *   This adapter is the single point of contact between the registry UI
 *   and the backend API routes under /api/v1/sensors and /api/v1/cameras
 *   that deal with provisioning, registration, and assignment — not live
 *   observability data (readings, signal health).
 *
 * Owns:
 *   Sensor: testProtectConnection, fetchSensorDevices, runSensorDiscovery,
 *           assignSensorToHive, removeSensorDevice
 *   Camera: fetchCameraDevices, runCameraDiscovery,
 *           assignCameraToHive, removeCameraDevice
 *
 * Does NOT own:
 *   - getCameraSnapshotUrl  (URL builder for live snapshots — observability lane)
 *   - getLatestSensorReading / getSensorHistory  (live readings — observability lane)
 */

// ---------------------------------------------------------------------------
// Auth / transport
// Token storage key matches apps/web/public/api-client.js (beekeeper_token).
// BASE matches the same-origin default; override via window.__BEEKEEPER_API_URL
// if that global is set (mirrors BeeAPI behaviour).
// ---------------------------------------------------------------------------

function getToken(): string | null {
  return localStorage.getItem('beekeeper_token');
}

function baseUrl(): string {
  return (typeof window !== 'undefined' && (window as any).__BEEKEEPER_API_URL) || '';
}

async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts: RequestInit = { method, headers };
  if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl()}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error || `Request failed (${res.status})`);
  return data as T;
}

// ---------------------------------------------------------------------------
// Response shapes — mirrored from observed API responses in index.html.
// No transformation applied; values are returned exactly as the server sends them.
// ---------------------------------------------------------------------------

export interface ProtectConnectionStatus {
  connected: boolean;
  sensorCount?: number;
  error?: string;
}

export interface DiscoveredSensor {
  id: string;
  name: string;
  type: string;
  connected: boolean;
  tempF: number | null;
  humidity: number | null;
  lux: number | null;
}

export interface DiscoveredCamera {
  id: string;
  name: string;
  type: string;
  connected: boolean;
  resWidth?: number;
  resHeight?: number;
}

export interface SensorDeviceRecord {
  id: string;
  deviceId: string;
  name: string;
  hiveId: string | null;
  hiveName: string | null;
  pollInterval: number | null;
  locationRole: string | null;
  locationNote: string | null;
  deploymentProfile: string | null;
  createdAt: string;
}

export interface CameraDeviceRecord {
  id: string;
  unifiDeviceId: string;
  name: string;
  hiveId: string | null;
  hiveName: string | null;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * Verify that the server can reach api.ui.com with the configured UNIFI_API_KEY.
 * Used to render the connection status banner on the Sensors admin page.
 * GET /api/v1/sensors/test-connection
 */
export async function testProtectConnection(): Promise<ProtectConnectionStatus> {
  return apiFetch('GET', '/api/v1/sensors/test-connection');
}

// ---------------------------------------------------------------------------
// Sensor discovery
// ---------------------------------------------------------------------------

/**
 * List all sensors visible on the UniFi Protect console.
 * Returns live-connected devices regardless of whether they are registered
 * in BeeKeeper — used to populate the Discover Sensors modal.
 * GET /api/v1/sensors/discover → { sensors: DiscoveredSensor[] }
 */
export async function runSensorDiscovery(): Promise<DiscoveredSensor[]> {
  const result = await apiFetch<{ sensors: DiscoveredSensor[] }>('GET', '/api/v1/sensors/discover');
  return result.sensors;
}

// ---------------------------------------------------------------------------
// Sensor devices (registry)
// ---------------------------------------------------------------------------

/**
 * Return all sensor devices registered in the BeeKeeper database.
 * Each record includes the hive assignment (hiveName) and poll interval.
 * GET /api/v1/sensors/devices
 */
export async function fetchSensorDevices(): Promise<SensorDeviceRecord[]> {
  return apiFetch('GET', '/api/v1/sensors/devices');
}

/**
 * Register (or re-register) a UniFi Protect sensor and optionally assign it
 * to a hive. This is the single "assign sensor to hive" action in the current
 * provisioning flow.
 * POST /api/v1/sensors/devices
 * Body: { name, unifiDeviceId, hiveId?, pollInterval? }
 */
export async function assignSensorToHive(data: {
  name: string;
  unifiDeviceId: string;
  hiveId?: string;
  pollInterval?: number;
  locationRole?: string | null;
  locationNote?: string | null;
  deploymentProfile?: string | null;
}): Promise<SensorDeviceRecord> {
  return apiFetch('POST', '/api/v1/sensors/devices', data);
}

/**
 * Soft-delete (deactivate) a registered sensor device. Stops polling for
 * the linked hive. The device can be re-registered via assignSensorToHive.
 * DELETE /api/v1/sensors/devices/:id
 */
export async function removeSensorDevice(id: string): Promise<void> {
  return apiFetch('DELETE', `/api/v1/sensors/devices/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Camera discovery
// ---------------------------------------------------------------------------

/**
 * List all cameras visible on the UniFi Protect console.
 * Returns live-connected cameras regardless of whether they are registered
 * in BeeKeeper — used to populate the Discover Cameras modal.
 * GET /api/v1/cameras/discover → { cameras: DiscoveredCamera[] }
 */
export async function runCameraDiscovery(): Promise<DiscoveredCamera[]> {
  const result = await apiFetch<{ cameras: DiscoveredCamera[] }>('GET', '/api/v1/cameras/discover');
  return result.cameras;
}

// ---------------------------------------------------------------------------
// Camera devices (registry)
// ---------------------------------------------------------------------------

/**
 * Return all camera devices registered in the BeeKeeper database.
 * Each record includes the hive assignment (hiveName).
 * GET /api/v1/cameras/devices
 */
export async function fetchCameraDevices(): Promise<CameraDeviceRecord[]> {
  return apiFetch('GET', '/api/v1/cameras/devices');
}

/**
 * Register a UniFi Protect camera and optionally assign it to a hive.
 * This is the single "assign camera to hive" action in the current
 * provisioning flow.
 * POST /api/v1/cameras/devices
 * Body: { unifiDeviceId, name, hiveId? }
 */
export async function assignCameraToHive(data: {
  unifiDeviceId: string;
  name: string;
  hiveId?: string;
}): Promise<CameraDeviceRecord> {
  return apiFetch('POST', '/api/v1/cameras/devices', data);
}

/**
 * Remove a registered camera device. Does not affect snapshot/stream URLs
 * that may be cached in the UI — callers should evict those separately.
 * DELETE /api/v1/cameras/devices/:id
 */
export async function removeCameraDevice(id: string): Promise<void> {
  return apiFetch('DELETE', `/api/v1/cameras/devices/${encodeURIComponent(id)}`);
}
