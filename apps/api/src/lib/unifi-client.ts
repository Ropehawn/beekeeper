/**
 * UniFi Protect cloud connector client for sensor readings.
 *
 * Uses the official UniFi Cloud Connector API to proxy requests from
 * Railway → api.ui.com → your Protect console, with no local NVR exposure.
 *
 * Official connector pattern (from developer.ui.com/protect):
 *   GET https://api.ui.com/v1/connector/consoles/{hostId}/proxy/protect/integration/v1/sensors
 *
 * Auth: X-API-Key header using the Site Manager API key (UNIFI_API_KEY env var).
 * Host ID: the console's ID from GET https://api.ui.com/v1/hosts (UNIFI_HOST_ID env var).
 *
 * The Protect API servers block specifies base path "/integration", so the
 * local path /integration/v1/sensors becomes the proxy suffix
 * /proxy/protect/integration/v1/sensors in the connector URL.
 *
 * Returns null on any error (network, auth, timeout, parse failure).
 * The caller is responsible for fallback behavior (stale DB reading, etc.).
 */

export interface UnifiSensorReading {
  tempC:    number | null;
  humidity: number | null;
  lux:      number | null;
}

// Shape returned by GET /api/v1/sensors/discover → the frontend assign flow
export interface UnifiDiscoveredSensor {
  id:        string;
  name:      string;
  type:      string;      // "temperature" | "motion" | "contact" | "sensor"
  connected: boolean;
  tempF:     number | null;
  humidity:  number | null;
  lux:       number | null;
}

// Shape returned by GET /api/v1/cameras/discover → the frontend assign flow
export interface UnifiDiscoveredCamera {
  id:        string;
  name:      string;
  type:      string;      // model type e.g. "UVC G4 Bullet"
  connected: boolean;
  resWidth:  number | null;
  resHeight: number | null;
}

const BASE_URL   = "https://api.ui.com";
const TIMEOUT_MS = 10_000;

/**
 * Build the Cloud Connector URL for a given Protect API path.
 *
 * Pattern: /v1/connector/consoles/{hostId}/proxy/protect/integration/v1/{resource}
 */
function connectorUrl(hostId: string, protectPath: string): string {
  // protectPath should start with /v1/... (the Protect integration API path)
  return `${BASE_URL}/v1/connector/consoles/${hostId}/proxy/protect/integration${protectPath}`;
}

/**
 * Fetch the latest reading for a single UniFi Protect sensor.
 *
 * @param unifiDeviceId - The UniFi sensor ID (stored in sensor_devices.device_id)
 * @param apiKey        - Site Manager API key (UNIFI_API_KEY env var)
 * @param hostId        - Protect console host ID (UNIFI_HOST_ID env var)
 * @returns             Parsed sensor reading, or null on any error
 */
