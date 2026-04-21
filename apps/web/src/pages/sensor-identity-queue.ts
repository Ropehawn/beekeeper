/**
 * apps/web/src/pages/sensor-identity-queue.ts
 *
 * Page controller + renderer for the Sensor Identity Review Queue.
 *
 * Responsibilities:
 *   - Own in-memory state for the queue item list and per-item load/error state
 *   - Render all items and per-item action controls into #sensor-queue-container
 *   - Handle all four resolution actions: dismiss, provision, select_candidate,
 *     force_relink
 *
 * Rendering strategy:
 *   A single delegated click listener is attached once to the container div.
 *   All button clicks bubble up and are handled centrally by data attributes.
 *   render() replaces innerHTML; the delegate listener is unaffected because it
 *   is attached to the stable container element, not to individual item buttons.
 *
 * Public API (called from index.html):
 *   loadSensorIdentityQueuePage()   — navigate to page, fetch items, render
 *   refreshSensorIdentityQueue()    — reload items (bound to Refresh button)
 */

import {
  fetchQueueItems,
  dismissQueueItem,
  resolveProvision,
  resolveSelectCandidate,
  resolveForceRelink,
  type QueueItem,
} from '../adapters/sensor-identity-queue';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let items:      QueueItem[]                             = [];
let pageStatus: 'idle' | 'loading' | 'success' | 'error' = 'idle';
let pageError:  string | null                           = null;

const itemBusy   = new Map<string, boolean>(); // action in flight for this item
const itemErrors = new Map<string, string>();  // per-item error message
const openForms  = new Set<string>();          // provision form expanded

let listenerAttached = false;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function container(): HTMLElement | null {
  return document.getElementById('sensor-queue-container');
}

