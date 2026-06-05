import { describe, expect, it } from 'vitest'

import { evaluateExperiment, isTrackableReason } from '../src/core/assignment'
import { getBucketValue, HASH_VERSION, selectVariantByBucket } from '../src/core/hash'
import type { AssignmentReason, ExperimentConfig, PersistedAssignment } from '../src/core/types'

const experiment: ExperimentConfig = {
  key: 'exp',
  seed: 'exp-seed',
  enabled: true,
  controlVariant: 'control',
  variants: [
    { key: 'control', weight: 50 },
    { key: 'treatment', weight: 50 },
  ],
}

function persisted(overrides: Partial<PersistedAssignment> = {}): PersistedAssignment {
  return {
    experimentKey: 'exp',
    variantKey: 'control',
    bucketingId: 'user-1',
    hashVersion: HASH_VERSION,
    seed: 'exp-seed',
    assignedAt: '2026-01-01T00:00:00.000Z',
    assignedBy: 'computed',
    ...overrides,
  }
}

const base = { currentBucketingId: 'user-1', fallbackVariant: 'control', isReady: true }

describe('evaluateExperiment — pipeline branches', () => {
  it('missing experiment → EXPERIMENT_NOT_FOUND + fallbackVariant, clears a stale record', () => {
    const out = evaluateExperiment({ experimentKey: 'exp', experiment: undefined, persisted: persisted(), ...base })
    expect(out.result.reason).toBe('EXPERIMENT_NOT_FOUND')
    expect(out.result.variant).toBe('control')
    expect(out.result.trackable).toBe(false)
    expect(out.clear).toBe(true)
  })

  it('missing experiment during bootstrap (not ready) does NOT clear', () => {
    const out = evaluateExperiment({
      experimentKey: 'exp',
      experiment: undefined,
      persisted: persisted(),
      ...base,
      isReady: false,
    })
    expect(out.clear).toBe(false)
  })

  it('disabled → EXPERIMENT_DISABLED + control, keeps the record', () => {
    const out = evaluateExperiment({
      experimentKey: 'exp',
      experiment: { ...experiment, enabled: false },
      persisted: persisted(),
      ...base,
    })
    expect(out.result.reason).toBe('EXPERIMENT_DISABLED')
    expect(out.result.variant).toBe('control')
    expect(out.result.trackable).toBe(false)
    expect(out.persist).toBeUndefined()
    expect(out.clear).toBeUndefined()
  })

  it('valid provenance + variant exists → STICKY (source from assignedBy)', () => {
    const out = evaluateExperiment({
      experimentKey: 'exp',
      experiment,
      persisted: persisted({ variantKey: 'treatment' }),
      ...base,
    })
    expect(out.result.reason).toBe('STICKY')
    expect(out.result.variant).toBe('treatment')
    expect(out.result.source).toBe('computed')
    expect(out.result.trackable).toBe(true)
    expect(out.persist).toBeUndefined()
  })

  it('first-time (no persisted) → COMPUTED, persists provenance under current bucketing id', () => {
    const out = evaluateExperiment({ experimentKey: 'exp', experiment, persisted: undefined, ...base })
    expect(out.result.reason).toBe('COMPUTED')
    const expected = selectVariantByBucket(getBucketValue('exp-seed', 'user-1'), experiment.variants)
    expect(out.result.variant).toBe(expected)
    expect(out.persist).toMatchObject({
      experimentKey: 'exp',
      variantKey: expected,
      bucketingId: 'user-1',
      hashVersion: HASH_VERSION,
      seed: 'exp-seed',
      assignedBy: 'computed',
    })
  })

  it('variant removed but recomputable → VARIANT_REMOVED_REASSIGNED under the STORED bucketing id', () => {
    const out = evaluateExperiment({
      experimentKey: 'exp',
      experiment,
      persisted: persisted({ variantKey: 'ghost', bucketingId: 'user-9' }),
      ...base,
    })
    expect(out.result.reason).toBe('VARIANT_REMOVED_REASSIGNED')
    const expected = selectVariantByBucket(getBucketValue('exp-seed', 'user-9'), experiment.variants)
    expect(out.result.variant).toBe(expected)
    expect(out.persist?.bucketingId).toBe('user-9')
  })

  it('variant removed and nothing selectable → VARIANT_REMOVED_FALLBACK to control', () => {
    const allZero: ExperimentConfig = {
      ...experiment,
      variants: [
        { key: 'control', weight: 0 },
        { key: 'treatment', weight: 0 },
      ],
    }
    const out = evaluateExperiment({
      experimentKey: 'exp',
      experiment: allZero,
      persisted: persisted({ variantKey: 'ghost' }),
      ...base,
    })
    expect(out.result.reason).toBe('VARIANT_REMOVED_FALLBACK')
    expect(out.result.variant).toBe('control')
    expect(out.persist?.variantKey).toBe('control')
  })

  it('seed changed → COMPUTED (re-randomize) under the stored bucketing id', () => {
    const out = evaluateExperiment({
      experimentKey: 'exp',
      experiment: { ...experiment, seed: 'new-seed' },
      persisted: persisted({ seed: 'old-seed', bucketingId: 'user-7' }),
      ...base,
    })
    expect(out.result.reason).toBe('COMPUTED')
    const expected = selectVariantByBucket(getBucketValue('new-seed', 'user-7'), experiment.variants)
    expect(out.result.variant).toBe(expected)
    expect(out.persist?.seed).toBe('new-seed')
    expect(out.persist?.bucketingId).toBe('user-7')
  })

  it('hash version changed → COMPUTED with the current HASH_VERSION', () => {
    const out = evaluateExperiment({
      experimentKey: 'exp',
      experiment,
      persisted: persisted({ hashVersion: 'ancient' }),
      ...base,
    })
    expect(out.result.reason).toBe('COMPUTED')
    expect(out.persist?.hashVersion).toBe(HASH_VERSION)
  })
})

describe('isTrackableReason', () => {
  it('is true only for real active assignments', () => {
    const trackable: AssignmentReason[] = ['STICKY', 'COMPUTED', 'VARIANT_REMOVED_REASSIGNED', 'VARIANT_REMOVED_FALLBACK']
    for (const reason of trackable) expect(isTrackableReason(reason)).toBe(true)

    const notTrackable: AssignmentReason[] = [
      'EXPERIMENT_NOT_FOUND',
      'EXPERIMENT_DISABLED',
      'FORCED_OVERRIDE',
      'NOT_IN_EXPERIMENT',
      'DEFAULT_FALLBACK',
    ]
    for (const reason of notTrackable) expect(isTrackableReason(reason)).toBe(false)
  })
})