export async function fetchUnifiSensor(
  unifiDeviceId: string,
  apiKey: string,
  hostId: string
): Promise<UnifiSensorReading | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = connectorUrl(hostId, `/v1/sensors/${encodeURIComponent(unifiDeviceId)}`);
    const res = await fetch(url, {
      method:  "GET",
      headers: { "X-API-Key": apiKey, "Accept": "application/json" },
      signal:  controller.signal,
    });

    if (!res.ok) return null;

    const json = await res.json() as Record<string, unknown>;

    // Protect API may return the sensor object directly or wrapped in a `data` envelope
    const sensor = (json?.data ?? json) as Record<string, unknown>;
    const stats  = sensor?.stats as Record<string, unknown> | undefined;

    return {
      tempC:    (stats?.temperature as any)?.value ?? (sensor?.temperature as number | null | undefined) ?? null,
      humidity: (stats?.humidity    as any)?.value ?? (sensor?.humidity    as number | null | undefined) ?? null,
      lux:      (stats?.light       as any)?.value ?? (sensor?.illuminance as number | null | undefined) ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * List all sensors on a Protect console via the cloud connector.
 * Used by GET /api/v1/sensors/discover and GET /api/v1/sensors/test-connection.
 *
 * @param apiKey  - Site Manager API key (UNIFI_API_KEY env var)
 * @param hostId  - Protect console host ID (UNIFI_HOST_ID env var)
 * @returns       Array of discovered sensors, or null on any error
 */
export async function fetchAllUnifiSensors(
  apiKey: string,
  hostId: string
): Promise<UnifiDiscoveredSensor[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = connectorUrl(hostId, "/v1/sensors");
    const res = await fetch(url, {
      method:  "GET",
      headers: { "X-API-Key": apiKey, "Accept": "application/json" },
      signal:  controller.signal,
    });

    if (!res.ok) return null;

    const json = await res.json() as unknown;

    // Handle both a bare array and a { data: [...] } envelope
    const raw = Array.isArray(json)
      ? json
      : Array.isArray((json as Record<string, unknown>)?.data)
        ? (json as Record<string, unknown>).data as unknown[]
        : null;

    if (!raw) return null;

    return (raw as Record<string, unknown>[]).reduce<UnifiDiscoveredSensor[]>((acc, s) => {
      const id = String(s?.id ?? "");
      if (!id) return acc;

      const stats      = (s?.stats ?? {}) as Record<string, unknown>;
      const hasTemp    = stats?.temperature != null;
      const hasMotion  = stats?.motion      != null;
      const hasContact = stats?.contact     != null;

      const type = hasTemp ? "temperature" : hasMotion ? "motion" : hasContact ? "contact" : "sensor";

      const tempC = (stats?.temperature as Record<string, number> | undefined)?.value ?? null;
      const tempF = tempC != null ? Math.round(((tempC * 9) / 5 + 32) * 10) / 10 : null;

      const connected =
        s?.state === "CONNECTED" ||
        (s?.bluetoothConnectionState as Record<string, unknown> | undefined)?.connected === true ||
        s?.connected === true;

      acc.push({
        id,
        name:     String(s?.name ?? "Unknown Sensor"),
        type,
        connected,
        tempF,
        humidity: (stats?.humidity as Record<string, number> | undefined)?.value ?? null,
        lux:      (stats?.light    as Record<string, number> | undefined)?.value ?? null,
      });
      return acc;
    }, []);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Camera functions ─────────────────────────────────────────────────────────

const SNAPSHOT_TIMEOUT_MS = 15_000;

/**
 * List all cameras on a Protect console via the cloud connector.
 */
export async function fetchAllUnifiCameras(
  apiKey: string,
  hostId: string
): Promise<UnifiDiscoveredCamera[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = connectorUrl(hostId, "/v1/cameras");
    const res = await fetch(url, {
      method:  "GET",
      headers: { "X-API-Key": apiKey, "Accept": "application/json" },
      signal:  controller.signal,
    });

    if (!res.ok) return null;

    const json = await res.json() as unknown;
    const raw = Array.isArray(json)
      ? json
      : Array.isArray((json as Record<string, unknown>)?.data)
        ? (json as Record<string, unknown>).data as unknown[]
        : null;

    if (!raw) return null;

    return (raw as Record<string, unknown>[]).reduce<UnifiDiscoveredCamera[]>((acc, c) => {
      const id = String(c?.id ?? "");
      if (!id) return acc;

      const channels = Array.isArray(c?.channels) ? c.channels as Record<string, unknown>[] : [];
      const mainCh = channels[0] ?? {};

      const connected =
        c?.state === "CONNECTED" ||
        c?.isConnected === true ||
        c?.connected === true;

      acc.push({
        id,
        name:      String(c?.name ?? "Unknown Camera"),
        type:      String(c?.type ?? c?.modelKey ?? "camera"),
        connected,
        resWidth:  (mainCh?.width  as number | undefined) ?? null,
        resHeight: (mainCh?.height as number | undefined) ?? null,
      });
      return acc;
    }, []);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch a camera snapshot from UniFi Protect via the cloud connector.
 * Returns the raw JPEG buffer, or null on any error.
 */
export async function fetchCameraSnapshot(
  cameraId: string,
  apiKey: string,
  hostId: string
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);

  try {
    // Protect snapshot uses the direct proxy path, not the /integration path
    const url = `${BASE_URL}/v1/connector/consoles/${hostId}/proxy/protect/api/cameras/${cameraId}/snapshot`;
    const res = await fetch(url, {
      method:  "GET",
      headers: { "X-API-Key": apiKey },
      signal:  controller.signal,
    });

    if (!res.ok) {
      // Try the integration path as fallback
      const url2 = connectorUrl(hostId, `/v1/cameras/${cameraId}/snapshot`);
      const res2 = await fetch(url2, {
        method:  "GET",
        headers: { "X-API-Key": apiKey },
        signal:  controller.signal,
      });
      if (!res2.ok) return null;
      const arrayBuf2 = await res2.arrayBuffer();
      return Buffer.from(arrayBuf2);
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
