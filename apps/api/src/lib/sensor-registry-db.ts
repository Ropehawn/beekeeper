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
// AssetIdConflictError
//
// Thrown by persistProvisionNew() when the in-transaction assetId uniqueness
// check finds an existing registry record with the same assetId. The calling
// route should return HTTP 409 and surface conflictingRegistryId so the
// operator can investigate before retrying with a different assetId.
// ---------------------------------------------------------------------------

export class AssetIdConflictError extends Error {
  readonly conflictingRegistryId: string;

  constructor(assetId: string, conflictingRegistryId: string) {
    super(
      `assetId '${assetId}' is already owned by registry record ${conflictingRegistryId}.`,
    );
    this.name                  = "AssetIdConflictError";
    this.conflictingRegistryId = conflictingRegistryId;
  }
}

// ---------------------------------------------------------------------------
// RetiredRecordError
//
// Thrown by persistForceRelink() when the matched registry record A is found
// to be retired (or missing) at the time the operator resolves the queue item.
// A retired record should not receive a MAC assignment. The calling route
// returns HTTP 409 so the operator can investigate the record's state.
// ---------------------------------------------------------------------------

export class RetiredRecordError extends Error {
  readonly registryId: string;

  constructor(registryId: string) {
    super(
      `Registry record ${registryId} has been retired or no longer exists ` +
      `and cannot receive a MAC assignment.`,
    );
    this.name       = "RetiredRecordError";
    this.registryId = registryId;
  }
}

// ---------------------------------------------------------------------------
// ConflictDriftedError
//
// Thrown by persistForceRelink() when the contested MAC is no longer owned by
// any registry record at resolution time — neither by the conflicting record B
// nor by the matched record A. This means the original conflict has drifted
// (e.g. B was decommissioned or its MAC was updated) before the operator acted.
//
// Surfaced as HTTP 409 so the operator can re-evaluate the queue item rather
// than silently force-writing a MAC that may no longer be relevant.
// ---------------------------------------------------------------------------

export class ConflictDriftedError extends Error {
  readonly registryId:   string;
  readonly contestedMac: string;

  constructor(registryId: string, contestedMac: string) {
    super(
      `MAC ${contestedMac} is no longer owned by any registry record. ` +
      `The conflict that created this queue item may have been resolved by other means. ` +
      `Re-evaluate the queue item before proceeding.`,
    );
    this.name         = "ConflictDriftedError";
    this.registryId   = registryId;
    this.contestedMac = contestedMac;
  }
}

// ---------------------------------------------------------------------------
// ProvisionNewInput
//
// Parameter bag for persistProvisionNew(). Kept as an interface rather than
// individual args so callers read as named fields and the function signature
// stays stable as we add optional fields later (e.g. notes, firmwareVersion).
// ---------------------------------------------------------------------------

