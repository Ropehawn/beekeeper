/**
 * apps/web/src/components/hardware/registry-table.ts
 *
 * Ownership:
 *   Renders the sensor and camera registry tables for the hardware registry /
 *   provisioning lane. Produces output identical to the existing
 *   renderSensorsTableFromData() and renderCamerasAdminTable() in index.html
 *   so the two can be swapped without visible change.
 *
 * Owns:
 *   - renderRegistryTable()       — sensor table (loading / error / empty / rows)
 *   - renderCameraRegistryTable() — camera table (loading / error / empty / rows)
 *   - updateRegistryRow()         — in-place row update (stub, future use)
 *   - highlightRegistryRow()      — scroll + highlight after provisioning (stub, future use)
 *
 * Does NOT own:
 *   - Live signal indicators (freshness, battery) — observability lane
 *   - getCameraSnapshotUrl — observability lane; caller passes a snapshotUrlBuilder callback
 *   - The discovery panel (see discovery-panel.ts)
 *   - Data fetching
 *   - Remove actions — wired to existing globals in index.html until those paths are migrated
 */

import type { SensorDeviceRecord, CameraDeviceRecord } from '../../adapters/hardware-registry';
import type { RegistryLoadState } from '../../pages/hardware-registry';

// ---------------------------------------------------------------------------
// renderRegistryTable
// Renders into the provided <tbody> container. Matches the exact HTML output
// of renderSensorsTableFromData() in index.html for all states.
// ---------------------------------------------------------------------------

/**
 * Render the sensor registry table into `container`.
 *
 * States:
 *   loading — single spinner row (no current equivalent; matches existing style)
 *   error   — single error row, identical to loadSensorDevices() catch block
 *   empty   — single empty-state row, identical to renderSensorsTableFromData()
 *   rows    — one <tr> per device, identical to renderSensorsTableFromData()
 *
 * The Remove button in each row calls window.removeSensorDevice(id, name),
 * which remains wired to the existing implementation in index.html.
 */
export function renderRegistryTable(
  container: HTMLElement,
  devices: SensorDeviceRecord[],
  loadState: RegistryLoadState,
): void {
  if (loadState.status === 'loading') {
    container.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:#aaa;font-size:13px;">
      Loading sensor devices…
    </td></tr>`;
    return;
  }

  if (loadState.status === 'error') {
    const message = loadState.error ?? 'Unknown error';
    container.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:#dc2626;font-size:13px;">
      Could not load sensor devices: ${escapeHtml(message)}
    </td></tr>`;
    return;
  }

  if (devices.length === 0) {
    container.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:#aaa;font-size:13px;">
      No sensors assigned yet · Click <strong>Discover Sensors</strong> to find UniFi Protect sensors
    </td></tr>`;
    return;
  }

  // Build all rows in one pass then assign once — avoids repeated innerHTML +=
  // which causes the browser to re-parse the table on every row.
  const rows = devices.map((d) => {
    const hiveName = d.hiveName ?? '—';
    // Name and hiveName come from API data — escape to prevent XSS.
    // deviceId is used in an attribute and in a <code> block — also escaped.
    // The Remove button calls the existing global; single-quote escaping
    // matches the original renderSensorsTableFromData exactly.
    const safeName    = escapeHtml(d.name);
    const safeHive    = escapeHtml(hiveName);
    const safeId      = escapeHtml(d.deviceId);
    const attrName    = d.name.replace(/'/g, "\\'");

    return `
        <tr>
          <td><strong>${safeName}</strong></td>
          <td>${safeHive}</td>
          <td>UniFi Protect</td>
          <td>Temp · Humidity · Lux</td>
          <td><code style="font-size:11px;background:#f3f4f6;padding:2px 5px;border-radius:3px;">${safeId}</code></td>
          <td><span class="badge badge-blue">Registered</span></td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="removeSensorDevice('${d.id}','${attrName}')">Remove</button>
          </td>
        </tr>`;
  });

  container.innerHTML = rows.join('');
}

// ---------------------------------------------------------------------------
// renderCameraRegistryTable
// Renders into the provided <tbody> container. Matches the exact HTML output
// of renderCamerasAdminTable() in index.html for all states.
// ---------------------------------------------------------------------------

/**
 * Render the camera registry table into `container`.
 *
 * States:
 *   loading — single spinner row
 *   error   — single error row
 *   empty   — single empty-state row, identical to renderCamerasAdminTable()
 *   rows    — one <tr> per device, identical to renderCamerasAdminTable()
 *
 * The snapshot <img> src is produced by `snapshotUrlBuilder(unifiDeviceId)`.
 * Pass `(id) => BeeAPI.getCameraSnapshotUrl(id) + '&t=' + Date.now()` from
 * the bridge so this renderer stays free of observability-lane concerns.
 *
 * The Remove button calls window.removeCameraDevice(id), which remains wired
 * to the existing implementation in index.html.
 */
export function renderCameraRegistryTable(
  container: HTMLElement,
  devices: CameraDeviceRecord[],
  loadState: RegistryLoadState,
  snapshotUrlBuilder: (unifiDeviceId: string) => string,
): void {
  if (loadState.status === 'loading') {
    container.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:#aaa;font-size:13px;">
      Loading camera devices…
    </td></tr>`;
    return;
  }

  if (loadState.status === 'error') {
    const message = loadState.error ?? 'Unknown error';
    container.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:#dc2626;font-size:13px;">
      Could not load camera devices: ${escapeHtml(message)}
    </td></tr>`;
    return;
  }

  if (devices.length === 0) {
    container.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:#aaa;font-size:13px;">No cameras assigned yet · Click Discover Cameras to find devices</td></tr>`;
    return;
  }

  // Build all rows in one pass then assign once — avoids repeated innerHTML +=
  // which causes the browser to re-parse the table on every row.
  const rows = devices.map((d) => {
    const hiveName = d.hiveName ?? '—';
    // Name and hiveName come from API data — escape to prevent XSS.
    // unifiDeviceId is displayed (truncated) and passed to snapshotUrlBuilder.
    const safeName     = escapeHtml(d.name);
    const safeHive     = escapeHtml(hiveName);
    const safeIdTrunc  = escapeHtml(d.unifiDeviceId.slice(0, 12)) + '\u2026';
    // Snapshot URL is observability-lane; not escaped — caller controls the builder.
    const snapUrl      = snapshotUrlBuilder(d.unifiDeviceId);

    return `
        <tr>
          <td><strong>${safeName}</strong></td>
          <td>${safeHive}</td>
          <td><img src="${snapUrl}" style="width:120px;height:68px;object-fit:cover;border-radius:4px;" onerror="this.style.display='none'"></td>
          <td><code style="font-size:10px;background:#f3f4f6;padding:2px 5px;border-radius:3px;">${safeIdTrunc}</code></td>
          <td><button class="btn btn-secondary btn-sm" onclick="removeCameraDevice('${d.id}')">Remove</button></td>
        </tr>`;
  });

  container.innerHTML = rows.join('');
}

// ---------------------------------------------------------------------------
// Stubs — future use
// ---------------------------------------------------------------------------

/** Update a single row in-place without re-rendering the full table. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function updateRegistryRow(_record: SensorDeviceRecord): void {
  // TODO: implement when incremental updates are needed
}

/** Scroll to and briefly highlight the row for the given device ID. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function highlightRegistryRow(_id: string): void {
  // TODO: implement after provisioning flow is wired
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
