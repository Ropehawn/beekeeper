/**
 * apps/web/src/adapters/hive-coverage.ts
 *
 * HTTP transport for GET /api/v1/hives/coverage.
 */

function getToken(): string | null {
  return localStorage.getItem('beekeeper_token');
}

function baseUrl(): string {
  return (typeof window !== 'undefined' && (window as any).__BEEKEEPER_API_URL) || '';
}

// ---------------------------------------------------------------------------
// Response shapes (mirror the API)
// ---------------------------------------------------------------------------

export interface CoverageDevice {
  id:                string;
  name:              string;
  deviceId:          string;
  locationRole:      string | null;
  deploymentProfile: string | null;
}

/** One bucket row — key, display label, coverage flag, and device list come from the server. */
export interface CoverageBucket {
  key:     string;
  label:   string;
  covered: boolean;
  devices: CoverageDevice[];
}

export interface HiveCoverageItem {
  hiveId:               string;
  hiveName:             string;
  /** Total active sensors assigned to this hive */
  assignedCount:        number;
  /** Sensors assigned but with no useful deploymentProfile (null or "custom") */
  withoutProfileCount:  number;
  /** Ordered bucket array — iterate directly, do not hardcode bucket keys on the client */
  buckets:              CoverageBucket[];
}

export interface HiveCoverageResponse {
  items: HiveCoverageItem[];
  count: number;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function fetchHiveCoverage(): Promise<HiveCoverageResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res  = await fetch(`${baseUrl()}/api/v1/hives/coverage`, { method: 'GET', headers });
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error || `Request failed (${res.status})`);
  return data as HiveCoverageResponse;
}
