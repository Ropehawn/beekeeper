// apps/api/src/lib/sensor-registry-db.ts
//
// DB adapter layer for the Tachyon sensor registry identity pipeline.
//
// Responsibilities:
//   - Load SensorRegistry rows from Prisma and map them to the domain
//     SensorRegistryRecord shape so the pipeline can reconcile identities
//   - Persist safe auto-executable pipeline outcomes (link_confirmed,
//     relink_mac) with appropriate audit events
//   - Queue unresolved outcomes (ambiguous_match, hold_for_mac_conflict,
//     register_new) to the DomainEvent table for human review
//
// Does NOT:
//   - Handle HTTP request/response
//   - Call the domain pipeline functions
//   - Perform schema migrations or DDL
//
// NOTE: SensorRegistry and ProvisioningEvent were added to schema.prisma but
// `prisma generate` has not yet run. The `pg` cast below works around the
// missing generated delegates. After running `cd packages/db && prisma generate`
// (triggered automatically by `prisma migrate dev` or `prisma migrate deploy`),
// remove the cast and use `db.sensorRegistry` / `db.provisioningEvent` directly.
//
// DomainEvent is a pre-existing model and uses the typed `db.domainEvent` path.

import crypto from "crypto";
import { db } from "@beekeeper/db";
import { logger } from "./logger";

// Type-only imports from the domain package.
// These are erased at compile/runtime — no runtime resolution required.
// Relative path resolves correctly under tsx and tsc from this location.
import type {
  SensorRegistryRecord,
  AssetLinkIntent,
  SensorIdentityObservation,
  DeviceVendor,
  SensorModel,
  DeviceTransport,
  RegistryLifecycleStatus,
  DeviceRole,
} from "../../../../packages/domain/hardware/types";
import type { SensorProcessingResult } from "../../../../packages/domain/hardware/types";

// ---------------------------------------------------------------------------
// Pending-generate cast
// Remove after `cd packages/db && prisma generate` has been run.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg = db as any;

// ---------------------------------------------------------------------------
// Local row type
//
// Mirrors the scalar fields returned by `sensorRegistry.findMany()` without
// a select clause. Provides a typed surface for the mapper below without
// depending on the not-yet-generated Prisma client types.
// Update if schema.prisma adds or renames fields on SensorRegistry.
// ---------------------------------------------------------------------------

interface RegistryRow {
  id:                 string;
  assetId:            string;
  deviceIdentifier:   string;
  vendor:             string;
  model:              string;
  transport:          string;
  kind:               string;
  name:               string;
  lifecycleStatus:    string;
  currentMacAddress:  string | null;
  hubId:              string | null;
  hiveId:             string | null;
  role:               string;
  pollingIntervalSec: number | null;
  firmwareVersion:    string | null;
  notes:              string | null;
  labelPrinted:       boolean;
  provisionedAt:      Date | null;
  assignedAt:         Date | null;
  retiredAt:          Date | null;
  createdAt:          Date;
  updatedAt:          Date;
}

// ---------------------------------------------------------------------------
// Mapper: Prisma row → domain SensorRegistryRecord
//
// String casts for enum-like fields (vendor, model, transport,
// lifecycleStatus, role) trust that values were written by our own code and
// match the domain union types. The DB has no enum constraint — if an
// out-of-range value somehow appears, the pipeline's waterfall is robust to
// it (no match → new_unlinked_device / register_new).
//
// DateTime → TimestampISO: all dates are converted to ISO 8601 strings via
// `.toISOString()`. Nullable dates produce `null`.
//
// kind is hard-coded to 'sensor' — every row in sensor_registry is a sensor.
// The DB column exists for domain type alignment but is not trusted for the
// literal type narrowing.
// ---------------------------------------------------------------------------

