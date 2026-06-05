import { describe, expect, it } from 'vitest'

import {
  getBucketValue,
  HASH_VERSION,
  hashToUnitInterval,
  murmur3_32,
  selectVariantByBucket,
} from '../src/core/hash'

type Weights = Array<{ key: string; weight: number }>

function shares(weights: Weights, seed: string, n: number): Record<string, number> {
  const counts: Record<string, number> = {}
  for (let i = 0; i < n; i++) {
    const variant = selectVariantByBucket(getBucketValue(seed, `user-${i}`), weights)
    if (variant !== null) counts[variant] = (counts[variant] ?? 0) + 1
  }
  const result: Record<string, number> = {}
  for (const [key, count] of Object.entries(counts)) result[key] = count / n
  return result
}

describe('murmur3_32 — known vectors (cross-checked against the mmh3 reference)', () => {
  // foo / hello / "" / ("", seed 1) match canonical mmh3 outputs, which proves the
  // implementation conforms to the spec; the rest are correct-by-construction.
  it.each<[string, number, number]>([
    ['', 0, 0],
    ['foo', 0, 4138058784],
    ['hello', 0, 613153351],
    ['test', 0, 3127628307],
    ['The quick brown fox jumps over the lazy dog', 0, 776992547],
    ['', 1, 1364076727],
  ])('murmur3_32(%j, %i) === %i', (input, seed, expected) => {
    expect(murmur3_32(input, seed)).toBe(expected)
  })
})

describe('murmur3_32 — properties', () => {
  it('is deterministic for the same input', () => {
    for (const value of ['', 'a', 'user-42', 'Hello, world!', '🎯 unicode ✓']) {
      expect(murmur3_32(value)).toBe(murmur3_32(value))
    }
  })

  it('always returns an unsigned 32-bit integer', () => {
    for (let i = 0; i < 5000; i++) {
      const hash = murmur3_32(`id-${i}`)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThanOrEqual(0xffffffff)
      expect(hash >>> 0).toBe(hash)
    }
  })

  it('changes when the numeric seed changes', () => {
    expect(murmur3_32('same-input', 0)).not.toBe(murmur3_32('same-input', 1))
  })
})

describe('hashToUnitInterval', () => {
  it('maps the full uint32 range into [0, 1)', () => {
    expect(hashToUnitInterval(0)).toBe(0)
    expect(hashToUnitInterval(0xffffffff)).toBeLessThan(1)
    for (let i = 0; i < 20000; i++) {
      const unit = hashToUnitInterval(murmur3_32(`u-${i}`))
      expect(unit).toBeGreaterThanOrEqual(0)
      expect(unit).toBeLessThan(1)
    }
  })
})

describe('getBucketValue', () => {
  it('hashes `${seed}:${bucketingId}` per the contract', () => {
    expect(getBucketValue('seed', 'id')).toBe(hashToUnitInterval(murmur3_32('seed:id')))
  })

  it('is deterministic / sticky for the same inputs', () => {
    expect(getBucketValue('exp', 'user-1')).toBe(getBucketValue('exp', 'user-1'))
  })

  it('re-randomizes when the seed (salt) changes', () => {
    expect(getBucketValue('seedA', 'user-1')).not.toBe(getBucketValue('seedB', 'user-1'))
  })

  it('HASH_VERSION is stable', () => {
    expect(HASH_VERSION).toBe('murmur3_x86_32.v1')
  })

  it('golden bucket snapshots (regression guard — a break here means a re-randomization; bump HASH_VERSION)', () => {
    expect(getBucketValue('exp-seed', 'user-1')).toBe(0.26555441482923925)
    expect(getBucketValue('exp-seed', 'user-2')).toBe(0.9552830450702459)
    expect(getBucketValue('checkout.v1', 'user-123')).toBe(0.37821115041151643)
    expect(getBucketValue('flag-seed', 'anon-abc')).toBe(0.8428325077984482)
  })
})

describe('selectVariantByBucket', () => {
  const ab: Weights = [
    { key: 'a', weight: 50 },
    { key: 'b', weight: 50 },
  ]

  it('returns null when nothing is selectable', () => {
    expect(selectVariantByBucket(0.5, [])).toBeNull()
    expect(selectVariantByBucket(0.5, [{ key: 'x', weight: 0 }])).toBeNull()
  })

  it('uses cumulative ranges over key-sorted variants', () => {
    expect(selectVariantByBucket(0, ab)).toBe('a')
    expect(selectVariantByBucket(0.49, ab)).toBe('a')
    expect(selectVariantByBucket(0.5, ab)).toBe('b')
    expect(selectVariantByBucket(0.999, ab)).toBe('b')
  })

  it('is independent of JSON variant order (variants sorted by key)', () => {
    const forward: Weights = [
      { key: 'a', weight: 50 },
      { key: 'b', weight: 50 },
    ]
    const reversed: Weights = [
      { key: 'b', weight: 50 },
      { key: 'a', weight: 50 },
    ]
    for (const unit of [0.1, 0.3, 0.49, 0.51, 0.7, 0.95]) {
      expect(selectVariantByBucket(unit, forward)).toBe(selectVariantByBucket(unit, reversed))
    }
  })

  it('never selects a zero-weight (paused) variant', () => {
    const variants: Weights = [
      { key: 'a', weight: 0 },
      { key: 'b', weight: 100 },
    ]
    for (let i = 0; i < 1000; i++) {
      expect(selectVariantByBucket(getBucketValue('s', `u-${i}`), variants)).toBe('b')
    }
  })
})

describe('distribution — 100k deterministic ids within ±1% tolerance', () => {
  it('50/50 split lands within 49–51%', () => {
    const s = shares(
      [
        { key: 'a', weight: 50 },
        { key: 'b', weight: 50 },
      ],
      'dist-5050',
      100_000,
    )
    expect(s['a'] ?? 0).toBeGreaterThan(0.49)
    expect(s['a'] ?? 0).toBeLessThan(0.51)
    expect(s['b'] ?? 0).toBeGreaterThan(0.49)
    expect(s['b'] ?? 0).toBeLessThan(0.51)
  })

  it('80/20 split respects weights within ±1%', () => {
    const s = shares(
      [
        { key: 'a', weight: 80 },
        { key: 'b', weight: 20 },
      ],
      'dist-8020',
      100_000,
    )
    expect(s['a'] ?? 0).toBeGreaterThan(0.79)
    expect(s['a'] ?? 0).toBeLessThan(0.81)
    expect(s['b'] ?? 0).toBeGreaterThan(0.19)
    expect(s['b'] ?? 0).toBeLessThan(0.21)
  })

  it('two experiments bucket the same users independently (no carryover bias)', () => {
    const ab: Weights = [
      { key: 'a', weight: 50 },
      { key: 'b', weight: 50 },
    ]
    let inA = 0
    let inAAndB = 0
    const n = 50_000
    for (let i = 0; i < n; i++) {
      const a = selectVariantByBucket(getBucketValue('exp-A', `user-${i}`), ab) === 'a'
      const b = selectVariantByBucket(getBucketValue('exp-B', `user-${i}`), ab) === 'a'
      if (a) inA++
      if (a && b) inAAndB++
    }
    // P(B='a' | A='a') ≈ 0.5 under independence.
    const conditional = inAAndB / inA
    expect(conditional).toBeGreaterThan(0.45)
    expect(conditional).toBeLessThan(0.55)
  })
})
