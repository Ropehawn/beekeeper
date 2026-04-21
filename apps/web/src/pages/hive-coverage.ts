/**
 * apps/web/src/pages/hive-coverage.ts
 *
 * Hive Coverage page — shows which sensing buckets are covered or missing
 * for each active hive, driven entirely by data returned from the API.
 *
 * Nothing is hardcoded: bucket keys, labels, device info, and counts all
 * come from the server response. Adding a new bucket type only requires an
 * API change — no frontend edits needed.
 *
 * Public API (called from index.html):
 *   loadHiveCoveragePage()   — fetch and render
 */

import { fetchHiveCoverage, HiveCoverageItem, CoverageBucket, CoverageDevice } from '../adapters/hive-coverage';

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
// Device list
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Bucket row — label and covered flag come from the bucket data object
// ---------------------------------------------------------------------------

function renderBucketRow(bucket: CoverageBucket): string {
  const indicator = bucket.covered
    ? `<span style="color:#22c55e;font-weight:700;font-size:12px;flex-shrink:0;width:56px;">✓ Yes</span>`
    : `<span style="color:#ef4444;font-weight:700;font-size:12px;flex-shrink:0;width:56px;">✗ No</span>`;

  const detail = bucket.covered
    ? `<span style="font-size:12px;color:#94a3b8;">${renderDeviceList(bucket.devices)}</span>`
    : `<span style="font-size:12px;color:#475569;font-style:italic;">No sensor assigned</span>`;

  return `
    <div style="display:flex;align-items:baseline;gap:10px;padding:5px 0;
                border-bottom:1px solid #1e293b;">
      <span style="font-size:12px;color:#64748b;width:120px;flex-shrink:0;">${escHtml(bucket.label)}</span>
      ${indicator}
      <span style="flex:1;min-width:0;">${detail}</span>
    </div>`;
}

// ---------------------------------------------------------------------------
// Contextual hint — explains why buckets show "No" when sensors exist
// ---------------------------------------------------------------------------

function renderHint(item: HiveCoverageItem, missingCount: number): string {
  if (missingCount === 0) return '';

  if (item.assignedCount === 0) {
    return `<div style="font-size:11px;color:#475569;font-style:italic;margin-top:8px;">
      No sensors assigned to this hive yet.
    </div>`;
  }

  if (item.withoutProfileCount > 0) {
    const noun = item.withoutProfileCount === 1 ? 'sensor' : 'sensors';
    const plural = item.withoutProfileCount === 1 ? 'has' : 'have';
    return `<div style="font-size:11px;color:#eab308;margin-top:8px;">
      ${item.withoutProfileCount} ${noun} ${plural} no deployment profile set —
      open <strong>Node Health</strong> to assign profiles.
    </div>`;
  }

  return '';
}

// ---------------------------------------------------------------------------
// Hive card — all bucket rows driven by item.buckets array from API
// ---------------------------------------------------------------------------

function renderHiveCard(item: HiveCoverageItem): string {
  const missingCount = item.buckets.filter(b => !b.covered).length;
  const totalBuckets = item.buckets.length;
  const allGood      = missingCount === 0;

  const statusColor = allGood
    ? '#22c55e'
    : missingCount >= Math.ceil(totalBuckets / 2) ? '#ef4444' : '#eab308';

  const statusLabel = allGood
    ? 'Fully covered'
    : `${missingCount} bucket${missingCount > 1 ? 's' : ''} missing`;

  const rows = item.buckets.map(renderBucketRow).join('');
  const hint = renderHint(item, missingCount);

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
      <!-- Bucket rows — driven by item.buckets array, no hardcoded keys -->
      <div style="display:flex;flex-direction:column;">
        ${rows}
      </div>
      ${hint}
    </div>`;
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

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
