import { fetchNodeHealth, NodeHealthItem } from '../adapters/node-health';

let refreshTimer: ReturnType<typeof setInterval> | null = null;

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatAge(ageSec: number): string {
  if (ageSec < 60)   return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  return `${Math.floor(ageSec / 3600)}h ${Math.floor((ageSec % 3600) / 60)}m ago`;
}

function fmt(value: number | null, decimals: number, unit: string): string | null {
  if (value === null) return null;
  return `${value.toFixed(decimals)}\u202f${unit}`;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Card renderer ─────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  green:  '#22c55e',
  yellow: '#eab308',
  red:    '#ef4444',
};
const STATUS_LABEL: Record<string, string> = {
  green:  'Live',
  yellow: 'Stale',
  red:    'Lost',
};

function dot(color: string): string {
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;` +
    `background:${color};flex-shrink:0;"></span>`;
}

function badge(label: string): string {
  return `<span style="display:inline-block;font-size:10px;font-weight:600;` +
    `color:#94a3b8;background:#0f172a;border:1px solid #334155;` +
    `border-radius:4px;padding:1px 5px;line-height:16px;">${label}</span>`;
}

const PROFILE_LABEL: Record<string, string> = {
  internal_climate:             'Internal Climate',
  ambient_reference:            'Ambient Ref',
  scale_only:                   'Scale',
  audio_only:                   'Audio',
  external_climate_scale_audio: 'Ext+Scale+Audio',
  custom:                       'Custom',
};

function profileBadge(profile: string): string {
  const label = PROFILE_LABEL[profile] ?? profile;
  return `<span style="display:inline-block;font-size:10px;font-weight:600;` +
    `color:#7dd3fc;background:#0c1a2e;border:1px solid #1e40af;` +
    `border-radius:4px;padding:1px 5px;line-height:16px;">${label}</span>`;
}

function metricRow(label: string, value: string): string {
  return `<div style="display:flex;justify-content:space-between;` +
    `font-size:12px;line-height:18px;color:#cbd5e1;">` +
    `<span style="color:#64748b;">${label}</span>` +
    `<span style="font-variant-numeric:tabular-nums;">${value}</span></div>`;
}

