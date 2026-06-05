import { describe, expect, it } from 'vitest'

import { createAbClient } from '../src/core/abTestingClient'
import { FLAG_OFF, FLAG_ON, flagToExperiment } from '../src/core/featureFlags'
import type { FeatureFlagConfig, RemoteConfig } from '../src/core/types'

describe('flagToExperiment', () => {
  it('maps rollout to on/off weights with off as control', () => {
    const experiment = flagToExperiment({ key: 'f', seed: 's', enabled: true, rollout: 25 })
    expect(experiment.controlVariant).toBe(FLAG_OFF)
    expect(experiment.variants).toEqual([
      { key: FLAG_ON, weight: 25 },
      { key: FLAG_OFF, weight: 75 },
    ])
  })

  it('clamps out-of-range rollout', () => {
    expect(flagToExperiment({ key: 'f', seed: 's', enabled: true, rollout: 250 }).variants[0]?.weight).toBe(100)
  })
})

function clientWithFlags(flags: Record<string, FeatureFlagConfig>) {
  const config: RemoteConfig = { experiments: {}, flags }
  const client = createAbClient({ appKey: 'flags', persistence: 'memory', defaultConfig: config })
  client.initializeUser({ id: 'user-1' })
  return client
}

describe('isFeatureEnabled', () => {
  it('rollout 0 → false, rollout 100 → true', () => {
    const client = clientWithFlags({
      off: { key: 'off', seed: 's', enabled: true, rollout: 0 },
      on: { key: 'on', seed: 's', enabled: true, rollout: 100 },
    })
    expect(client.isFeatureEnabled('off')).toBe(false)
    expect(client.isFeatureEnabled('on')).toBe(true)
  })

  it('disabled flag → false regardless of rollout', () => {
    const client = clientWithFlags({ f: { key: 'f', seed: 's', enabled: false, rollout: 100 } })
    expect(client.isFeatureEnabled('f')).toBe(false)
  })

  it('unknown flag → false (fail open)', () => {
    const client = clientWithFlags({})
    expect(client.isFeatureEnabled('nope')).toBe(false)
  })

  it('percentage rollout is sticky and provenance-backed', () => {
    const client = clientWithFlags({ f: { key: 'f', seed: 'flag-seed', enabled: true, rollout: 50 } })
    const first = client.isFeatureEnabled('f')
    const record = client.getDebugState().assignments['f']
    expect(record).toBeDefined()
    expect(record?.seed).toBe('flag-seed')
    expect(client.isFeatureEnabled('f')).toBe(first)
  })
})
