function getToken(): string | null {
  return localStorage.getItem('beekeeper_token');
}

function baseUrl(): string {
  return (typeof window !== 'undefined' && (window as any).__BEEKEEPER_API_URL) || '';
}

export interface NodeHealthItem {
  deviceMac:  string;
  vendor:     string;
  signalRssi: number | null;
  lastSeenAt: string;
  ageSec:     number;
  status:     'green' | 'yellow' | 'red';
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
