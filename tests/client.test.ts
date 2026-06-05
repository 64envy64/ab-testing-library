import { beforeEach, describe, expect, it } from 'vitest'

import { createAbClient } from '../src/core/abTestingClient'
import { AbErrorCode } from '../src/core/errors'
import { createMockRemoteTransport } from '../src/testing/mockRemoteConfig'
import type { CreateAbClientOptions, ExperimentConfig, RemoteConfig } from '../src/core/types'

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
  return createAbClient({ appKey: 'test', persistence: 'memory', defaultConfig: config, ...overrides })
}

beforeEach(() => {
  globalThis.localStorage.clear()
})

describe('initialization & user identity', () => {
  it('throws NotInitialized when evaluating before init', () => {
    const client = makeClient()
    expect(() => client.getVariant('exp')).toThrowError(/initializeUser/)
    expect(() => client.isFeatureEnabled('exp')).toThrow()
    try {
      client.getAssignment('exp')
      expect.unreachable()
    } catch (error) {
      expect((error as { code?: string }).code).toBe(AbErrorCode.NotInitialized)
    }
  })

  it('stores the user WITHOUT raw email', () => {
    const client = makeClient({ persistence: 'local', appKey: 'noemail' })
    client.initializeUser({ id: 'user-1', email: 'secret@example.com' })
    const raw = globalThis.localStorage.getItem('abtest:noemail') ?? ''
    expect(raw).not.toContain('secret@example.com')
    expect(client.getDebugState().user).toEqual({ id: 'user-1' })
  })

  it('keeps caller-provided traits in memory only', () => {
    const client = makeClient({ persistence: 'local', appKey: 'traits' })
    client.initializeUser({ id: 'user-1', traits: { plan: 'pro', email: 'trait@example.com' } })
    const raw = globalThis.localStorage.getItem('abtest:traits') ?? ''
    expect(raw).not.toContain('plan')
    expect(raw).not.toContain('trait@example.com')
    expect(client.getDebugState().user).toEqual({ id: 'user-1' })
  })

  it('does not crash when an untyped consumer passes non-JSON traits', () => {
    const client = makeClient({ persistence: 'local', appKey: 'bad-traits' })
    expect(() => {
      // @ts-expect-error JS consumers can still pass values outside the typed contract.
      client.initializeUser({ id: 'user-1', traits: { n: 1n } })
    }).not.toThrow()
    expect(globalThis.localStorage.getItem('abtest:bad-traits') ?? '').not.toContain('traits')
  })

  it('generates an anonymous id when no id is given', () => {
    const client = makeClient()
    client.initializeUser({})
    const debug = client.getDebugState()
    expect(debug.bucketingId).toMatch(/^anon-/)
    expect(debug.user?.anonymousId).toBe(debug.bucketingId)
  })
})

