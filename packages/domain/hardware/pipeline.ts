// packages/domain/hardware/pipeline.ts
//
// Pure Tachyon ingestion → reconciliation → action pipeline.
//
// Stages
// ──────
//   1. normalizeObservation()    Structural cleanup: trim, uppercase MAC, ""→null.
//                                Never rejects; always returns a valid observation.
//
//   2. reconcileSensorIdentity() Waterfall identity match against the registry.
//                                Highest-confidence signal wins (assetId → identifier → MAC).
//                                Defined in actions.ts — not modified here.
//
//   3. deriveAction()            Maps reconciliation flags to a PipelineAction.
//                                crossTierConflict takes priority over relinkRequired.
//
//   4. buildSafeIntent()         Calls buildAssetLinkIntent() with an added
//                                crossTierConflict guard that the raw builder
//                                intentionally omits.
//
//   5. buildProcessingSummary()  One-line structured log string.
//
//   6. processSensorObservation() Composes all stages; returns SensorProcessingResult.
//
// Design rules
// ────────────
//   - No I/O, no DB, no fetch, no DOM. Pure functions only.
//   - Never throws; every input produces a valid SensorProcessingResult.
//   - Does NOT modify reconcileSensorIdentity() behaviour.
//   - crossTierConflict blocks linkIntent even when the higher-tier match succeeded.
//     The pipeline is the safety boundary; the raw reconciler surfaces the flag
//     so callers (like this pipeline) can act on it.

import type {
  UUID,
  TimestampISO,
  SensorRegistryRecord,
  SensorIdentityObservation,
  SensorReconciliationResult,
  PipelineAction,
  SensorProcessingResult,
} from './types';

import { reconcileSensorIdentity, buildAssetLinkIntent } from './actions';

// ---------------------------------------------------------------------------
// Stage 1: Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize raw Tachyon observation fields before reconciliation.
 *
 * Transformations applied:
 *   - Trim leading/trailing whitespace from all string fields
 *   - Uppercase MAC address (matches registry storage convention)
 *   - Convert empty strings to null (transport may send "" for absent fields)
 *
 * Does NOT validate formats — a malformed assetId is not coerced to null here;
 * it will simply find no registry match and fall through the waterfall naturally.
 *
 * Pure — returns a new object; never mutates input.
 */