export interface ProvisionNewInput {
  // Fields supplied by the operator in the resolve request body
  assetId:           string;
  name:              string;
  vendor:            string;
  model:             string;
  transport:         string;
  role:              string;
  hiveId:            string | null;
  currentMacAddress: string | null;   // normalized (uppercase/trimmed) before call
  locationRole:      string | null;   // physical placement within the hive
  locationNote:      string | null;   // free-form placement note
  // Derived from the queue item's observation context — not in the request body
  deviceIdentifier:  string;          // observation.deviceIdentifier ?? assetId
  hubId:             string | null;   // domain_events.aggregateId
  // Actor and queue linkage
  actorId:           string;          // req.user!.id
  queueItemId:       string;          // domain_events.id being resolved
  // Existing queue item payload — spread before appending resolution fields
  existingQueuePayload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// persistProvisionNew
//
// Called when an operator resolves a 'register_new' queue item by supplying
// the administrative fields needed to provision the device.
//
// Runs entirely inside a single Prisma transaction:
//   1. Uniqueness pre-flight: assetId — throws AssetIdConflictError on collision
//   2. Uniqueness pre-flight: currentMacAddress — throws MacCollisionError on collision
//   3. sensor_registry INSERT — creates the stable identity record
//   4. provisioning_events INSERT — records the provisioning act for the audit trail
//   5. domain_events UPDATE — marks the queue item processed and appends resolution context
//
// Returns the UUID of the newly created SensorRegistry row.
//
// Throws:
//   AssetIdConflictError  — assetId already in use (HTTP 409)
//   MacCollisionError     — currentMacAddress already in use (HTTP 409)
//   Any Prisma error      — unexpected (HTTP 500)
// ---------------------------------------------------------------------------

export async function persistProvisionNew(input: ProvisionNewInput): Promise<string> {
  const registryId = crypto.randomUUID();
  const now        = new Date();

  await db.$transaction(async (tx: any) => {
    // ── Belt: assetId uniqueness inside transaction ──────────────────────────
    // Catches races where two operators attempt to provision the same assetId
    // simultaneously. Both may pass a pre-transaction check; only one wins here.
    const assetConflict = await tx.sensorRegistry.findUnique({
      where:  { assetId: input.assetId },
      select: { id: true },
    });
    if (assetConflict !== null) {
      throw new AssetIdConflictError(input.assetId, assetConflict.id);
    }

    // ── Belt: MAC uniqueness inside transaction (only when MAC is supplied) ──
    if (input.currentMacAddress !== null) {
      const macConflict = await tx.sensorRegistry.findFirst({
        where:  { currentMacAddress: input.currentMacAddress },
        select: { id: true },
      });
      if (macConflict !== null) {
        throw new MacCollisionError(input.currentMacAddress, macConflict.id);
      }
    }

    // ── Create the registry record ───────────────────────────────────────────
    await tx.sensorRegistry.create({
      data: {
        id:                registryId,
        assetId:           input.assetId,
        deviceIdentifier:  input.deviceIdentifier,
        vendor:            input.vendor,
        model:             input.model,
        transport:         input.transport,
        kind:              "sensor",
        name:              input.name,
        lifecycleStatus:   "provisioned",
        currentMacAddress: input.currentMacAddress,
        hubId:             input.hubId,
        hiveId:            input.hiveId,
        role:              input.role,
        locationRole:      input.locationRole,
        locationNote:      input.locationNote,
        labelPrinted:      false,
        provisionedAt:     now,
      },
    });

    // ── Write the provisioning audit event ───────────────────────────────────
    // eventType 'provisioned' marks the moment this physical device was entered
    // into the registry by an operator. payload records the source so the audit
    // trail links back to the original hub observation.
    await tx.provisioningEvent.create({
      data: {
        id:         crypto.randomUUID(),
        registryId,
        eventType:  "provisioned",
        actorId:    input.actorId,
        occurredAt: now,
        payload: {
          source:      "review_queue_resolve",
          queueItemId: input.queueItemId,
        },
      },
    });

    // ── Seal the queue item ───────────────────────────────────────────────────
    // processedAt marks it as no longer pending. Resolution metadata is appended
    // to the original payload so the full context (observation + who resolved it +
    // what was created) lives in one place.
    await tx.domainEvent.update({
      where: { id: input.queueItemId },
      data: {
        processedAt: now,
        payload: {
          ...input.existingQueuePayload,
          resolvedBy:        input.actorId,
          resolvedAt:        now.toISOString(),
          resolution:        "provision",
          createdRegistryId: registryId,
        },
      },
    });
  });

  logger.info(
    {
      resolution:        "provision",
      queueItemId:       input.queueItemId,
      hubId:             input.hubId,
      createdRegistryId: registryId,
      assetId:           input.assetId,
    },
    "sensor-registry: new device provisioned from review queue",
  );

  return registryId;
}

// ---------------------------------------------------------------------------
// SelectCandidateInput
//
// Parameter bag for persistSelectCandidate(). Carries the minimum context
// needed to resolve an ambiguous_match queue item by linking it to a
// specific registry candidate chosen by an operator.
// ---------------------------------------------------------------------------

export interface SelectCandidateInput {
  // The candidate registry record the operator selected
  registryId:           string;
  // From the original observation — used to update the registry record.
  // null when no MAC was reported in the observation (e.g. QR-scan-only).
  observedMacAddress:   string | null;
  deviceIdentifier:     string | null;
  // From reconciliation.previousMac — written into the audit event payload
  // so the audit trail shows what was there before the change.
  previousMac:          string | null;
  // Derived by the caller:
  //   reconciliation.relinkRequired && !crossTierConflict && observedMac !== null
  // When true: write currentMacAddress + mac_updated event.
  // When false: sync deviceIdentifier only + identity_confirmed event.
  relinkRequired:       boolean;
  // Actor who resolved the item
  actorId:              string;
  // The domain_events row being resolved
  queueItemId:          string;
  // Hub that reported the original observation
  hubId:                string;
  // Existing queue item payload — spread before appending resolution fields
  existingQueuePayload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// persistSelectCandidate
//
// Called when an operator resolves a 'needs_manual_review' queue item by
// selecting which registry record the observation belongs to (ambiguous_match
// means the pipeline found multiple candidates and could not auto-pick one).
//
// Runs entirely inside a single Prisma transaction.
//
// When relinkRequired is true (and observedMacAddress is non-null):
//   1. Pre-flight: MAC uniqueness check (excludes selected record) — MacCollisionError
//   2. sensorRegistry.update — writes currentMacAddress + optional deviceIdentifier
//   3. provisioningEvent.create — eventType: 'mac_updated'
//
// When relinkRequired is false (confirm, no MAC change):
//   1. sensorRegistry.update — syncs deviceIdentifier only (skipped if null)
//   2. provisioningEvent.create — eventType: 'identity_confirmed'
//
// Always (both paths):
//   N. domainEvent.update — sets processedAt + appends resolution metadata
//
// Sealing the queue item inside the same transaction as the registry write
// ensures either both succeed or both roll back — no half-resolved items.
//
// Throws:
//   MacCollisionError  — observedMacAddress already owned by another record
//   Any Prisma error   — unexpected (HTTP 500)
// ---------------------------------------------------------------------------

export async function persistSelectCandidate(input: SelectCandidateInput): Promise<void> {
  const now = new Date();

  await db.$transaction(async (tx: any) => {
    if (input.relinkRequired && input.observedMacAddress !== null) {
      // ── Belt: re-check MAC uniqueness inside the transaction ───────────────
      // The pipeline cleared crossTierConflict before queuing, but another
      // request could have claimed this MAC in the interim.
      const collision = await tx.sensorRegistry.findFirst({
        where: {
          currentMacAddress: input.observedMacAddress,
          id:                { not: input.registryId },
        },
        select: { id: true },
      });
      if (collision !== null) {
        throw new MacCollisionError(input.observedMacAddress, collision.id);
      }

      // ── Update currentMacAddress (+ optional deviceIdentifier) ────────────
      await tx.sensorRegistry.update({
        where: { id: input.registryId },
        data: {
          currentMacAddress: input.observedMacAddress,
          ...(input.deviceIdentifier !== null && {
            deviceIdentifier: input.deviceIdentifier,
          }),
        },
      });

      // ── Audit: MAC change triggered by operator candidate selection ────────
      await tx.provisioningEvent.create({
        data: {
          id:         crypto.randomUUID(),
          registryId: input.registryId,
          eventType:  "mac_updated",
          actorId:    input.actorId,
          occurredAt: now,
          payload: {
            source:           "review_queue_resolve",
            queueItemId:      input.queueItemId,
            hubId:            input.hubId,
            previousMac:      input.previousMac,
            newMac:           input.observedMacAddress,
            deviceIdentifier: input.deviceIdentifier,
          },
        },
      });

    } else {
      // ── Sync deviceIdentifier only — no MAC change required ───────────────
      // Never blank out an existing identifier: a null observation means
      // "not reported this time", not "the device lost its identifier".
      if (input.deviceIdentifier !== null) {
        await tx.sensorRegistry.update({
          where: { id: input.registryId },
          data:  { deviceIdentifier: input.deviceIdentifier },
        });
      }

      // ── Audit: identity confirmed without MAC change ───────────────────────
      await tx.provisioningEvent.create({
        data: {
          id:         crypto.randomUUID(),
          registryId: input.registryId,
          eventType:  "identity_confirmed",
          actorId:    input.actorId,
          occurredAt: now,
          payload: {
            source:           "review_queue_resolve",
            queueItemId:      input.queueItemId,
            hubId:            input.hubId,
            observedMac:      input.observedMacAddress,
            deviceIdentifier: input.deviceIdentifier,
          },
        },
      });
    }

    // ── Seal the queue item ───────────────────────────────────────────────────
    // processedAt marks it resolved. Resolution metadata is appended to the
    // original payload so the complete context (observation + who selected +
    // which record was chosen) lives in one place.
    await tx.domainEvent.update({
      where: { id: input.queueItemId },
      data: {
        processedAt: now,
        payload: {
          ...input.existingQueuePayload,
          resolvedBy:         input.actorId,
          resolvedAt:         now.toISOString(),
          resolution:         "select_candidate",
          selectedRegistryId: input.registryId,
        },
      },
    });
  });

  logger.info(
    {
      resolution:         "select_candidate",
      queueItemId:        input.queueItemId,
      hubId:              input.hubId,
      selectedRegistryId: input.registryId,
      relinkRequired:     input.relinkRequired,
    },
    "sensor-registry: ambiguous candidate selected from review queue",
  );
}

// ---------------------------------------------------------------------------
// ForceRelinkInput
//
// Parameter bag for persistForceRelink(). All fields are derived from the
// stored queue item payload — the operator supplies no extra data beyond the
// resolution type itself.
// ---------------------------------------------------------------------------

export interface ForceRelinkInput {
  // The registry record the pipeline matched via assetId or deviceIdentifier
  // at observation time (record A). This is reconciliation.matchedRecordId.
  matchedRegistryId:    string;
  // The normalized MAC to transfer to record A. This is reconciliation.observedMac
  // (already uppercase/trimmed by normalizeObservation before storage).
  contestedMac:         string;
  // Record A's MAC at observation time. Written into A's audit event so the
  // trail shows what was there before the force-relink. May be null if A had
  // no MAC when the observation arrived.
  previousMacOnA:       string | null;
  // Sync deviceIdentifier on A if the observation reported one (may be null).
  deviceIdentifier:     string | null;
  // Actor who resolved the item
  actorId:              string;
  // The domain_events row being resolved
  queueItemId:          string;
  // Hub that reported the original observation
  hubId:                string;
  // Existing queue item payload — spread before appending resolution fields
  existingQueuePayload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// persistForceRelink
//
// Called when an operator resolves a 'hold_for_mac_conflict' queue item by
// asserting that the contested MAC belongs to the matched record (record A),
// revoking it from whichever record currently holds it (record B, if any).
//
// Runs entirely inside a single Prisma transaction:
//
//   1. Load record A — throws RetiredRecordError if missing or retired
//   2. Find the current owner of contestedMac excluding A (record B, nullable)
//   3. If B found: set B.currentMacAddress = null
//   4. Update A: set currentMacAddress = contestedMac (+ optional deviceIdentifier)
//   5. If B found: provisioning_events INSERT for B — eventType: 'mac_updated',
//      newMac: null, payload records the revocation context
//   6. provisioning_events INSERT for A — eventType: 'mac_updated', records
//      the assignment and the record it was revoked from
//   7. domain_events UPDATE — processedAt = NOW(), appends resolution metadata
//
// Steps 3 and 4 together satisfy the UNIQUE constraint: B's MAC is nulled in
// the same transaction that writes it to A. PostgreSQL checks constraints at
// transaction commit, so order between 3 and 4 within the transaction does not
// matter for correctness — but B is cleared first for readability.
//
// If the contested MAC is no longer owned by any record at resolution time
// (B cannot be found), steps 3 and 5 are skipped. The MAC is written to A
// unconditionally — the conflict has naturally resolved itself.
//
// Returns:
//   { targetRegistryId, revokedFromRegistryId }
//   revokedFromRegistryId is null when the MAC was already unowned at resolve time.
//
// Throws:
//   RetiredRecordError  — record A is retired or missing (HTTP 409)
//   Any Prisma error    — unexpected (HTTP 500)
// ---------------------------------------------------------------------------

export async function persistForceRelink(
  input: ForceRelinkInput,
): Promise<{ targetRegistryId: string; revokedFromRegistryId: string | null }> {
  const now = new Date();

  // Captured inside the transaction so the return value is available after commit.
  // Declared with let so the transaction callback can assign it.
  // eslint-disable-next-line prefer-const
  let revokedFromRegistryId: string | null = null;

  await db.$transaction(async (tx: any) => {
    // ── 1. Verify record A exists and is not retired ────────────────────────
    const recordA = await tx.sensorRegistry.findUnique({
      where:  { id: input.matchedRegistryId },
      select: { id: true, lifecycleStatus: true, currentMacAddress: true },
    });
    if (recordA === null || recordA.lifecycleStatus === "retired") {
      throw new RetiredRecordError(input.matchedRegistryId);
    }

    // ── 2. Find the current owner of the contested MAC, excluding A ─────────
    // Record B may differ from whoever held the MAC at observation time — the
    // registry can change between queuing and resolution. We act on the current
    // state rather than the snapshot so we don't revoke from the wrong record.
    const recordB = await tx.sensorRegistry.findFirst({
      where: {
        currentMacAddress: input.contestedMac,
        id:                { not: input.matchedRegistryId },
      },
      select: { id: true },
    });
    revokedFromRegistryId = recordB?.id ?? null;

    // ── Guard: conflict has drifted ──────────────────────────────────────────
    // If neither B nor A currently owns the contested MAC, the conflict that
    // created this queue item no longer exists. Throw rather than silently
    // writing a potentially stale MAC — the operator should re-evaluate.
    if (recordB === null && recordA.currentMacAddress !== input.contestedMac) {
      throw new ConflictDriftedError(input.matchedRegistryId, input.contestedMac);
    }

    // ── 3. Revoke MAC from B (if B still holds it) ──────────────────────────
    if (recordB !== null) {
      await tx.sensorRegistry.update({
        where: { id: recordB.id },
        data:  { currentMacAddress: null },
      });
    }

    // ── 4. Assign MAC to A (+ optional deviceIdentifier sync) ───────────────
    await tx.sensorRegistry.update({
      where: { id: input.matchedRegistryId },
      data: {
        currentMacAddress: input.contestedMac,
        ...(input.deviceIdentifier !== null && {
          deviceIdentifier: input.deviceIdentifier,
        }),
      },
    });

    // ── 5. Audit: MAC revocation on B ────────────────────────────────────────
    if (recordB !== null) {
      await tx.provisioningEvent.create({
        data: {
          id:         crypto.randomUUID(),
          registryId: recordB.id,
          eventType:  "mac_updated",
          actorId:    input.actorId,
          occurredAt: now,
          payload: {
            source:                 "review_queue_force_relink_revocation",
            queueItemId:            input.queueItemId,
            hubId:                  input.hubId,
            previousMac:            input.contestedMac,
            newMac:                 null,
            revokedByForceRelinkOf: input.matchedRegistryId,
          },
        },
      });
    }

    // ── 6. Audit: MAC assignment on A ────────────────────────────────────────
    await tx.provisioningEvent.create({
      data: {
        id:         crypto.randomUUID(),
        registryId: input.matchedRegistryId,
        eventType:  "mac_updated",
        actorId:    input.actorId,
        occurredAt: now,
        payload: {
          source:           "review_queue_resolve",
          queueItemId:      input.queueItemId,
          hubId:            input.hubId,
          previousMac:      input.previousMacOnA,
          newMac:           input.contestedMac,
          revokedFrom:      revokedFromRegistryId,
          deviceIdentifier: input.deviceIdentifier,
        },
      },
    });

    // ── 7. Seal the queue item ───────────────────────────────────────────────
    await tx.domainEvent.update({
      where: { id: input.queueItemId },
      data: {
        processedAt: now,
        payload: {
          ...input.existingQueuePayload,
          resolvedBy:            input.actorId,
          resolvedAt:            now.toISOString(),
          resolution:            "force_relink",
          targetRegistryId:      input.matchedRegistryId,
          revokedFromRegistryId: revokedFromRegistryId,
        },
      },
    });
  });

  logger.info(
    {
      resolution:            "force_relink",
      queueItemId:           input.queueItemId,
      hubId:                 input.hubId,
      targetRegistryId:      input.matchedRegistryId,
      contestedMac:          input.contestedMac,
      revokedFromRegistryId,
    },
    "sensor-registry: MAC force-relinked from review queue",
  );

  return {
    targetRegistryId:      input.matchedRegistryId,
    revokedFromRegistryId,
  };
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
