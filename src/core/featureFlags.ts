/**
 * Feature flags reuse the experiment evaluation pipeline (docs/BEHAVIOR_CONTRACT.md
 * "Feature Flags"). A percentage-rollout flag is modeled as a two-variant on/off
 * experiment, so flags inherit sticky/provenance-backed assignment and exposure
 * eligibility for free.
 */
import type { ExperimentConfig, FeatureFlagConfig } from './types'

export const FLAG_ON = 'on'
export const FLAG_OFF = 'off'

/** Convert a feature flag into the equivalent on/off weighted experiment. */
export function flagToExperiment(flag: FeatureFlagConfig): ExperimentConfig {
  const onWeight = Math.max(0, Math.min(100, flag.rollout))
  return {
    key: flag.key,
    seed: flag.seed,
    enabled: flag.enabled,
    controlVariant: FLAG_OFF,
    variants: [
      { key: FLAG_ON, weight: onWeight },
      { key: FLAG_OFF, weight: 100 - onWeight },
    ],
  }
}