/** HTML-escape a string. Returns an em-dash for null/empty. */
function esc(s: string | null | undefined): string {
  if (s == null || s === '') return '—';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ACTION_LABEL: Record<QueueItem['action'], string> = {
  register_new:          'New Device',
  needs_manual_review:   'Manual Review',
  hold_for_mac_conflict: 'MAC Conflict',
};

const ACTION_BADGE_STYLE: Record<QueueItem['action'], string> = {
  register_new:          'background:#d1fae5;color:#065f46',
  needs_manual_review:   'background:#fef3c7;color:#92400e',
  hold_for_mac_conflict: 'background:#fee2e2;color:#991b1b',
};

const VENDORS:         readonly string[] = ['tachyon','unifi_protect','sensorpush','ecowitt','mokosmart','fanstel','generic'];
const MODELS:          readonly string[] = ['sc833f','s05t','bme280','hx711','inmp441','generic'];
const TRANSPORTS:      readonly string[] = ['ble','gpio','csi','cloud','manual'];
const ROLES:           readonly string[] = ['primary_environment','thermal_map','weight','audio','entrance_camera','apiary_camera','ambient_weather','unknown'];
const LOCATION_ROLES:  readonly string[] = ['','apiary_ambient','hive_exterior','entrance','inner_cover','brood_box_upper','brood_box_lower','honey_super','base_scale','under_hive','audio_probe','custom'];

function opts(vals: readonly string[]): string {
  return vals.map(v => `<option value="${v}">${v}</option>`).join('');
}

export function render(): void {
  const el = container();
  if (!el) return;

  if (pageStatus === 'loading') {
    el.innerHTML = '<div style="padding:24px;color:#888;font-size:13px;">Loading queue…</div>';
    return;
  }
  if (pageStatus === 'error') {
    el.innerHTML = `<div style="padding:24px;color:#dc2626;font-size:13px;">Failed to load queue: ${esc(pageError)}</div>`;
    return;
  }
  if (pageStatus === 'success' && items.length === 0) {
    el.innerHTML = '<div style="padding:24px;color:#888;font-size:13px;">✓ No pending items in the queue.</div>';
    return;
  }
  if (pageStatus === 'idle') {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = items.map(renderItem).join('');
}

function renderItem(item: QueueItem): string {
  const busy     = itemBusy.get(item.id)   ?? false;
  const error    = itemErrors.get(item.id) ?? null;
  const formOpen = openForms.has(item.id);
  const dis      = busy ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : '';
  const obs      = item.observation;

  // ── Candidates block ─────────────────────────────────────────────────────
  const candidatesHtml =
    item.action === 'needs_manual_review' && item.candidates.length > 0
      ? `<div style="margin:10px 0 4px;">
           <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">
             Candidates — click Select to link this observation
           </div>
           ${item.candidates.map(c => `
             <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;
                         background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;
                         margin-bottom:4px;font-size:12px;">
               <div style="flex:1;min-width:0;">
                 <span style="font-weight:600;">${esc(c.name)}</span>
                 <span style="color:#6b7280;margin-left:6px;">${esc(c.assetId)}</span>
                 <span style="color:#9ca3af;margin-left:4px;"> · </span>
                 <span style="color:#6b7280;margin-left:4px;">${esc(c.deviceIdentifier)}</span>
                 ${c.currentMac
                   ? `<span style="color:#9ca3af;margin-left:4px;"> · MAC: ${esc(c.currentMac)}</span>`
                   : ''}
                 <span style="margin-left:6px;font-size:10px;color:#9ca3af;">[${esc(c.lifecycleStatus)}]</span>
               </div>
               <button class="btn btn-primary btn-sm"
                 data-queue-action="select_candidate"
                 data-item-id="${esc(item.id)}"
                 data-registry-id="${esc(c.id)}"
                 ${dis}>Select</button>
             </div>`).join('')}
         </div>`
      : '';

  // ── Action buttons ────────────────────────────────────────────────────────
  let actionBtns = '';
  if (item.action === 'register_new') {
    actionBtns = `
      <button class="btn btn-primary btn-sm"
        data-queue-action="toggle_provision"
        data-item-id="${esc(item.id)}"
        ${dis}>${formOpen ? '✕ Cancel' : '+ Provision'}</button>
      <button class="btn btn-secondary btn-sm"
        data-queue-action="dismiss"
        data-item-id="${esc(item.id)}"
        ${dis}>Dismiss</button>`;
  } else if (item.action === 'needs_manual_review') {
    actionBtns = `
      <button class="btn btn-secondary btn-sm"
        data-queue-action="dismiss"
        data-item-id="${esc(item.id)}"
        ${dis}>Dismiss</button>`;
  } else if (item.action === 'hold_for_mac_conflict') {
    actionBtns = `
      <button class="btn btn-sm"
        style="background:#dc2626;color:#fff;border:1px solid #dc2626;border-radius:6px;padding:4px 10px;cursor:${busy ? 'not-allowed' : 'pointer'};font-size:12px;${busy ? 'opacity:0.5;' : ''}"
        data-queue-action="force_relink"
        data-item-id="${esc(item.id)}"
        ${busy ? 'disabled' : ''}>⚡ Force Relink</button>
      <button class="btn btn-secondary btn-sm"
        data-queue-action="dismiss"
        data-item-id="${esc(item.id)}"
        ${dis}>Dismiss</button>`;
  }

  // ── Provision form ────────────────────────────────────────────────────────
  const provisionHtml =
    formOpen && item.action === 'register_new'
      ? renderProvisionForm(item.id)
      : '';

  return `
    <div class="card" style="margin-bottom:12px;" id="queue-item-${esc(item.id)}">
      <!-- Header -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="${ACTION_BADGE_STYLE[item.action]};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">
            ${ACTION_LABEL[item.action]}
          </span>
          <span style="font-size:11px;color:#9ca3af;">
            ${esc(new Date(item.createdAt).toLocaleString())}
          </span>
          ${busy ? '<span style="font-size:11px;color:#f59e0b;">Working…</span>' : ''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">${actionBtns}</div>
      </div>

      <!-- Summary -->
      <div style="font-size:12px;color:#6b7280;font-style:italic;margin-bottom:8px;">
        ${esc(item.summary)}
      </div>

      <!-- Observation details -->
      <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:12px;
                  background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px;">
        <span><strong>Asset ID:</strong> ${esc(obs.assetId)}</span>
        <span><strong>Identifier:</strong> ${esc(obs.deviceIdentifier)}</span>
        <span><strong>MAC:</strong> ${esc(obs.observedMacAddress)}</span>
        <span><strong>Hub:</strong>
          <code style="background:#efefef;padding:1px 4px;border-radius:3px;font-size:11px;">
            ${esc(item.hubId)}
          </code>
        </span>
      </div>

      ${candidatesHtml}

      <!-- Per-item error -->
      ${error
        ? `<div style="margin-top:8px;padding:8px 10px;background:#fee2e2;border:1px solid #fca5a5;
                       border-radius:6px;font-size:12px;color:#991b1b;">${esc(error)}</div>`
        : ''}

      ${provisionHtml}
    </div>`;
}

function renderProvisionForm(itemId: string): string {
  const id = esc(itemId);
  const inputStyle =
    'width:100%;box-sizing:border-box;padding:5px 8px;' +
    'border:1px solid #d1d5db;border-radius:4px;font-size:12px;';
  const labelStyle = 'font-size:11px;color:#6b7280;display:block;margin-bottom:3px;';

  return `
    <div style="margin-top:12px;padding:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;">
      <div style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;
                  letter-spacing:0.5px;margin-bottom:10px;">Provision New Device</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:8px;">
        <div>
          <label style="${labelStyle}">Asset ID <span style="color:#dc2626;">*</span></label>
          <input id="pf-assetid-${id}" type="text" placeholder="BK-SNS-0001" style="${inputStyle}">
        </div>
        <div>
          <label style="${labelStyle}">Name <span style="color:#dc2626;">*</span></label>
          <input id="pf-name-${id}" type="text" placeholder="Hive 1 Sensor" style="${inputStyle}">
        </div>
        <div>
          <label style="${labelStyle}">Vendor <span style="color:#dc2626;">*</span></label>
          <select id="pf-vendor-${id}" style="${inputStyle}">${opts(VENDORS)}</select>
        </div>
        <div>
          <label style="${labelStyle}">Model <span style="color:#dc2626;">*</span></label>
          <select id="pf-model-${id}" style="${inputStyle}">${opts(MODELS)}</select>
        </div>
        <div>
          <label style="${labelStyle}">Transport <span style="color:#dc2626;">*</span></label>
          <select id="pf-transport-${id}" style="${inputStyle}">${opts(TRANSPORTS)}</select>
        </div>
        <div>
          <label style="${labelStyle}">Role <span style="color:#dc2626;">*</span></label>
          <select id="pf-role-${id}" style="${inputStyle}">${opts(ROLES)}</select>
        </div>
        <div>
          <label style="${labelStyle}">MAC Address</label>
          <input id="pf-mac-${id}" type="text" placeholder="AA:BB:CC:DD:EE:FF" style="${inputStyle}">
        </div>
        <div>
          <label style="${labelStyle}">Hive ID (UUID)</label>
          <input id="pf-hiveid-${id}" type="text" placeholder="optional" style="${inputStyle}">
        </div>
        <div>
          <label style="${labelStyle}">Location Role</label>
          <select id="pf-locrole-${id}" style="${inputStyle}">
            <option value="">— unset —</option>
            ${opts(LOCATION_ROLES.filter(v => v !== ''))}
          </select>
        </div>
        <div>
          <label style="${labelStyle}">Location Note</label>
          <input id="pf-locnote-${id}" type="text" placeholder="optional" style="${inputStyle}">
        </div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;">
        <button class="btn btn-primary btn-sm" data-provision-submit="${id}">✓ Submit</button>
        <button class="btn btn-secondary btn-sm"
          data-queue-action="toggle_provision"
          data-item-id="${id}">Cancel</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Event handling — delegated on the stable container element
// ---------------------------------------------------------------------------

function attachListener(): void {
  if (listenerAttached) return;
  const el = container();
  if (!el) return;

  el.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;

    const actionBtn = target.closest<HTMLElement>('[data-queue-action]');
    if (actionBtn) {
      handleQueueAction(actionBtn).catch(console.error);
      return;
    }

    const submitBtn = target.closest<HTMLElement>('[data-provision-submit]');
    if (submitBtn) {
      handleProvisionSubmit(submitBtn).catch(console.error);
    }
  });

  listenerAttached = true;
}

