/**
 * apps/web/src/components/hardware/device-card.ts
 *
 * Ownership:
 *   Renders a single device card for the registry detail view and the
 *   provisioning confirmation step. Shows static/administrative fields
 *   (asset ID, vendor, model, role, hive assignment) — not live signal data.
 *
 * Will own:
 *   - renderDeviceCard(record, container)   — full card render
 *   - renderDeviceCardSkeleton(container)   — loading placeholder
 *
 * Does NOT own:
 *   - Signal health badges or battery indicators — observability lane
 *   - Assignment action buttons (wired by the page controller)
 *   - Data fetching
 */

// ---------------------------------------------------------------------------
// Placeholder — no runtime logic moved yet.
// ---------------------------------------------------------------------------

export type DeviceCardRecord = {
  id: string;
  assetId: string | null;
  name: string;
  vendor: string;
  model: string;
  kind: 'sensor' | 'camera';
  lifecycleStatus: string;
  role: string;
  hiveId: string | null;
  hiveName: string | null;
  macAddress: string | null;
  labelPrinted: boolean;
  provisionedAt: string | null;
};

/** Render a device card into the given container element. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function renderDeviceCard(
  _record: DeviceCardRecord,
  _container: HTMLElement,
): void {
  // TODO: implement
}

/** Render a skeleton loading card while data is in flight. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function renderDeviceCardSkeleton(_container: HTMLElement): void {
  // TODO: implement
}