export function normalizeObservation(
  raw: SensorIdentityObservation,
): SensorIdentityObservation {
  // Returns null for null, null for empty string, trimmed value otherwise.
  const trimOrNull = (v: string | null): string | null => {
    if (v === null) return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
  };

  return {
    assetId: trimOrNull(raw.assetId),
    deviceIdentifier: trimOrNull(raw.deviceIdentifier),
    observedMacAddress:
      raw.observedMacAddress !== null
        ? trimOrNull(raw.observedMacAddress.toUpperCase())
        : null,
    observedAt: raw.observedAt,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: Decision
// ---------------------------------------------------------------------------

/**
 * Derive the recommended PipelineAction from a reconciliation result.
 *
 * Priority order (first matching rule wins):
 *
 *   1. new_unlinked_device → register_new
 *        No registry record matched any signal. Device must enter the
 *        provisioning workflow before any link can be written.
 *
 *   2. ambiguous_match → needs_manual_review
 *        Multiple registry candidates. Automated resolution is unsafe;
 *        a human must select the correct record.
 *
 *   3. crossTierConflict → hold_for_mac_conflict
 *        A higher-tier signal matched a record, but the observed MAC is
 *        currently owned by a DIFFERENT registry record. Executing
 *        relinkRequired without a MAC uniqueness pre-flight would create
 *        a duplicate MAC in the registry. Blocked regardless of whether
 *        relinkRequired is true or false — the collision risk exists either way
 *        (even on exact_match, writing the observed MAC to the matched record
 *        would steal it from the record that currently owns it).
 *
 *   4. relinkRequired → relink_mac
 *        Record matched; MAC in the registry differs from observed MAC
 *        (firmware reflash or hardware swap). Safe to update the MAC.
 *
 *   5. (default) → link_confirmed
 *        Record matched; no MAC conflict, no relink needed. Safe to confirm
 *        the link and optionally write the observed MAC / deviceIdentifier.
 */
export function deriveAction(
  result: SensorReconciliationResult,
): PipelineAction {
  if (result.matchType === 'new_unlinked_device') return 'register_new';
  if (result.matchType === 'ambiguous_match') return 'needs_manual_review';
  if (result.crossTierConflict) return 'hold_for_mac_conflict';
  if (result.relinkRequired) return 'relink_mac';
  return 'link_confirmed';
}

// ---------------------------------------------------------------------------
// Stage 4: Safe intent construction
// ---------------------------------------------------------------------------

/**
 * Build an AssetLinkIntent only when it is safe to auto-persist.
 *
 * This is a stricter wrapper around buildAssetLinkIntent() from actions.ts.
 * That function does not inspect crossTierConflict (by design — it is a
 * raw builder). The pipeline adds the crossTierConflict guard here.
 *
 * Returns null when any of these hold:
 *   - matchedRecord is null         (ambiguous_match or new_unlinked_device)
 *   - manualReviewRequired is true  (ambiguous_match — human must confirm)
 *   - crossTierConflict is true     (observed MAC is owned by another record;
 *                                    writing it would create a MAC collision)
 *
 * When crossTierConflict is true but relinkRequired is false: the match itself
 * is valid, but the observed MAC carried in the intent would overwrite another
 * record's MAC if the persistence layer writes observedMacAddress naively.
 * Returning null is the safest stance — callers can still read the reconciliation
 * result and route the observation to a conflict-resolution queue.
 */
function buildSafeIntent(
  result: SensorReconciliationResult,
  observation: SensorIdentityObservation,
  actorId: UUID | null,
  nowISO: TimestampISO,
) {
  // crossTierConflict guard — stricter than buildAssetLinkIntent
  if (result.crossTierConflict) return null;
  // Delegates remaining guards (matchedRecord null, manualReviewRequired)
  return buildAssetLinkIntent(result, observation, actorId, nowISO);
}

// ---------------------------------------------------------------------------
// Stage 5: Summary
// ---------------------------------------------------------------------------

/**
 * Build a human-readable one-line summary of the pipeline outcome.
 *
 * Format:
 *   [matchType/reason] <identity> → <outcome detail> [FLAG, FLAG]
 *
 * <identity> is the best available stable signal from the observation
 * (assetId preferred, then deviceIdentifier, then MAC, then "unknown").
 *
 * Designed for structured logs. Stable enough for UI tooltips.
 * Pure — no side effects.
 */
export function buildProcessingSummary(
  action: PipelineAction,
  result: SensorReconciliationResult,
  observation: SensorIdentityObservation,
): string {
  const tag = `[${result.matchType}/${result.reason}]`;

  const identity =
    observation.assetId ??
    observation.deviceIdentifier ??
    observation.observedMacAddress ??
    'unknown';

  const flags: string[] = [];
  if (result.crossTierConflict)    flags.push('CROSS-TIER MAC CONFLICT');
  if (result.relinkRequired)       flags.push('RELINK');
  if (result.manualReviewRequired) flags.push('MANUAL REVIEW');
  const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

  switch (action) {
    case 'link_confirmed': {
      const recordId = result.matchedRecord?.id ?? '?';
      const macNote =
        result.observedMac !== null
          ? `MAC: ${result.observedMac}`
          : 'no MAC observed';
      return `${tag} ${identity} → registry:${recordId} (${macNote})${flagStr}`;
    }

    case 'relink_mac': {
      const recordId = result.matchedRecord?.id ?? '?';
      const prev = result.previousMac ?? 'none';
      const next = result.observedMac ?? '?';
      return `${tag} ${identity} → registry:${recordId} (MAC: ${prev} → ${next})${flagStr}`;
    }

    case 'hold_for_mac_conflict': {
      const recordId = result.matchedRecord?.id ?? '?';
      return (
        `${tag} ${identity} → registry:${recordId}` +
        ` — blocked: observed MAC already owned by another record${flagStr}`
      );
    }

    case 'needs_manual_review': {
      const count = result.candidates.length;
      const noun = count === 1 ? 'candidate' : 'candidates';
      return `${tag} ${identity} → ${count} ${noun} — manual review required${flagStr}`;
    }

    case 'register_new': {
      return `${tag} ${identity} → no registry record found — provisioning required`;
    }
  }
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Process a single Tachyon sensor observation through the full pipeline.
 *
 * Stages:
 *   1. Normalize  — clean fields: trim whitespace, uppercase MAC, ""→null
 *   2. Reconcile  — run identity waterfall against the registry snapshot
 *   3. Decide     — map reconciliation flags to a PipelineAction
 *   4. Intend     — build AssetLinkIntent only when safe (crossTierConflict blocks)
 *   5. Flag       — derive shouldPersist, shouldRelink, requiresManualReview
 *   6. Summarize  — build human-readable log string
 *
 * Safety invariants:
 *   - crossTierConflict === true  → linkIntent=null, shouldPersist=false,
 *                                   shouldRelink=false, requiresManualReview=true
 *   - manualReviewRequired === true → linkIntent=null, shouldPersist=false
 *   - relinkRequired + crossTierConflict → shouldRelink=false (crossTier wins)
 *
 * @param records   Current snapshot of the sensor registry (read-only)
 * @param observation  Raw observation from the Tachyon hub (normalized internally)
 * @param actorId   UUID of the actor initiating the observation (null = automated)
 * @param nowISO    Current timestamp in ISO 8601 format
 *
 * Pure — no I/O, no throws, no mutations. Safe to call from any context.
 */
export function processSensorObservation(
  records: SensorRegistryRecord[],
  observation: SensorIdentityObservation,
  actorId: UUID | null,
  nowISO: TimestampISO,
): SensorProcessingResult {
  // Stage 1: normalize
  const normalized = normalizeObservation(observation);

  // Stage 2: reconcile
  const reconciliation = reconcileSensorIdentity(records, normalized);

  // Stage 3: decide
  const action = deriveAction(reconciliation);

  // Stage 4: build intent — crossTierConflict blocks this
  const linkIntent = buildSafeIntent(reconciliation, normalized, actorId, nowISO);

  // Stage 5: derive flags
  //   shouldPersist  — there is a safe write to execute
  //   shouldRelink   — the matched record's MAC should be updated
  //                    (crossTierConflict overrides relinkRequired — do not relink
  //                     when the observed MAC belongs to a different record)
  //   requiresManualReview — observation cannot be processed automatically
  const shouldPersist         = linkIntent !== null;
  const shouldRelink          = reconciliation.relinkRequired && !reconciliation.crossTierConflict;
  const requiresManualReview  =
    reconciliation.manualReviewRequired || reconciliation.crossTierConflict;

  // Stage 6: summarize
  const summary = buildProcessingSummary(action, reconciliation, normalized);

  return {
    reconciliation,
    action,
    linkIntent,
    shouldPersist,
    shouldRelink,
    requiresManualReview,
    summary,
  };
}