async function handleQueueAction(btn: HTMLElement): Promise<void> {
  const action = btn.dataset.queueAction!;
  const itemId = btn.dataset.itemId!;

  if (action === 'toggle_provision') {
    openForms.has(itemId) ? openForms.delete(itemId) : openForms.add(itemId);
    itemErrors.delete(itemId);
    render();
    return;
  }

  if (action === 'dismiss') {
    await runAction(itemId, () => dismissQueueItem(itemId));
    return;
  }

  if (action === 'select_candidate') {
    const registryId = btn.dataset.registryId!;
    await runAction(itemId, () => resolveSelectCandidate(itemId, registryId));
    return;
  }

  if (action === 'force_relink') {
    const confirmed = confirm(
      'Force-relink this MAC to the matched record?\n\n' +
      'The MAC will be revoked from any other record that currently holds it. ' +
      'This cannot be undone without a new resolution.',
    );
    if (!confirmed) return;
    await runAction(itemId, () => resolveForceRelink(itemId));
  }
}

async function handleProvisionSubmit(btn: HTMLElement): Promise<void> {
  const itemId = btn.dataset.provisionSubmit!;

  const val = (elId: string): string =>
    (document.getElementById(elId) as HTMLInputElement | HTMLSelectElement | null)
      ?.value?.trim() ?? '';

  const assetId   = val(`pf-assetid-${itemId}`);
  const name      = val(`pf-name-${itemId}`);
  const vendor    = val(`pf-vendor-${itemId}`);
  const model     = val(`pf-model-${itemId}`);
  const transport = val(`pf-transport-${itemId}`);
  const role      = val(`pf-role-${itemId}`);
  const mac          = val(`pf-mac-${itemId}`)     || null;
  const hiveId       = val(`pf-hiveid-${itemId}`)  || null;
  const locationRole = val(`pf-locrole-${itemId}`) || null;
  const locationNote = val(`pf-locnote-${itemId}`) || null;

  if (!assetId || !name) {
    itemErrors.set(itemId, 'Asset ID and Name are required.');
    render();
    return;
  }

  await runAction(itemId, () =>
    resolveProvision(itemId, {
      resolution:        'provision',
      assetId,
      name,
      vendor,
      model,
      transport,
      role,
      currentMacAddress: mac,
      hiveId,
      locationRole,
      locationNote,
    }),
  );
}

async function runAction(itemId: string, fn: () => Promise<void>): Promise<void> {
  itemBusy.set(itemId, true);
  itemErrors.delete(itemId);
  render();

  try {
    await fn();
    // On success: remove the item from the list
    items = items.filter(i => i.id !== itemId);
    itemBusy.delete(itemId);
    openForms.delete(itemId);
  } catch (err) {
    itemBusy.set(itemId, false);
    itemErrors.set(itemId, err instanceof Error ? err.message : 'Action failed');
  }

  render();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadSensorIdentityQueuePage(): Promise<void> {
  pageStatus = 'loading';
  pageError  = null;
  items      = [];
  itemBusy.clear();
  itemErrors.clear();
  openForms.clear();

  // Attach delegate listener once — safe to call before render so the
  // container div exists in the DOM when the module first loads.
  attachListener();

  render();

  try {
    const result = await fetchQueueItems({ limit: 50 });
    items      = result.items;
    pageStatus = 'success';
  } catch (err) {
    pageStatus = 'error';
    pageError  = err instanceof Error ? err.message : 'Unknown error';
  }

  render();
}

export async function refreshSensorIdentityQueue(): Promise<void> {
  await loadSensorIdentityQueuePage();
}