describe('assignment pipeline via the client', () => {
  it('unknown experiment → fallbackVariant + EXPERIMENT_NOT_FOUND (no throw)', () => {
    const errors: string[] = []
    const client = makeClient({
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.message ?? '')
      },
    })
    client.initializeUser({ id: 'user-1' })
    const assignment = client.getAssignment('ghost')
    expect(assignment.reason).toBe('EXPERIMENT_NOT_FOUND')
    expect(assignment.variant).toBe('control')
    expect(assignment.trackable).toBe(false)
    expect(errors.some((message) => message.includes('Unknown experiment "ghost"'))).toBe(true)
    client.getAssignment('ghost')
    expect(errors.filter((message) => message.includes('Unknown experiment "ghost"'))).toHaveLength(1)
  })

  it('fails open when a validated config omits a map (no crash)', () => {
    // validateRemoteConfig accepts a config missing the `flags` or `experiments` map;
    // reads must normalize it instead of dereferencing undefined.
    const noFlags = createAbClient({
      appKey: 'partial-flags',
      persistence: 'memory',
      defaultConfig: { experiments: {} } as unknown as RemoteConfig,
    })
    noFlags.initializeUser({ id: 'user-1' })
    expect(noFlags.isFeatureEnabled('newCheckoutFlow')).toBe(false)

    const noExperiments = createAbClient({
      appKey: 'partial-exps',
      persistence: 'memory',
      defaultConfig: { flags: {} } as unknown as RemoteConfig,
    })
    noExperiments.initializeUser({ id: 'user-1' })
    const assignment = noExperiments.getAssignment('checkout-copy')
    expect(assignment.reason).toBe('EXPERIMENT_NOT_FOUND')
    expect(assignment.variant).toBe('control')
  })

  it('first evaluation is COMPUTED and persists provenance', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    const assignment = client.getAssignment('exp')
    expect(assignment.reason).toBe('COMPUTED')
    const record = client.getDebugState().assignments['exp']
    expect(record).toMatchObject({ experimentKey: 'exp', seed: 'exp-seed', bucketingId: 'user-1', assignedBy: 'computed' })
    expect(record?.variantKey).toBe(assignment.variant)
  })

  it('second evaluation is STICKY', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    const first = client.getAssignment('exp')
    const second = client.getAssignment('exp')
    expect(second.reason).toBe('STICKY')
    expect(second.variant).toBe(first.variant)
  })

  it('reload (new instance, shared storage) rehydrates to STICKY', () => {
    const opts: CreateAbClientOptions = { appKey: 'reload', persistence: 'local', defaultConfig: config }
    const c1 = createAbClient(opts)
    c1.initializeUser({ id: 'user-1' })
    const first = c1.getAssignment('exp')

    const c2 = createAbClient(opts)
    c2.initializeUser({ id: 'user-1' })
    const second = c2.getAssignment('exp')

    expect(second.reason).toBe('STICKY')
    expect(second.variant).toBe(first.variant)
  })

  it('split/weight change keeps the sticky variant', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    const first = client.getAssignment('exp')
    client.setConfig({
      experiments: { exp: { ...expConfig, variants: [{ key: 'control', weight: 90 }, { key: 'treatment', weight: 10 }] } },
      flags: {},
    })
    const after = client.getAssignment('exp')
    expect(after.reason).toBe('STICKY')
    expect(after.variant).toBe(first.variant)
  })

  it('disabled experiment returns control and keeps the assignment', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    client.getAssignment('exp')
    client.setConfig({ experiments: { exp: { ...expConfig, enabled: false } }, flags: {} })
    const after = client.getAssignment('exp')
    expect(after.reason).toBe('EXPERIMENT_DISABLED')
    expect(after.variant).toBe('control')
    expect(client.getDebugState().assignments['exp']).toBeDefined()
  })

  it('removed experiment clears the assignment', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    client.getAssignment('exp')
    client.setConfig({ experiments: {}, flags: {} })
    const after = client.getAssignment('exp')
    expect(after.reason).toBe('EXPERIMENT_NOT_FOUND')
    expect(client.getDebugState().assignments['exp']).toBeUndefined()
  })

  it('removed variant reassigns to a valid variant', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-2' }) // buckets to "treatment" for exp-seed
    const first = client.getAssignment('exp')
    expect(first.variant).toBe('treatment')
    client.setConfig({
      experiments: { exp: { key: 'exp', seed: 'exp-seed', enabled: true, controlVariant: 'control', variants: [{ key: 'control', weight: 50 }, { key: 'fresh', weight: 50 }] } },
      flags: {},
    })
    const after = client.getAssignment('exp')
    expect(['VARIANT_REMOVED_REASSIGNED', 'VARIANT_REMOVED_FALLBACK']).toContain(after.reason)
    expect(['control', 'fresh']).toContain(after.variant)
  })

  it('seed change recomputes (COMPUTED)', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    client.getAssignment('exp')
    client.setConfig({ experiments: { exp: { ...expConfig, seed: 'rotated-seed' } }, flags: {} })
    expect(client.getAssignment('exp').reason).toBe('COMPUTED')
  })
})

describe('identity transitions', () => {
  it('updating email does not reassign', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    const first = client.getAssignment('exp')
    client.updateUser({ email: 'a@b.c' })
    const after = client.getAssignment('exp')
    expect(after.reason).toBe('STICKY')
    expect(after.variant).toBe(first.variant)
  })

  it('anon → known keeps existing assignments under the old bucketing id', () => {
    const client = makeClient()
    client.initializeUser({})
    const anonId = client.getDebugState().bucketingId
    const first = client.getAssignment('exp')
    client.updateUser({ id: 'user-known' })
    const after = client.getAssignment('exp')
    expect(after.reason).toBe('STICKY')
    expect(after.variant).toBe(first.variant)
    expect(client.getDebugState().assignments['exp']?.bucketingId).toBe(anonId)
    expect(client.getDebugState().bucketingId).toBe('user-known')
  })

  it('new experiment after login uses the known id', () => {
    const client = makeClient()
    client.initializeUser({})
    client.getAssignment('exp')
    client.updateUser({ id: 'user-known' })
    client.setConfig({
      experiments: {
        ...config.experiments,
        exp2: { key: 'exp2', seed: 'exp2-seed', enabled: true, controlVariant: 'control', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] },
      },
      flags: {},
    })
    client.getAssignment('exp2')
    expect(client.getDebugState().assignments['exp2']?.bucketingId).toBe('user-known')
  })

  it('known → different known resets assignments', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    client.getAssignment('exp')
    client.updateUser({ id: 'user-2' })
    expect(client.getDebugState().assignments['exp']).toBeUndefined()
    const after = client.getAssignment('exp')
    expect(after.reason).toBe('COMPUTED')
    expect(client.getDebugState().assignments['exp']?.bucketingId).toBe('user-2')
  })

  it('reassignVariant: true forces a recompute', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    client.getAssignment('exp')
    expect(client.getAssignment('exp').reason).toBe('STICKY')
    client.updateUser({ id: 'user-1' }, { reassignVariant: true })
    expect(client.getAssignment('exp').reason).toBe('COMPUTED')
  })
})