function toRegistryRecord(row: RegistryRow): SensorRegistryRecord {
  return {
    id:                 row.id,
    assetId:            row.assetId,
    deviceIdentifier:   row.deviceIdentifier,
    vendor:             row.vendor        as DeviceVendor,
    model:              row.model         as SensorModel,
    transport:          row.transport     as DeviceTransport,
    kind:               "sensor",         // literal — not cast from DB
    name:               row.name,
    lifecycleStatus:    row.lifecycleStatus as RegistryLifecycleStatus,
    currentMacAddress:  row.currentMacAddress,
    hubId:              row.hubId,
    hiveId:             row.hiveId,
    role:               row.role          as DeviceRole,
    pollingIntervalSec: row.pollingIntervalSec,
    firmwareVersion:    row.firmwareVersion,
    notes:              row.notes,
    labelPrinted:       row.labelPrinted,
    provisionedAt:      row.provisionedAt?.toISOString()  ?? null,
    assignedAt:         row.assignedAt?.toISOString()     ?? null,
    retiredAt:          row.retiredAt?.toISOString()      ?? null,
    createdAt:          row.createdAt.toISOString(),
    updatedAt:          row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// MacCollisionError
//
// Thrown by persistRelinkMac() when the in-transaction MAC uniqueness
// check detects a collision. The calling route should return HTTP 409 and
// surface conflictingRegistryId in the response so the operator can resolve
// the conflict before retrying.
// ---------------------------------------------------------------------------

export class MacCollisionError extends Error {
  readonly conflictingRegistryId: string;

  constructor(mac: string, conflictingRegistryId: string) {
    super(
      `MAC ${mac} is already owned by registry record ${conflictingRegistryId}. ` +
      `Resolve the conflict before relinking.`,
    );
    this.name               = "MacCollisionError";
    this.conflictingRegistryId = conflictingRegistryId;
  }
}

// ---------------------------------------------------------------------------
// loadRegistryRecordsForHub
//
// Loads all non-retired SensorRegistry records for a given hub and returns
// them mapped to the SensorRegistryRecord domain shape.
//
// Scope: hubId-scoped. This ensures the reconciliation waterfall only
// considers records that belong to this hub's apiary, preventing false
// cross-apiary matches on shared vendor identifiers or MACs.
//
// Retired records are excluded: they should never match an active observation.
// If a retired device is re-provisioned, it will be treated as a new device
// (register_new) until an operator restores its lifecycle status.
// ---------------------------------------------------------------------------

export async function loadRegistryRecordsForHub(
  hubId: string,
): Promise<SensorRegistryRecord[]> {
  const rows: RegistryRow[] = await pg.sensorRegistry.findMany({
    where: {
      hubId,
      lifecycleStatus: { not: "retired" },
    },
    // No `select` clause — return all scalar fields. Relations (hub, hive,
    // provisioningEvents) are not included; the pipeline does not need them.
  });

  logger.debug(
    { hubId, count: rows.length },
    "sensor-registry: loaded records for reconciliation",
  );

  return rows.map(toRegistryRecord);
}

// ---------------------------------------------------------------------------
// persistLinkConfirmed
//
// Called when processSensorObservation() returns action === 'link_confirmed':
// the observation matched a registry record with no MAC conflict and no
// state change required.
//
// Writes:
//   1. sensorRegistry.update — syncs deviceIdentifier if the observation
//      carries a fresher value (e.g. first BLE advertisement after QR scan).
//      No-ops silently if intent.deviceIdentifier is null.
//   2. provisioningEvent.create — records the identity confirmation for
//      the audit trail (eventType: 'identity_confirmed').
//
// No transaction needed: the two writes are independent. If the event write
// fails, the record update is already committed — this is acceptable because
// a failed audit event is less harmful than leaving the identity stale.
// ---------------------------------------------------------------------------

export async function persistLinkConfirmed(
  intent: AssetLinkIntent,
  summary: string,
  hubId: string,
): Promise<void> {
  const occurredAt = new Date(intent.linkedAt);

  // Sync deviceIdentifier only when the observation has a non-null value.
  // Never blank it out — a null observation identifier means "not reported
  // by the hub this time", not "the device lost its identifier".
  if (intent.deviceIdentifier !== null) {
    await pg.sensorRegistry.update({
      where: { id: intent.registryId },
      data:  { deviceIdentifier: intent.deviceIdentifier },
    });
  }

  await pg.provisioningEvent.create({
    data: {
      id:          crypto.randomUUID(),
      registryId:  intent.registryId,
      eventType:   "identity_confirmed",
      actorId:     intent.actorId ?? null,
      occurredAt,
      payload: {
        summary,
        hubId,
        observedMac:        intent.observedMacAddress,
        deviceIdentifier:   intent.deviceIdentifier,
      },
    },
  });

  logger.info(
    { registryId: intent.registryId, hubId, summary },
    "sensor-registry: identity confirmed",
  );
}

// ---------------------------------------------------------------------------
// persistRelinkMac
//
// Called when processSensorObservation() returns action === 'relink_mac':
// the observation matched a registry record but the MAC address has changed
// (firmware reflash, hardware swap, or first-time MAC registration).
//
// Safety: all writes run inside a single Prisma transaction. The MAC
// uniqueness check is repeated inside the transaction as a belt-and-suspenders
// guard against race conditions — two hubs could each observe the new MAC at
// the same moment and both pass the pipeline's crossTierConflict check before
// either write commits. The in-transaction check prevents a second commit from
// creating a duplicate.
//
// Throws MacCollisionError if:
//   - Another registry record currently owns intent.observedMacAddress
//     (discovered inside the transaction, after pipeline evaluation)
// The calling route must catch MacCollisionError and return HTTP 409.
//
// Writes (inside transaction):
//   1. Pre-flight: sensorRegistry.findFirst — collision check
//   2. sensorRegistry.update — sets currentMacAddress (and optionally
//      deviceIdentifier) on the matched record
//   3. provisioningEvent.create — records the MAC change (eventType: 'mac_updated')
// ---------------------------------------------------------------------------

export async function persistRelinkMac(
  intent: AssetLinkIntent,
  previousMac: string | null,
  summary: string,
  hubId: string,
): Promise<void> {
  // Guard: callers should never reach this with a null observedMac, because
  // relink_mac implies relinkRequired which requires a non-null observed MAC.
  // Validate defensively rather than silently no-op.
  if (intent.observedMacAddress === null) {
    throw new Error(
      "persistRelinkMac called with null observedMacAddress — this is a pipeline bug.",
    );
  }

  const newMac     = intent.observedMacAddress;
  const occurredAt = new Date(intent.linkedAt);

  await db.$transaction(async (tx: any) => {
    // ── Belt: re-check MAC uniqueness inside the transaction ────────────────
    // The pipeline's crossTierConflict === false check is the suspenders.
    // This check is the belt — it catches races where two concurrent requests
    // passed the pipeline check before either write committed.
    const collision = await tx.sensorRegistry.findFirst({
      where: {
        currentMacAddress: newMac,
        id:                { not: intent.registryId },
      },
      select: { id: true },
    });

    if (collision !== null) {
      throw new MacCollisionError(newMac, collision.id);
    }

    // ── Update currentMacAddress (and optionally deviceIdentifier) ──────────
    await tx.sensorRegistry.update({
      where: { id: intent.registryId },
      data: {
        currentMacAddress: newMac,
        // Sync deviceIdentifier when the observation has a fresh value.
        ...(intent.deviceIdentifier !== null && {
          deviceIdentifier: intent.deviceIdentifier,
        }),
      },
    });

    // ── Write audit event ────────────────────────────────────────────────────
    await tx.provisioningEvent.create({
      data: {
        id:          crypto.randomUUID(),
        registryId:  intent.registryId,
        eventType:   "mac_updated",
        actorId:     intent.actorId ?? null,
        occurredAt,
        payload: {
          summary,
          hubId,
          previousMac,
          newMac,
          deviceIdentifier: intent.deviceIdentifier,
        },
      },
    });
  });

  logger.info(
    { registryId: intent.registryId, hubId, previousMac, newMac, summary },
    "sensor-registry: MAC relinked",
  );
}

// ---------------------------------------------------------------------------
// queueForReview
//
// Called when processSensorObservation() returns an action that cannot be
// auto-resolved:
//   needs_manual_review   — ambiguous_match: multiple candidates found
//   hold_for_mac_conflict — crossTierConflict: observed MAC owned elsewhere
//   register_new          — new_unlinked_device: not in registry
//
// Writes a DomainEvent row (not ProvisioningEvent) because:
//   - ambiguous_match and new_unlinked_device have no single registryId to
//     reference — ProvisioningEvent.registryId is non-nullable
//   - DomainEvent has processedAt (null = pending review), making it a
//     lightweight queue without a dedicated table
//   - DomainEvent.actorId has no FK (survives user deletion), matching our
//     audit requirements
//
// The payload captures everything an operator needs to resolve the item:
//   - action: the pipeline decision code
//   - summary: human-readable one-liner from buildProcessingSummary()
//   - observation: what the hub reported (assetId, identifier, MAC, timestamp)
//   - matchType / reason: the reconciliation outcome
//   - candidates: sorted registry records that matched (for ambiguous_match)
//   - crossTierConflict: whether a MAC collision was the blocker
//
// processedAt is left null. A future review UI will set it when an operator
// resolves the item, or a background job will sweep stale entries.
// ---------------------------------------------------------------------------

export async function queueForReview(
  result: SensorProcessingResult,
  observation: SensorIdentityObservation,
  hubId: string,
): Promise<void> {
  const { action, summary, reconciliation } = result;

  // Serialize candidates to plain objects — SensorRegistryRecord is already
  // a plain value type (ISO strings, no Date objects) so it is JSON-safe.
  const candidateSummaries = reconciliation.candidates.map((c) => ({
    id:               c.id,
    assetId:          c.assetId,
    deviceIdentifier: c.deviceIdentifier,
    currentMac:       c.currentMacAddress,
    lifecycleStatus:  c.lifecycleStatus,
    name:             c.name,
  }));

  await db.domainEvent.create({
    data: {
      id:            crypto.randomUUID(),
      eventType:     "sensor.identity.review_queued",
      aggregateId:   hubId,           // hub is the aggregate when no single record matched
      aggregateType: "Hub",
      actorId:       null,            // automated reconciliation — no human actor
      processedAt:   null,            // null = pending human review
      payload: {
        action,
        summary,
        observation: {
          assetId:            observation.assetId,
          deviceIdentifier:   observation.deviceIdentifier,
          observedMacAddress: observation.observedMacAddress,
          observedAt:         observation.observedAt,
        },
        reconciliation: {
          matchType:         reconciliation.matchType,
          reason:            reconciliation.reason,
          crossTierConflict: reconciliation.crossTierConflict,
          relinkRequired:    reconciliation.relinkRequired,
          observedMac:       reconciliation.observedMac,
          previousMac:       reconciliation.previousMac,
          // matchedRecord id only — full record is expensive to store and
          // can be re-fetched. null for ambiguous_match and new_unlinked_device.
          matchedRecordId:   reconciliation.matchedRecord?.id ?? null,
        },
        candidates: candidateSummaries,
        hubId,
      },
    },
  });

  logger.info(
    { action, hubId, summary },
    "sensor-registry: observation queued for review",
  );
}
