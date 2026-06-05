/**
 * Zero-dependency runtime validation for untrusted config (docs/BEHAVIOR_CONTRACT.md
 * "Config Hygiene"). Remote config is untrusted input, so we validate shape and
 * fail open rather than trusting parsed JSON.
 *
 * Deliberately hand-rolled — no `zod` or other runtime dependency — to keep the
 * core bundle small and free of version conflicts. Validators return structured
 * `AbIssue[]`, never free-form strings.
 */
import { AbErrorCode, abIssue, type AbIssue } from './errors'
import type { ExperimentConfig, FeatureFlagConfig, RemoteConfig } from './types'

export interface ValidationResult {
  valid: boolean
  issues: AbIssue[]
}

// Object keys that would enable prototype pollution if treated as a map key.
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function validateExperimentConfig(input: unknown): ValidationResult {
  const issues: AbIssue[] = []
  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [abIssue(AbErrorCode.ConfigInvalid, 'Experiment config must be an object')],
    }
  }

  const { key, seed, enabled, controlVariant, variants } = input
  const ctx = isNonEmptyString(key) ? { key } : undefined

  if (!isNonEmptyString(key)) {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Experiment "key" must be a non-empty string'))
  }
  if (!isNonEmptyString(seed)) {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Experiment "seed" must be a non-empty string', ctx))
  }
  if (typeof enabled !== 'boolean') {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Experiment "enabled" must be a boolean', ctx))
  }
  if (!isNonEmptyString(controlVariant)) {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Experiment "controlVariant" must be a non-empty string', ctx))
  }

  const variantKeys = new Set<string>()
  if (!Array.isArray(variants) || variants.length === 0) {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Experiment "variants" must be a non-empty array', ctx))
  } else {
    variants.forEach((variant, index) => {
      if (!isRecord(variant)) {
        issues.push(abIssue(AbErrorCode.VariantInvalid, `Variant at index ${index} must be an object`, ctx))
        return
      }
      if (!isNonEmptyString(variant.key)) {
        issues.push(abIssue(AbErrorCode.VariantInvalid, `Variant at index ${index} has an invalid "key"`, ctx))
      } else if (variantKeys.has(variant.key)) {
        issues.push(abIssue(AbErrorCode.VariantInvalid, `Duplicate variant key "${variant.key}"`, ctx))
      } else {
        variantKeys.add(variant.key)
      }
      // Zero weight is valid (paused variant); negative / non-finite weight is not.
      if (!isFiniteNumber(variant.weight) || variant.weight < 0) {
        issues.push(
          abIssue(AbErrorCode.VariantInvalid, `Variant "${String(variant.key)}" weight must be a finite number >= 0`, ctx),
        )
      }
    })
  }

  if (isNonEmptyString(controlVariant) && variantKeys.size > 0 && !variantKeys.has(controlVariant)) {
    issues.push(
      abIssue(AbErrorCode.ConfigInvalid, `controlVariant "${controlVariant}" is not among the experiment's variants`, ctx),
    )
  }

  return { valid: issues.length === 0, issues }
}

export function validateFeatureFlagConfig(input: unknown): ValidationResult {
  const issues: AbIssue[] = []
  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [abIssue(AbErrorCode.ConfigInvalid, 'Feature flag config must be an object')],
    }
  }

  const { key, seed, enabled, rollout } = input
  const ctx = isNonEmptyString(key) ? { key } : undefined

  if (!isNonEmptyString(key)) {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Flag "key" must be a non-empty string'))
  }
  if (!isNonEmptyString(seed)) {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Flag "seed" must be a non-empty string', ctx))
  }
  if (typeof enabled !== 'boolean') {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Flag "enabled" must be a boolean', ctx))
  }
  if (!isFiniteNumber(rollout) || rollout < 0 || rollout > 100) {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Flag "rollout" must be a finite number in [0, 100]', ctx))
  }

  return { valid: issues.length === 0, issues }
}

export function validateRemoteConfig(input: unknown): ValidationResult {
  const issues: AbIssue[] = []
  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [abIssue(AbErrorCode.ConfigInvalid, 'Remote config must be an object')],
    }
  }

  const { experiments, flags } = input

  if (experiments !== undefined && !isRecord(experiments)) {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Remote config "experiments" must be an object map'))
  }
  if (flags !== undefined && !isRecord(flags)) {
    issues.push(abIssue(AbErrorCode.ConfigInvalid, 'Remote config "flags" must be an object map'))
  }

  const experimentKeys = isRecord(experiments) ? Object.keys(experiments) : []
  const flagKeys = isRecord(flags) ? Object.keys(flags) : []

  if (isRecord(experiments)) {
    for (const mapKey of experimentKeys) {
      if (UNSAFE_KEYS.has(mapKey)) {
        issues.push(abIssue(AbErrorCode.ConfigInvalid, `Unsafe experiment key "${mapKey}"`))
        continue
      }
      const entry = experiments[mapKey]
      issues.push(...validateExperimentConfig(entry).issues)
      if (isRecord(entry) && entry.key !== undefined && entry.key !== mapKey) {
        issues.push(
          abIssue(AbErrorCode.ConfigInvalid, `Experiment map key "${mapKey}" does not match its "key" field`, {
            mapKey,
            configKey: entry.key,
          }),
        )
      }
    }
  }

  if (isRecord(flags)) {
    for (const mapKey of flagKeys) {
      if (UNSAFE_KEYS.has(mapKey)) {
        issues.push(abIssue(AbErrorCode.ConfigInvalid, `Unsafe flag key "${mapKey}"`))
        continue
      }
      const entry = flags[mapKey]
      issues.push(...validateFeatureFlagConfig(entry).issues)
      if (isRecord(entry) && entry.key !== undefined && entry.key !== mapKey) {
        issues.push(
          abIssue(AbErrorCode.ConfigInvalid, `Flag map key "${mapKey}" does not match its "key" field`, { mapKey }),
        )
      }
    }
  }

  for (const mapKey of experimentKeys) {
    if (flagKeys.includes(mapKey)) {
      issues.push(abIssue(AbErrorCode.ConfigInvalid, `Key "${mapKey}" appears in both experiments and flags`))
    }
  }

  return { valid: issues.length === 0, issues }
}

/**
 * Canonicalizes an experiment config by sorting variants by key (code-unit order),
 * giving deterministic, JSON-order-independent bucketing ranges. Does not mutate the
 * input.
 */
export function normalizeExperimentConfig(config: ExperimentConfig): ExperimentConfig {
  return {
    ...config,
    variants: [...config.variants].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  }
}

/**
 * Guarantees both config maps exist. `validateRemoteConfig` accepts a config whose
 * `experiments` or `flags` map is absent (treated as "none"); normalizing here keeps
 * every downstream read fail-open instead of dereferencing `undefined`.
 */
export function normalizeRemoteConfig(config: {
  experiments?: Record<string, ExperimentConfig>
  flags?: Record<string, FeatureFlagConfig>
}): RemoteConfig {
  return {
    experiments: config.experiments ?? {},
    flags: config.flags ?? {},
  }
}
