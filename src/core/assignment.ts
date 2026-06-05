/**
 * The deterministic evaluation pipeline (docs/BEHAVIOR_CONTRACT.md "Evaluation
 * Pipeline" + "Sticky Matrix"). Pure and side-effect-free: it takes the effective
 * experiment config plus any stored assignment and returns the runtime result and
 * what (if anything) the caller should persist or clear. The client applies those
 * side effects.
 *
 * Forced and admin overrides are applied by the client around this pure pipeline;
 * the holdout branch (NOT_IN_EXPERIMENT) is reserved and not evaluated here.
 */
import { getBucketValue, HASH_VERSION, selectVariantByBucket } from './hash'
import { nowIso } from './events'
import type {
  AssignmentReason,
  AssignmentResult,
  AssignmentSource,
  ExperimentConfig,
  PersistedAssignment,
} from './types'

const TRACKABLE_REASONS: ReadonlySet<AssignmentReason> = new Set<AssignmentReason>([
  'STICKY',
  'COMPUTED',
  'VARIANT_REMOVED_REASSIGNED',
  'VARIANT_REMOVED_FALLBACK',
])

/** Exposure eligibility is a pure function of the runtime reason. */
export function isTrackableReason(reason: AssignmentReason): boolean {
  return TRACKABLE_REASONS.has(reason)
}

export interface EvaluationInput {
  experimentKey: string
  experiment: ExperimentConfig | undefined
  persisted: PersistedAssignment | undefined
  /** Bucketing id of the active user, used for first-time assignments. */
  currentBucketingId: string
  fallbackVariant: string
  isReady: boolean
}

export interface EvaluationOutcome {
  result: AssignmentResult
  /** A record to write (new/recomputed assignment). */
  persist?: PersistedAssignment
  /** Remove any stored record for this key. */
  clear?: boolean
}

function computeVariant(experiment: ExperimentConfig, bucketingId: string): string | null {
  return selectVariantByBucket(getBucketValue(experiment.seed, bucketingId), experiment.variants)
}

function record(
  experimentKey: string,
  variantKey: string,
  bucketingId: string,
  seed: string,
): PersistedAssignment {
  return {
    experimentKey,
    variantKey,
    bucketingId,
    hashVersion: HASH_VERSION,
    seed,
    assignedAt: nowIso(),
    assignedBy: 'computed',
  }
}

function toResult(
  experimentKey: string,
  variant: string,
  reason: AssignmentReason,
  source: AssignmentSource,
  isReady: boolean,
): AssignmentResult {
  return { experimentKey, variant, reason, source, isReady, trackable: isTrackableReason(reason) }
}

export function evaluateExperiment(input: EvaluationInput): EvaluationOutcome {
  const { experimentKey, experiment, persisted, currentBucketingId, fallbackVariant, isReady } = input

  // (1) Experiment missing from the effective config.
  if (experiment === undefined) {
    return {
      result: toResult(experimentKey, fallbackVariant, 'EXPERIMENT_NOT_FOUND', 'default', isReady),
      // Only clear a stored record once the config is authoritative — avoids wiping
      // assignments during bootstrap before remote config has loaded.
      clear: persisted !== undefined && isReady,
    }
  }

  // (2) Disabled — return control, keep any stored assignment for re-enable.
  if (!experiment.enabled) {
    return {
      result: toResult(experimentKey, experiment.controlVariant, 'EXPERIMENT_DISABLED', 'default', isReady),
    }
  }

  // (3) A stored assignment exists — decide sticky vs recompute by provenance.
  if (persisted !== undefined) {
    const provenanceMatches =
      persisted.hashVersion === HASH_VERSION && persisted.seed === experiment.seed
    const variantStillExists = experiment.variants.some((variant) => variant.key === persisted.variantKey)

    if (provenanceMatches && variantStillExists) {
      return {
        result: toResult(experimentKey, persisted.variantKey, 'STICKY', persisted.assignedBy, isReady),
      }
    }

    if (provenanceMatches && !variantStillExists) {
      // Variant removed: recompute under the stored bucketing id (identity continuity).
      const recomputed = computeVariant(experiment, persisted.bucketingId)
      if (recomputed !== null) {
        return {
          result: toResult(experimentKey, recomputed, 'VARIANT_REMOVED_REASSIGNED', 'computed', isReady),
          persist: record(experimentKey, recomputed, persisted.bucketingId, experiment.seed),
        }
      }
      return {
        result: toResult(
          experimentKey,
          experiment.controlVariant,
          'VARIANT_REMOVED_FALLBACK',
          'computed',
          isReady,
        ),
        persist: record(experimentKey, experiment.controlVariant, persisted.bucketingId, experiment.seed),
      }
    }

    // Provenance stale (seed or hash version changed): re-randomize under the stored
    // bucketing id and persist a fresh record.
    const recomputed = computeVariant(experiment, persisted.bucketingId) ?? experiment.controlVariant
    return {
      result: toResult(experimentKey, recomputed, 'COMPUTED', 'computed', isReady),
      persist: record(experimentKey, recomputed, persisted.bucketingId, experiment.seed),
    }
  }

  // (4) No stored assignment — first-time computation under the active bucketing id.
  const computed = computeVariant(experiment, currentBucketingId) ?? experiment.controlVariant
  return {
    result: toResult(experimentKey, computed, 'COMPUTED', 'computed', isReady),
    persist: record(experimentKey, computed, currentBucketingId, experiment.seed),
  }
}
