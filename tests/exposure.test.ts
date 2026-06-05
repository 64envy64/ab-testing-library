import { beforeEach, describe, expect, it } from 'vitest'

import { createAbClient } from '../src/core/abTestingClient'
import { ExposureTracker } from '../src/core/exposure'
import type { AssignmentResult, CreateAbClientOptions, ExposureEvent, RemoteConfig } from '../src/core/types'

function makeResult(overrides: Partial<AssignmentResult> = {}): AssignmentResult {
  return {
    experimentKey: 'exp',
    variant: 'a',
    reason: 'COMPUTED',
    source: 'computed',
    isReady: true,
    trackable: true,
    ...overrides,
  }
}

describe('ExposureTracker', () => {
  it('fires a fully-shaped event for trackable results', () => {
    const events: ExposureEvent[] = []
    const tracker = new ExposureTracker((event) => events.push(event), () => '2026-06-04T00:00:00.000Z')
    tracker.track(makeResult(), 'user-1', 7)
    expect(events).toEqual([
      {
        experimentKey: 'exp',
        variant: 'a',
        reason: 'COMPUTED',
        source: 'computed',
        bucketingId: 'user-1',
        configVersion: 7,
        timestamp: '2026-06-04T00:00:00.000Z',
      },
    ])
  })

  it('omits configVersion when it is undefined', () => {
    const events: ExposureEvent[] = []
    const tracker = new ExposureTracker((event) => events.push(event), () => 't')
    tracker.track(makeResult(), 'user-1', undefined)
    expect(events[0] !== undefined && 'configVersion' in events[0]).toBe(false)
  })

  it('does not fire for non-trackable results', () => {
    const events: ExposureEvent[] = []
    const tracker = new ExposureTracker((event) => events.push(event), () => 't')
    tracker.track(makeResult({ trackable: false, reason: 'EXPERIMENT_DISABLED' }), 'user-1', undefined)
    expect(events).toHaveLength(0)
  })

  it('dedupes by (bucketingId, experimentKey, variant)', () => {
    const events: ExposureEvent[] = []
    const tracker = new ExposureTracker((event) => events.push(event), () => 't')
    tracker.track(makeResult(), 'user-1', undefined)
    tracker.track(makeResult(), 'user-1', undefined) // duplicate → ignored
    expect(events).toHaveLength(1)
    tracker.track(makeResult({ variant: 'b' }), 'user-1', undefined) // new variant
    tracker.track(makeResult(), 'user-2', undefined) // new bucketing id
    expect(events).toHaveLength(3)
  })

  it('reset() clears the dedupe set', () => {
    const events: ExposureEvent[] = []
    const tracker = new ExposureTracker((event) => events.push(event), () => 't')
    tracker.track(makeResult(), 'user-1', undefined)
    tracker.reset()
    tracker.track(makeResult(), 'user-1', undefined)
    expect(events).toHaveLength(2)
  })
})

const config: RemoteConfig = {
  experiments: {
    exp: {
      key: 'exp',
      seed: 'exp-seed',
      enabled: true,
      controlVariant: 'control',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'treatment', weight: 50 },
      ],
    },
  },
  flags: {},
}

describe('exposure via the client', () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
  })

  function withExposures(overrides: Partial<CreateAbClientOptions> = {}) {
    const exposures: ExposureEvent[] = []
    const client = createAbClient({
      appKey: 'expo',
      persistence: 'memory',
      defaultConfig: config,
      onExposure: (event) => exposures.push(event),
      ...overrides,
    })
    client.initializeUser({ id: 'user-1' })
    return { client, exposures }
  }

  it('fires once for COMPUTED and dedupes the STICKY repeat', () => {
    const { client, exposures } = withExposures()
    client.getAssignment('exp')
    client.getAssignment('exp')
    expect(exposures).toHaveLength(1)
    expect(exposures[0]?.reason).toBe('COMPUTED')
  })

  it('fires for STICKY in a fresh session (reload)', () => {
    const e1: ExposureEvent[] = []
    const e2: ExposureEvent[] = []
    const base: CreateAbClientOptions = { appKey: 'expo-reload', persistence: 'local', defaultConfig: config }
    const c1 = createAbClient({ ...base, onExposure: (event) => e1.push(event) })
    c1.initializeUser({ id: 'user-1' })
    c1.getAssignment('exp')

    const c2 = createAbClient({ ...base, onExposure: (event) => e2.push(event) })
    c2.initializeUser({ id: 'user-1' })
    expect(c2.getAssignment('exp').reason).toBe('STICKY')
    expect(e2.some((event) => event.reason === 'STICKY')).toBe(true)

    c1.destroy()
    c2.destroy()
  })

  it('does not fire for forced / disabled / not-found', () => {
    const { client, exposures } = withExposures()
    client.setForcedOverride('exp', 'treatment')
    client.getAssignment('exp') // forced
    client.getAssignment('ghost') // not found
    client.clearForcedOverride()
    client.setConfig({ experiments: { exp: { ...config.experiments.exp!, enabled: false } }, flags: {} })
    client.getAssignment('exp') // disabled
    expect(exposures).toHaveLength(0)
  })

  it('track:false suppresses exposure', () => {
    const { client, exposures } = withExposures()
    client.getAssignment('exp', { track: false })
    expect(exposures).toHaveLength(0)
  })

  it('tracking:false suppresses exposure globally', () => {
    const { client, exposures } = withExposures({ tracking: false })
    client.getAssignment('exp')
    expect(exposures).toHaveLength(0)
  })

  it('a throwing onExposure does not crash evaluation', () => {
    const client = createAbClient({
      appKey: 'expo-throw',
      persistence: 'memory',
      defaultConfig: config,
      onExposure: () => {
        throw new Error('analytics sink down')
      },
    })
    client.initializeUser({ id: 'user-1' })
    expect(() => client.getAssignment('exp')).not.toThrow()
  })
})
