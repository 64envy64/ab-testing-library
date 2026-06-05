import { describe, expect, it } from 'vitest'

import {
  normalizeExperimentConfig,
  validateExperimentConfig,
  validateFeatureFlagConfig,
  validateRemoteConfig,
} from '../src/core/config'
import { AbErrorCode } from '../src/core/errors'
import type { ExperimentConfig } from '../src/core/types'

const validExperiment = {
  key: 'checkout-copy',
  seed: 'checkout.v1',
  enabled: true,
  controlVariant: 'control',
  variants: [
    { key: 'control', weight: 50 },
    { key: 'variant-b', weight: 50 },
  ],
}

const validFlag = { key: 'newCheckoutFlow', seed: 'flag.v1', enabled: true, rollout: 25 }

describe('validateExperimentConfig', () => {
  it('accepts a valid experiment with no issues', () => {
    const result = validateExperimentConfig(validExperiment)
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('accepts a zero-weight (paused) variant', () => {
    const result = validateExperimentConfig({
      ...validExperiment,
      variants: [
        { key: 'control', weight: 100 },
        { key: 'paused', weight: 0 },
      ],
    })
    expect(result.valid).toBe(true)
  })

  it('rejects a negative weight', () => {
    const result = validateExperimentConfig({
      ...validExperiment,
      controlVariant: 'control',
      variants: [{ key: 'control', weight: -1 }],
    })
    expect(result.valid).toBe(false)
    expect(result.issues.some((issue) => issue.code === AbErrorCode.VariantInvalid)).toBe(true)
  })

  it('rejects a non-finite weight', () => {
    const result = validateExperimentConfig({
      ...validExperiment,
      variants: [{ key: 'control', weight: Number.POSITIVE_INFINITY }],
    })
    expect(result.valid).toBe(false)
  })

  it('rejects empty variants', () => {
    expect(validateExperimentConfig({ ...validExperiment, variants: [] }).valid).toBe(false)
  })

  it('rejects a missing seed', () => {
    const { seed, ...withoutSeed } = validExperiment
    const result = validateExperimentConfig(withoutSeed)
    expect(result.valid).toBe(false)
    expect(result.issues.some((issue) => issue.code === AbErrorCode.ConfigInvalid)).toBe(true)
  })

  it('rejects a missing control variant', () => {
    const { controlVariant, ...withoutControl } = validExperiment
    expect(validateExperimentConfig(withoutControl).valid).toBe(false)
  })

  it('rejects a control variant absent from variants', () => {
    expect(validateExperimentConfig({ ...validExperiment, controlVariant: 'ghost' }).valid).toBe(false)
  })

  it('rejects duplicate variant keys', () => {
    const result = validateExperimentConfig({
      ...validExperiment,
      variants: [
        { key: 'control', weight: 50 },
        { key: 'control', weight: 50 },
      ],
    })
    expect(result.valid).toBe(false)
  })

  it('returns structured issues (code + message), never raw strings', () => {
    const result = validateExperimentConfig({})
    expect(result.issues.length).toBeGreaterThan(0)
    for (const issue of result.issues) {
      expect(Object.values(AbErrorCode)).toContain(issue.code)
      expect(typeof issue.message).toBe('string')
    }
  })
})

describe('validateFeatureFlagConfig', () => {
  it('accepts a valid flag', () => {
    expect(validateFeatureFlagConfig(validFlag).valid).toBe(true)
  })

  it('accepts rollout boundaries 0 and 100', () => {
    expect(validateFeatureFlagConfig({ ...validFlag, rollout: 0 }).valid).toBe(true)
    expect(validateFeatureFlagConfig({ ...validFlag, rollout: 100 }).valid).toBe(true)
  })

  it('rejects an out-of-range or non-finite rollout', () => {
    expect(validateFeatureFlagConfig({ ...validFlag, rollout: 150 }).valid).toBe(false)
    expect(validateFeatureFlagConfig({ ...validFlag, rollout: -5 }).valid).toBe(false)
    expect(validateFeatureFlagConfig({ ...validFlag, rollout: Number.NaN }).valid).toBe(false)
  })
})

describe('validateRemoteConfig', () => {
  it('accepts a valid remote config', () => {
    const result = validateRemoteConfig({
      experiments: { 'checkout-copy': validExperiment },
      flags: { newCheckoutFlow: validFlag },
    })
    expect(result.valid).toBe(true)
  })

  it('flags a map key that does not match the config "key" field', () => {
    const result = validateRemoteConfig({ experiments: { wrongKey: validExperiment }, flags: {} })
    expect(result.valid).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes('does not match'))).toBe(true)
  })

  it('flags a key present in both experiments and flags', () => {
    const result = validateRemoteConfig({
      experiments: { dup: { ...validExperiment, key: 'dup' } },
      flags: { dup: { ...validFlag, key: 'dup' } },
    })
    expect(result.valid).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes('both'))).toBe(true)
  })

  it('rejects prototype-pollution map keys (parsed from untrusted JSON)', () => {
    const malicious = JSON.parse(
      '{"experiments":{"__proto__":{"key":"__proto__","seed":"s","enabled":true,"controlVariant":"a","variants":[{"key":"a","weight":1}]}},"flags":{}}',
    ) as unknown
    const result = validateRemoteConfig(malicious)
    expect(result.valid).toBe(false)
    expect(result.issues.some((issue) => issue.message.toLowerCase().includes('unsafe'))).toBe(true)
  })

  it('rejects a non-object input', () => {
    expect(validateRemoteConfig(null).valid).toBe(false)
    expect(validateRemoteConfig('nope').valid).toBe(false)
  })
})

describe('normalizeExperimentConfig', () => {
  it('sorts variants by key without mutating the input', () => {
    const config: ExperimentConfig = {
      key: 'exp',
      seed: 'seed',
      enabled: true,
      controlVariant: 'a',
      variants: [
        { key: 'c', weight: 1 },
        { key: 'a', weight: 1 },
        { key: 'b', weight: 1 },
      ],
    }
    const normalized = normalizeExperimentConfig(config)
    expect(normalized.variants.map((variant) => variant.key)).toEqual(['a', 'b', 'c'])
    expect(config.variants.map((variant) => variant.key)).toEqual(['c', 'a', 'b'])
  })
})
