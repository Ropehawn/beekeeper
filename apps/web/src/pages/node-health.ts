import { fetchNodeHealth, NodeHealthItem } from '../adapters/node-health';

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function formatAge(ageSec: number): string {
  if (ageSec < 60)   return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  return `${Math.floor(ageSec / 3600)}h ago`;
}

function statusDot(status: 'green' | 'yellow' | 'red'): string {
  const colors: Record<string, string> = {
    green:  '#22c55e',
    yellow: '#eab308',
    red:    '#ef4444',
  };
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;` +
    `background:${colors[status]};margin-right:8px;flex-shrink:0;"></span>`;
}

function renderCard(item: NodeHealthItem): string {
  const borderColor: Record<string, string> = {
    green:  '#22c55e',
    yellow: '#eab308',
    red:    '#ef4444',
  };
  const rssiHtml = item.signalRssi != null
    ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${item.signalRssi} dBm</div>`
    : '';
  return `
    <div style="background:#1e293b;border:1px solid ${borderColor[item.status]};border-radius:8px;` +
      `padding:14px 18px;display:flex;align-items:center;gap:12px;margin-bottom:10px;">
      ${statusDot(item.status)}
      <div style="flex:1;min-width:0;overflow:hidden;">
        <div style="font-weight:600;font-size:13px;color:#f1f5f9;font-family:monospace;` +
          `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.deviceMac}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:2px;">${item.vendor}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div style="font-size:13px;color:#cbd5e1;">${formatAge(item.ageSec)}</div>
        ${rssiHtml}
      </div>
    </div>`;
}

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
  // Clear any existing timer before starting a fresh one
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  await render();
  refreshTimer = setInterval(render, 5000);
}

export function stopNodeHealthRefresh(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}