function renderCard(item: NodeHealthItem): string {
  const color = STATUS_COLOR[item.status];
  const label = STATUS_LABEL[item.status];

  // ── Hive context line ────────────────────────────────────────────────────
  const contextParts: string[] = [];
  if (item.hiveName)    contextParts.push(item.hiveName);
  if (item.locationRole) contextParts.push(item.locationRole);
  if (item.deviceLabel) contextParts.push(item.deviceLabel);
  const contextLine = contextParts.length
    ? contextParts.join(' \u00b7 ')   // "Hive 3 · brood_box_upper · Node A"
    : 'Unassigned';
  const contextColor = contextParts.length ? '#94a3b8' : '#475569';

  // ── HX711 display ────────────────────────────────────────────────────────
  // weight_g → kg (calibrated); hx711_raw_counts → raw counts (uncalibrated)
  let weightStr: string | null = null;
  if (item.weight_g !== null) {
    weightStr = `${(item.weight_g / 1000).toFixed(3)}\u202fkg`;
  } else if (item.hx711_raw_counts !== null) {
    weightStr = `${Math.round(item.hx711_raw_counts).toLocaleString()} counts (uncalibrated)`;
  }

  // ── Metric rows ──────────────────────────────────────────────────────────
  const rows: string[] = [];

  const temp  = fmt(item.temperature_c, 1, '°C');
  const hum   = fmt(item.humidity_pct,  1, '%');
  const press = fmt(item.pressure_pa != null ? item.pressure_pa / 100 : null, 1, 'hPa');
  const audio = fmt(item.audio_rms_dbfs, 1, 'dBFS');

  if (temp || hum) {
    rows.push(metricRow('Env', [temp, hum].filter(Boolean).join('  \u00b7  ')));
  }
  if (press)      rows.push(metricRow('Pressure', press));
  if (weightStr)  rows.push(metricRow('Weight', weightStr));
  if (audio)      rows.push(metricRow('Audio RMS', audio));

  // ── Capability badges ────────────────────────────────────────────────────
  const badges: string[] = [];
  if (item.deploymentProfile) badges.push(profileBadge(item.deploymentProfile));
  if (item.bme) badges.push(badge('BME'));
  if (item.hx)  badges.push(badge('HX711'));
  if (item.mic) badges.push(badge('MIC'));

  const rssiStr  = item.signalRssi != null ? `${item.signalRssi}\u202fdBm` : '—';
  const hasBody  = rows.length > 0 || badges.length > 0;

  const qrLine = item.sensorQrId
    ? `<div style="font-size:10px;font-family:monospace;color:#475569;margin-bottom:4px;padding-left:16px;">ID:\u202f${escAttr(item.sensorQrId)}</div>`
    : `<div style="font-size:10px;font-family:monospace;color:#64402a;margin-bottom:4px;padding-left:16px;">unregistered</div>`;

  // ── Edit / Register button ───────────────────────────────────────────────
  const btnStyle =
    `font-size:10px;font-weight:600;cursor:pointer;flex-shrink:0;` +
    `padding:1px 6px;border:1px solid #334155;border-radius:3px;background:#0f172a;line-height:16px;`;

  const editBtn = item.sensorDeviceId
    ? `<button onclick="openNodeEditModal(this)" ` +
        `data-device-id="${escAttr(item.sensorDeviceId)}" ` +
        `data-qr-id="${escAttr(item.sensorQrId ?? '')}" ` +
        `data-name="${escAttr(item.deviceLabel ?? '')}" ` +
        `data-hive-id="${escAttr(item.hiveId ?? '')}" ` +
        `data-loc-role="${escAttr(item.locationRole ?? '')}" ` +
        `data-loc-note="${escAttr(item.locationNote ?? '')}" ` +
        `data-deployment-profile="${escAttr(item.deploymentProfile ?? '')}" ` +
        `style="${btnStyle}color:#64748b;">✎ Edit</button>`
    : `<button onclick="openNodeRegisterModal(this)" ` +
        `data-mac="${escAttr(item.deviceMac)}" ` +
        `data-vendor="${escAttr(item.vendor)}" ` +
        `style="${btnStyle}color:#f59e0b;">+ Register</button>`;

  return `
    <div style="background:#1e293b;border:1px solid ${color};border-radius:8px;` +
      `padding:12px 16px;margin-bottom:10px;">

      <!-- Header: dot · MAC · status · edit -->
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        ${dot(color)}
        <span style="font-weight:600;font-size:13px;color:#f1f5f9;font-family:monospace;` +
          `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${item.deviceMac}</span>
        <span style="font-size:11px;font-weight:600;color:${color};flex-shrink:0;">${label}</span>
        ${editBtn}
      </div>

      <!-- QR / sensor ID -->
      ${qrLine}

      <!-- Hive context line -->
      <div style="font-size:12px;color:${contextColor};margin-bottom:${item.locationNote ? '2px' : '6px'};` +
        `padding-left:16px;">${contextLine}</div>

      ${item.locationNote ? `<div style="font-size:11px;color:#475569;margin-bottom:6px;padding-left:16px;font-style:italic;">${item.locationNote}</div>` : ''}

      <!-- Sub-header: vendor · seen · rssi -->
      <div style="display:flex;justify-content:space-between;` +
        `font-size:11px;color:#64748b;margin-bottom:${hasBody ? '10px' : '0'};">
        <span>${item.vendor}</span>
        <span>${formatAge(item.ageSec)}&nbsp;&nbsp;${rssiStr}</span>
      </div>

      ${rows.length ? `<div style="border-top:1px solid #1e3a5f;padding-top:8px;` +
        `display:flex;flex-direction:column;gap:2px;margin-bottom:${badges.length ? '8px' : '0'};">` +
        rows.join('') + `</div>` : ''}

      ${badges.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap;">` +
        badges.join('') + `</div>` : ''}
    </div>`;
}

// ── Page lifecycle ────────────────────────────────────────────────────────────

async function render(): Promise<void> {
  const container = document.getElementById('node-health-container');
  if (!container) return;

  try {
    const { items, count } = await fetchNodeHealth();
    if (count === 0) {
      container.innerHTML =
        '<p style="color:#64748b;text-align:center;margin-top:32px;">No sensor readings in the last 24 hours.</p>';
      return;
    }
    container.innerHTML = items.map(renderCard).join('');
  } catch (e) {
    container.innerHTML =
      '<p style="color:#ef4444;text-align:center;margin-top:32px;">Failed to load node health.</p>';
    console.error('node-health: render error', e);
  }
}

export async function loadNodeHealthPage(): Promise<void> {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  await render();
  refreshTimer = setInterval(render, 5000);
}

export function stopNodeHealthRefresh(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}
