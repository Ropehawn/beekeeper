function getToken(): string | null {
  return localStorage.getItem('beekeeper_token');
}

function baseUrl(): string {
  return (typeof window !== 'undefined' && (window as any).__BEEKEEPER_API_URL) || '';
}

export interface NodeHealthItem {
  deviceMac:        string;
  vendor:           string;
  signalRssi:       number | null;
  lastSeenAt:       string;
  ageSec:           number;
  status:           'green' | 'yellow' | 'red';
  // Device identity (null when no sensor_devices row matched this MAC)
  sensorDeviceId:   string | null;
  sensorQrId:       string | null;
  // Hive context
  hiveId:           string | null;
  hiveName:         string | null;
  deviceLabel:      string | null;
  locationRole:     string | null;
  locationNote:     string | null;
  // Latest metric values — null when no reading exists in the window
  temperature_c:    number | null;
  humidity_pct:     number | null;
  pressure_pa:      number | null;
  weight_g:         number | null;
  hx711_raw_counts: number | null;
  audio_rms_dbfs:   number | null;
  // Capability flags
  bme: boolean;
  hx:  boolean;
  mic: boolean;
}

export interface NodeHealthResponse {
  items: NodeHealthItem[];
  count: number;
}

export async function fetchNodeHealth(): Promise<NodeHealthResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl()}/api/v1/hubs/node-health`, { method: 'GET', headers });
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error || `Request failed (${res.status})`);
  return data as NodeHealthResponse;
}
