import { describe, expect, it } from 'vitest'

import { createAbClient } from '../src/core/abTestingClient'
import { OverrideLayer } from '../src/core/overrides'
import type { CreateAbClientOptions, ExperimentConfig, ExposureEvent, RemoteConfig } from '../src/core/types'

const expConfig: ExperimentConfig = {
  key: 'exp',
  seed: 'exp-seed',
  enabled: true,
  controlVariant: 'control',
  variants: [
    { key: 'control', weight: 50 },
    { key: 'treatment', weight: 50 },
  ],
}
const config: RemoteConfig = { experiments: { exp: expConfig }, flags: {} }

function makeClient(overrides: Partial<CreateAbClientOptions> = {}) {
  const client = createAbClient({ appKey: 'ovr', persistence: 'memory', defaultConfig: config, ...overrides })
  client.initializeUser({ id: 'user-1' })
  return client
}

describe('OverrideLayer', () => {
  it('applyAdmin patches existing experiments (shallow) and ignores unknown keys', () => {
    const layer = new OverrideLayer()
    layer.setAdmin({ experiments: { exp: { enabled: false }, ghost: { enabled: true } } })
    const result = layer.applyAdmin(config)
    expect(result.experiments.exp?.enabled).toBe(false)
    expect(result.experiments.exp?.variants).toEqual(expConfig.variants)
    expect(result.experiments.ghost).toBeUndefined()
  })

  it('applyAdmin returns the base reference unchanged when there are no overrides', () => {
    const layer = new OverrideLayer()
    expect(layer.applyAdmin(config)).toBe(config)
  })

  it('forced get / set / clear', () => {
    const layer = new OverrideLayer()
    layer.setForced('exp', 'treatment')
    expect(layer.getForced('exp')).toBe('treatment')
    expect(layer.forcedSnapshot()).toEqual({ exp: 'treatment' })
    layer.clearForced('exp')
    expect(layer.getForced('exp')).toBeUndefined()
  })
})

describe('forced overrides via the client', () => {
  it('returns FORCED_OVERRIDE without persisting or tracking', () => {
    const exposures: ExposureEvent[] = []
    const client = makeClient({ onExposure: (event) => exposures.push(event) })
    client.setForcedOverride('exp', 'treatment')
    const assignment = client.getAssignment('exp')
    expect(assignment.reason).toBe('FORCED_OVERRIDE')
    expect(assignment.variant).toBe('treatment')
    expect(assignment.source).toBe('forced')
    expect(assignment.trackable).toBe(false)
    expect(client.getDebugState().assignments['exp']).toBeUndefined()
    expect(exposures).toHaveLength(0)
  })

  it('clearForcedOverride restores normal evaluation', () => {
    const client = makeClient()
    client.setForcedOverride('exp', 'treatment')
    expect(client.getVariant('exp')).toBe('treatment')
    client.clearForcedOverride('exp')
    expect(client.getAssignment('exp').reason).toBe('COMPUTED')
  })

  it('loadForcedOverridesFromUrl parses ab_force_ params', () => {
    const client = makeClient()
    client.loadForcedOverridesFromUrl(new URLSearchParams('?ab_force_exp=treatment&unrelated=x&ab_force_=skip'))
    expect(client.getAssignment('exp').reason).toBe('FORCED_OVERRIDE')
    expect(client.getVariant('exp')).toBe('treatment')
    expect(client.getDebugState().forcedOverrides).toEqual({ exp: 'treatment' })
  })

  it('a custom prefix can be supplied per call', () => {
    const client = makeClient()
    client.loadForcedOverridesFromUrl(new URLSearchParams('?qa_exp=treatment'), { prefix: 'qa_' })
    expect(client.getVariant('exp')).toBe('treatment')
  })

  it('can force a feature flag on/off', () => {
    const client = createAbClient({
      appKey: 'ovr-flag',
      persistence: 'memory',
      defaultConfig: { experiments: {}, flags: { f: { key: 'f', seed: 's', enabled: true, rollout: 0 } } },
    })
    client.initializeUser({ id: 'user-1' })
    expect(client.isFeatureEnabled('f')).toBe(false)
    client.setForcedOverride('f', 'on')
    expect(client.isFeatureEnabled('f')).toBe(true)
  })
})

describe('admin overrides via the client', () => {
  it('changes the enabled state', () => {
    const client = makeClient()
    client.getAssignment('exp')
    client.setAdminOverride({ experiments: { exp: { enabled: false } } })
    expect(client.getAssignment('exp').reason).toBe('EXPERIMENT_DISABLED')
    expect(client.getDebugState().adminOverrideKeys).toContain('exp')
  })

  it('changes the split and the experiment evaluates against it', () => {
    const client = makeClient()
    client.setAdminOverride({
      experiments: { exp: { variants: [{ key: 'control', weight: 0 }, { key: 'treatment', weight: 100 }] } },
    })
    expect(client.getVariant('exp')).toBe('treatment')
  })

  it('survives a setConfig (base config replacement)', () => {
    const client = makeClient()
    client.setAdminOverride({ experiments: { exp: { enabled: false } } })
    client.setConfig({ experiments: { exp: { ...expConfig } }, flags: {} })
    expect(client.getAssignment('exp').reason).toBe('EXPERIMENT_DISABLED')
    client.clearAdminOverride('exp')
    expect(client.getAssignment('exp').reason).not.toBe('EXPERIMENT_DISABLED')
  })
})
