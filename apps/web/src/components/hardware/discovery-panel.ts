/**
 * apps/web/src/components/hardware/discovery-panel.ts
 *
 * Ownership:
 *   Renders the sensor and camera discovery panels (#discover-device-list)
 *   for the hardware registry / provisioning lane. Produces output identical
 *   to renderDiscoverList() and renderDiscoverCameraList() in index.html so
 *   the two can be swapped without visible change.
 *
 * Owns:
 *   - renderDiscoveryPanel()       — sensor list render (empty / rows)
 *   - renderCameraDiscoveryPanel() — camera list render (empty / rows)
 *
 * Does NOT own:
 *   - The discovery loading/error states (owned by discoverDevices() in
 *     index.html; the panel only renders after discovery succeeds)
 *   - The assign actions — wired to existing globals in index.html until
 *     those paths are migrated
 *   - Data fetching
 */

import type { DiscoveredSensor, DiscoveredCamera } from '../../adapters/hardware-registry';

// ---------------------------------------------------------------------------
// renderDiscoveryPanel
// Renders sensor discovery results into the provided list container.
// Matches the exact HTML output of renderDiscoverList() in index.html.
// ---------------------------------------------------------------------------

/**
 * Render the discovered sensor list into `container`.
 *
 * States:
 *   empty — single empty-state div, identical to renderDiscoverList() empty branch
 *   rows  — one row div per sensor, identical to renderDiscoverList() rows
 *
 * The Assign button in each unassigned row calls
 * window.assignFromDiscover(id, name, type), which remains wired to the
 * existing implementation in index.html.
 *
 * @param container        The #discover-device-list element
 * @param sensors          DiscoveredSensor[] from the registry module state
 * @param registeredDeviceIds  Set of deviceIds already in the BeeKeeper DB
 */
export function renderDiscoveryPanel(
  container: HTMLElement,
  sensors: DiscoveredSensor[],
  registeredDeviceIds: Set<string>,
): void {
  if (sensors.length === 0) {
    container.innerHTML =
      '<div style="padding:16px;color:#888;font-size:13px;text-align:center;">No sensors found on this account.</div>';
    return;
  }

  // Build all rows in one DocumentFragment — avoids repeated reflows.
  const fragment = document.createDocumentFragment();

  sensors.forEach((d) => {
    const alreadyAssigned = registeredDeviceIds.has(d.id);

    const readings = [
      d.tempF    != null ? `🌡️ ${d.tempF.toFixed(1)}°F` : '',
      d.humidity != null ? `💧 ${d.humidity}%` : '',
      d.lux      != null ? `☀️ ${d.lux} lux` : '',
      d.type === 'motion'  ? '🏃 Motion sensor' : '',
      d.type === 'contact' ? '🚪 Contact sensor' : '',
    ].filter(Boolean).join(' · ') || `${d.type} sensor`;

    // Name comes from API data — escape for innerHTML safety.
    // d.id is used in an attribute and a monospace block — also escaped.
    const safeName = escapeHtml(d.name);
    const safeId   = escapeHtml(d.id);
    // Single-quote escaping for the onclick attribute — matches original exactly.
    const attrName = d.name.replace(/'/g, "\\'");

    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#f8f8f8;border-radius:8px;gap:10px;';
    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:#1a1a1a;">${safeName}</div>
        <div style="font-size:11px;color:#888;margin-top:2px;">${readings}</div>
        <div style="font-size:10px;color:#aaa;margin-top:2px;font-family:monospace;">ID: ${safeId}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <span class="badge ${d.connected ? 'badge-green' : 'badge-red'}">${d.connected ? 'CONNECTED' : 'OFFLINE'}</span>
        ${alreadyAssigned
          ? '<span class="badge badge-blue">Assigned</span>'
          : `<button class="btn btn-primary btn-sm" onclick="assignFromDiscover('${safeId}','${attrName}','${d.type}')">Assign →</button>`}
      </div>`;

    fragment.appendChild(row);
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}

// ---------------------------------------------------------------------------
// renderCameraDiscoveryPanel
// Renders camera discovery results into the provided list container.
// Matches the exact HTML output of renderDiscoverCameraList() in index.html.
// ---------------------------------------------------------------------------

/**
 * Render the discovered camera list into `container`.
 *
 * States:
 *   empty — single empty-state div, identical to renderDiscoverCameraList() empty branch
 *   rows  — one row div per camera, identical to renderDiscoverCameraList() rows
 *
 * The Assign button in each row calls window.assignCameraFromDiscover(id, name),
 * which remains wired to the existing implementation in index.html.
 *
 * @param container  The #discover-device-list element
 * @param cameras    DiscoveredCamera[] from the registry module state
 */
export function renderCameraDiscoveryPanel(
  container: HTMLElement,
  cameras: DiscoveredCamera[],
): void {
  if (cameras.length === 0) {
    container.innerHTML =
      '<div style="padding:16px;color:#888;font-size:13px;text-align:center;">No cameras found on this console.</div>';
    return;
  }

  // Build all rows in one DocumentFragment — avoids repeated reflows.
  const fragment = document.createDocumentFragment();

  cameras.forEach((c) => {
    const res = c.resWidth && c.resHeight
      ? `${c.resWidth}\u00d7${c.resHeight}`
      : 'unknown resolution';

    // Name and id come from API data — escape to prevent XSS.
    const safeName = escapeHtml(c.name);
    const safeId   = escapeHtml(c.id);
    const safeType = escapeHtml(c.type);
    // Single-quote escaping for the onclick attribute — matches original exactly.
    const attrName = c.name.replace(/'/g, "\\'");

    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#f8f8f8;border-radius:8px;gap:10px;';
    row.innerHTML =
      '<div style="flex:1;min-width:0;">'
      + `<div style="font-size:13px;font-weight:600;color:#1a1a1a;">${safeName}</div>`
      + `<div style="font-size:11px;color:#888;margin-top:2px;">📷 ${safeType} · ${escapeHtml(res)}</div>`
      + `<div style="font-size:10px;color:#aaa;margin-top:2px;font-family:monospace;">ID: ${safeId}</div>`
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">'
      + `<span class="badge ${c.connected ? 'badge-green' : 'badge-red'}">${c.connected ? 'CONNECTED' : 'OFFLINE'}</span>`
      + `<button class="btn btn-primary btn-sm" onclick="assignCameraFromDiscover('${safeId}','${attrName}')">Assign →</button>`
      + '</div>';

    fragment.appendChild(row);
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal HTML escape for text content and attribute values.
 * Covers the characters that can break innerHTML or introduce XSS.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
