/**
 * apps/web/src/pages/hive-coverage.ts
 *
 * Hive Coverage page — shows which sensing capabilities are covered
 * and which are missing for each active hive.
 *
 * Public API (called from index.html):
 *   loadHiveCoveragePage()   — fetch and render
 */

import { fetchHiveCoverage, HiveCoverageItem, CoverageDevice } from '../adapters/hive-coverage';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function container(): HTMLElement | null {
  return document.getElementById('hive-coverage-container');
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const BUCKET_LABELS: Record<string, string> = {
  internalClimate: 'Internal Climate',
  externalClimate: 'External Climate',
  scale:           'Scale',
  audio:           'Audio',
};

const BUCKETS = ['internalClimate', 'externalClimate', 'scale', 'audio'] as const;
type BucketKey = typeof BUCKETS[number];

function renderDeviceList(devices: CoverageDevice[]): string {
  return devices
    .map(d => {
      const label   = escHtml(d.name || d.deviceId);
      const qrPart  = d.name && d.deviceId && d.name !== d.deviceId
        ? ` <span style="color:#94a3b8;font-family:monospace;">(${escHtml(d.deviceId)})</span>`
        : '';
      const rolePart = d.locationRole
        ? ` <span style="color:#475569;font-size:11px;">· ${escHtml(d.locationRole)}</span>`
        : '';
      return `<span style="color:#e2e8f0;">${label}</span>${qrPart}${rolePart}`;
    })
    .join('<span style="color:#334155;margin:0 4px;">·</span>');
}

function renderBucketRow(
  bucket: BucketKey,
  present: boolean,
  devices: CoverageDevice[],
): string {
  const label = BUCKET_LABELS[bucket];

  const indicator = present
    ? `<span style="color:#22c55e;font-weight:700;font-size:12px;flex-shrink:0;width:56px;">✓ Yes</span>`
    : `<span style="color:#ef4444;font-weight:700;font-size:12px;flex-shrink:0;width:56px;">✗ No</span>`;

  const detail = present
    ? `<span style="font-size:12px;color:#94a3b8;">${renderDeviceList(devices)}</span>`
    : `<span style="font-size:12px;color:#475569;font-style:italic;">No sensor assigned</span>`;

  return `
    <div style="display:flex;align-items:baseline;gap:10px;padding:5px 0;
                border-bottom:1px solid #1e293b;">
      <span style="font-size:12px;color:#64748b;width:120px;flex-shrink:0;">${label}</span>
      ${indicator}
      <span style="flex:1;min-width:0;">${detail}</span>
    </div>`;
}

function missingCount(item: HiveCoverageItem): number {
  return BUCKETS.filter(b => !item.coverage[b]).length;
}

function renderHiveCard(item: HiveCoverageItem): string {
  const missing = missingCount(item);
  const allGood = missing === 0;

  const statusColor = allGood ? '#22c55e' : missing >= 3 ? '#ef4444' : '#eab308';
  const statusLabel = allGood
    ? 'Fully covered'
    : `${missing} bucket${missing > 1 ? 's' : ''} missing`;

  const rows = BUCKETS.map(b =>
    renderBucketRow(b, item.coverage[b], item.devices[b])
  ).join('');

  return `
    <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;
                padding:14px 16px;margin-bottom:10px;">
      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;
                  margin-bottom:10px;">
        <span style="font-size:14px;font-weight:700;color:#f1f5f9;">
          ${escHtml(item.hiveName)}
        </span>
        <span style="font-size:11px;font-weight:600;color:${statusColor};">
          ${statusLabel}
        </span>
      </div>
      <!-- Bucket rows -->
      <div style="display:flex;flex-direction:column;">
        ${rows}
      </div>
    </div>`;
}

function renderPage(items: HiveCoverageItem[]): string {
  if (items.length === 0) {
    return '<p style="color:#64748b;text-align:center;margin-top:32px;">No active hives found.</p>';
  }
  return items.map(renderHiveCard).join('');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadHiveCoveragePage(): Promise<void> {
  const el = container();
  if (!el) return;

  el.innerHTML = '<p style="color:#64748b;text-align:center;margin-top:32px;">Loading…</p>';

  try {
    const { items } = await fetchHiveCoverage();
    el.innerHTML = renderPage(items);
  } catch (e) {
    el.innerHTML =
      '<p style="color:#ef4444;text-align:center;margin-top:32px;">Failed to load hive coverage.</p>';
    console.error('hive-coverage: load error', e);
  }
}
