/**
 * apps/web/src/components/hardware/index.ts
 *
 * Ownership:
 *   Barrel export for all hardware UI components.
 *   Import from this file, not from individual component files directly.
 *
 * Components in this folder are scoped to the hardware registry /
 * provisioning lane only. Live observability widgets (signal health
 * indicators, reading charts) belong in a separate observability
 * component folder when that lane is scaffolded.
 */

export * from './registry-table';
export * from './device-card';
export * from './discovery-panel';