describe('reset / clear / config hygiene', () => {
  it('reset() wipes user + assignments and de-initializes', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    client.getAssignment('exp')
    client.reset()
    expect(() => client.getVariant('exp')).toThrow()
    expect(client.getDebugState().assignments).toEqual({})
    expect(client.getDebugState().user).toBeUndefined()
  })

  it('resetAssignment clears a single experiment and recomputes next time', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    client.getAssignment('exp')
    client.resetAssignment('exp')
    expect(client.getDebugState().assignments['exp']).toBeUndefined()
    expect(client.getAssignment('exp').reason).toBe('COMPUTED')
  })

  it('invalid config fails open (no throw) and keeps the last-good config', () => {
    const errors: string[] = []
    const client = makeClient({
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.message ?? '')
      },
    })
    client.initializeUser({ id: 'user-1' })
    const before = client.getAssignment('exp').variant
    // @ts-expect-error intentionally invalid experiment shape
    client.setConfig({ experiments: { exp: { key: 'exp' } }, flags: {} })
    expect(errors.length).toBeGreaterThan(0)
    expect(client.getAssignment('exp').variant).toBe(before)
  })

  it('strict mode throws on invalid config', () => {
    const client = makeClient({ strict: true })
    client.initializeUser({ id: 'user-1' })
    // @ts-expect-error intentionally invalid experiment shape
    expect(() => client.setConfig({ experiments: { exp: { key: 'exp' } }, flags: {} })).toThrow()
  })

  it('invalid defaultConfig fails open at construction and does not crash evaluation', () => {
    const errors: string[] = []
    const client = createAbClient({
      appKey: 'bad-default',
      persistence: 'memory',
      // @ts-expect-error intentionally invalid default config from an untyped consumer
      defaultConfig: { experiments: { exp: { key: 'exp' } }, flags: {} },
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.message ?? '')
      },
    })
    client.initializeUser({ id: 'user-1' })
    const assignment = client.getAssignment('exp')
    expect(errors.length).toBeGreaterThan(0)
    expect(assignment.reason).toBe('EXPERIMENT_NOT_FOUND')
  })

  it('strict mode throws on invalid defaultConfig at construction', () => {
    expect(() =>
      createAbClient({
        appKey: 'bad-default-strict',
        persistence: 'memory',
        strict: true,
        // @ts-expect-error intentionally invalid default config from an untyped consumer
        defaultConfig: { experiments: { exp: { key: 'exp' } }, flags: {} },
      }),
    ).toThrow()
  })

  it('invalid cached bootstrap config is discarded and default config remains usable', () => {
    globalThis.localStorage.setItem(
      'abtest:bad-cache',
      JSON.stringify({
        schemaVersion: 1,
        assignments: {},
        cachedConfig: { experiments: { exp: { key: 'exp' } }, flags: {} },
        cachedConfigVersion: 10,
      }),
    )

    const errors: string[] = []
    const client = createAbClient({
      appKey: 'bad-cache',
      persistence: 'local',
      defaultConfig: config,
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.message ?? '')
      },
    })

    client.initializeUser({ id: 'user-1' })
    expect(errors.length).toBeGreaterThan(0)
    expect(client.getAssignment('exp').reason).toBe('COMPUTED')
    expect(globalThis.localStorage.getItem('abtest:bad-cache')).not.toContain('cachedConfigVersion')
  })

  it('destroy() makes further calls throw', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    client.destroy()
    expect(() => client.getVariant('exp')).toThrow()
  })
})

describe('subscriptions', () => {
  it('notifies subscribers on change and stops after unsubscribe', () => {
    const client = makeClient()
    let calls = 0
    const unsubscribe = client.subscribe(() => {
      calls++
    })
    client.initializeUser({ id: 'user-1' }) // change
    client.getAssignment('exp') // COMPUTED → change
    expect(calls).toBeGreaterThanOrEqual(2)

    const atUnsubscribe = calls
    unsubscribe()
    client.setForcedOverride('exp', 'treatment') // emits a change, but we are unsubscribed
    expect(calls).toBe(atUnsubscribe)
  })

  it('a throwing subscriber does not break other subscribers or the client', () => {
    const client = makeClient()
    let good = 0
    client.subscribe(() => {
      throw new Error('bad listener')
    })
    client.subscribe(() => {
      good++
    })
    expect(() => client.initializeUser({ id: 'user-1' })).not.toThrow()
    expect(good).toBeGreaterThan(0)
  })
})

describe('remote config integration', () => {
  it('a configured remote keeps isReady=false until the first replace, then applies + flips it', () => {
    const transport = createMockRemoteTransport()
    const client = createAbClient({
      appKey: 'test',
      persistence: 'memory',
      defaultConfig: config,
      remote: { transport, reconnect: { enabled: false } },
    })
    client.initializeUser({ id: 'user-1' })
    expect(client.getDebugState().isReady).toBe(false)

    transport.pushConfig(
      { experiments: { exp: { ...expConfig, variants: [{ key: 'control', weight: 0 }, { key: 'treatment', weight: 100 }] } }, flags: {} },
      1,
    )
    expect(client.getDebugState().isReady).toBe(true)
    expect(client.getVariant('exp')).toBe('treatment')
    client.destroy()
  })
})
