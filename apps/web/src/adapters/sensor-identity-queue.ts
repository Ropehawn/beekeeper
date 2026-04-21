/**
 * apps/web/src/adapters/sensor-identity-queue.ts
 *
 * HTTP transport layer for the sensor identity review queue.
 * Mirrors the response shapes from:
 *   GET  /api/v1/sensor-identity/review-queue
 *   POST /api/v1/sensor-identity/review-queue/:id/dismiss
 *   POST /api/v1/sensor-identity/review-queue/:id/resolve
 */

// ---------------------------------------------------------------------------
// Auth / transport — mirrors hardware-registry.ts pattern
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

  const res  = await fetch(`${baseUrl()}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error || `Request failed (${res.status})`);
  return data as T;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface QueueObservation {
  assetId:            string | null;
  deviceIdentifier:   string | null;
  observedMacAddress: string | null;
  observedAt:         string;
}

export interface QueueReconciliation {
  matchType:         string;
  reason:            string;
  crossTierConflict: boolean;
  relinkRequired:    boolean;
  observedMac:       string | null;
  previousMac:       string | null;
  matchedRecordId:   string | null;
}

export interface QueueCandidate {
  id:               string;
  assetId:          string;
  deviceIdentifier: string;
  currentMac:       string | null;
  lifecycleStatus:  string;
  name:             string;
}

export interface QueueItem {
  id:             string;
  createdAt:      string;
  hubId:          string;
  action:         'register_new' | 'needs_manual_review' | 'hold_for_mac_conflict';
  summary:        string;
  observation:    QueueObservation;
  reconciliation: QueueReconciliation;
  candidates:     QueueCandidate[];
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export async function fetchQueueItems(params?: {
  action?: string;
  hubId?:  string;
  limit?:  number;
}): Promise<{ items: QueueItem[]; count: number }> {
  const qs = new URLSearchParams();
  if (params?.action)            qs.set('action', params.action);
  if (params?.hubId)             qs.set('hubId',  params.hubId);
  if (params?.limit !== undefined) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return apiFetch('GET', `/api/v1/sensor-identity/review-queue${suffix}`);
}

export async function dismissQueueItem(id: string, reason?: string): Promise<void> {
  await apiFetch('POST', `/api/v1/sensor-identity/review-queue/${id}/dismiss`,
    reason ? { reason } : {},
  );
}

export async function resolveProvision(id: string, body: {
  resolution:        'provision';
  assetId:           string;
  name:              string;
  vendor:            string;
  model:             string;
  transport:         string;
  role:              string;
  currentMacAddress: string | null;
  hiveId:            string | null;
}): Promise<void> {
  await apiFetch('POST', `/api/v1/sensor-identity/review-queue/${id}/resolve`, body);
}

export async function resolveSelectCandidate(id: string, registryId: string): Promise<void> {
  await apiFetch('POST', `/api/v1/sensor-identity/review-queue/${id}/resolve`, {
    resolution: 'select_candidate',
    registryId,
  });
}

export async function resolveForceRelink(id: string): Promise<void> {
  await apiFetch('POST', `/api/v1/sensor-identity/review-queue/${id}/resolve`, {
    resolution: 'force_relink',
  });
}
