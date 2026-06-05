import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAbClient } from '../src/core/abTestingClient'
import { AbErrorCode } from '../src/core/errors'
import { computeBackoffDelay, createWebSocketTransport, resolveReconnectOptions } from '../src/core/remote'
import { createMockRemoteTransport } from '../src/testing/mockRemoteConfig'
import type { AbSdkEvent, CreateAbClientOptions, RemoteConfig } from '../src/core/types'

const baseConfig: RemoteConfig = {
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

// Distinguishable from baseConfig: all-treatment, so "is the cached/remote config in
// effect?" can be asserted via the resulting variant for any user.
const remoteConfig: RemoteConfig = {
  experiments: {
    exp: {
      key: 'exp',
      seed: 'exp-seed',
      enabled: true,
      controlVariant: 'control',
      variants: [
        { key: 'control', weight: 0 },
        { key: 'treatment', weight: 100 },
      ],
    },
  },
  flags: {},
}

describe('remote.ts unit', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolveReconnectOptions applies defaults and overrides', () => {
    expect(resolveReconnectOptions()).toEqual({ initialDelayMs: 1000, maxDelayMs: 30_000, jitter: true, enabled: true })
    expect(resolveReconnectOptions({ initialDelayMs: 50, enabled: false })).toMatchObject({ initialDelayMs: 50, enabled: false })
  })

  it('computeBackoffDelay grows exponentially and caps at maxDelayMs', () => {
    const options = { initialDelayMs: 100, maxDelayMs: 1000, jitter: false }
    expect(computeBackoffDelay(0, options)).toBe(100)
    expect(computeBackoffDelay(1, options)).toBe(200)
    expect(computeBackoffDelay(2, options)).toBe(400)
    expect(computeBackoffDelay(10, options)).toBe(1000)
  })

  it('computeBackoffDelay applies full jitter in [base/2, base]', () => {
    const options = { initialDelayMs: 100, maxDelayMs: 1000, jitter: true }
    expect(computeBackoffDelay(0, options, () => 0)).toBe(50)
    expect(computeBackoffDelay(0, options, () => 1)).toBe(100)
  })

  it('WebSocket transport reports AB_E_TRANSPORT_FAILED when WebSocket is unavailable', () => {
    vi.stubGlobal('WebSocket', undefined)
    const transport = createWebSocketTransport('ws://localhost/config')
    let captured: unknown
    transport.connect({ onOpen: () => {}, onMessage: () => {}, onError: (error) => { captured = error }, onClose: () => {} })
    expect((captured as { code?: string } | undefined)?.code).toBe(AbErrorCode.TransportFailed)
  })
})

function makeRemoteClient(transport: ReturnType<typeof createMockRemoteTransport>, overrides: Partial<CreateAbClientOptions> = {}) {
  const events: AbSdkEvent[] = []
  const client = createAbClient({
    appKey: 'remote',
    persistence: 'memory',
    defaultConfig: baseConfig,
    remote: { transport, reconnect: { enabled: false } },
    onEvent: (event) => events.push(event),
    ...overrides,
  })
  return { client, events }
}

describe('remote config readiness & application', () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
  })

  it('with a remote, stays isReady=false after init until the first valid config.replace', () => {
    const transport = createMockRemoteTransport()
    const { client } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    expect(client.getDebugState().isReady).toBe(false)
    expect(client.getAssignment('exp').isReady).toBe(false)

    transport.pushConfig(remoteConfig, 1)
    expect(client.getDebugState().isReady).toBe(true)
    client.destroy()
  })

  it('ready() resolves after the first config.replace (with a remote)', async () => {
    const transport = createMockRemoteTransport()
    const { client } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    let resolved = false
    const pending = client.ready().then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false) // not yet — the remote has not synced
    transport.pushConfig(remoteConfig, 1)
    await pending
    expect(resolved).toBe(true)
    client.destroy()
  })

  it('ready() resolves once a no-remote client is initialized', async () => {
    const client = createAbClient({ appKey: 'noremote-ready', persistence: 'memory', defaultConfig: baseConfig })
    client.initializeUser({ id: 'user-1' })
    await expect(client.ready()).resolves.toBeUndefined()
    client.destroy()
  })

  it('uses the cached bootstrap config before live sync', () => {
    globalThis.localStorage.setItem(
      'abtest:boot',
      JSON.stringify({ schemaVersion: 1, assignments: {}, cachedConfig: remoteConfig, cachedConfigVersion: 5 }),
    )
    const transport = createMockRemoteTransport()
    const client = createAbClient({
      appKey: 'boot',
      persistence: 'local',
      defaultConfig: baseConfig,
      remote: { transport, reconnect: { enabled: false } },
    })
    client.initializeUser({ id: 'user-1' })
    expect(client.getDebugState().isReady).toBe(false)
    // Evaluates against the cached bootstrap (all-treatment), not the default (50/50).
    expect(client.getVariant('exp')).toBe('treatment')
    client.destroy()
  })

  it('becomes ready when the server confirms an already-cached version (no re-apply)', () => {
    globalThis.localStorage.setItem(
      'abtest:resync',
      JSON.stringify({ schemaVersion: 1, assignments: {}, cachedConfig: remoteConfig, cachedConfigVersion: 1 }),
    )
    const transport = createMockRemoteTransport()
    const events: AbSdkEvent[] = []
    const client = createAbClient({
      appKey: 'resync',
      persistence: 'local',
      defaultConfig: baseConfig,
      remote: { transport, reconnect: { enabled: false } },
      onEvent: (event) => events.push(event),
    })
    client.initializeUser({ id: 'user-1' })
    expect(client.getDebugState().isReady).toBe(false) // not yet heard from the server

    // The server's connect snapshot is the same version we already cached.
    transport.pushConfig(remoteConfig, 1)

    expect(events.some((event) => event.code === AbErrorCode.RemoteStale)).toBe(true) // nothing re-applied
    expect(client.getDebugState().isReady).toBe(true) // but we are confirmed in sync now
    client.destroy()
  })

  it('first valid config.replace applies, persists, and emits ready + config.updated', () => {
    globalThis.localStorage.clear()
    const transport = createMockRemoteTransport()
    const events: AbSdkEvent[] = []
    const client = createAbClient({
      appKey: 'apply',
      persistence: 'local',
      defaultConfig: baseConfig,
      remote: { transport, reconnect: { enabled: false } },
      onEvent: (event) => events.push(event),
    })
    client.initializeUser({ id: 'user-1' })
    transport.pushConfig(remoteConfig, 3)

    expect(client.getDebugState().isReady).toBe(true)
    expect(events.some((event) => event.type === 'ready')).toBe(true)
    expect(events.some((event) => event.type === 'config.updated')).toBe(true)

    const raw = JSON.parse(globalThis.localStorage.getItem('abtest:apply') ?? '{}') as {
      cachedConfigVersion?: number
      cachedConfig?: unknown
    }
    expect(raw.cachedConfigVersion).toBe(3)
    expect(raw.cachedConfig).toBeDefined()
    client.destroy()
  })

  it('applies a first remote config at version 0', () => {
    const transport = createMockRemoteTransport()
    const { client } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })

    transport.pushConfig(remoteConfig, 0)

    expect(client.getDebugState().isReady).toBe(true)
    expect(client.getVariant('exp')).toBe('treatment')
    client.destroy()
  })

  it('ignores a stale or repeated version and emits AB_E_REMOTE_STALE', () => {
    const transport = createMockRemoteTransport()
    const { client, events } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    transport.pushConfig(remoteConfig, 5)
    transport.pushConfig(baseConfig, 5) // same version → stale
    transport.pushConfig(baseConfig, 3) // lower version → stale

    expect(events.filter((event) => event.code === AbErrorCode.RemoteStale).length).toBeGreaterThanOrEqual(2)
    // The all-treatment config (version 5) is still in effect.
    expect(client.getVariant('exp')).toBe('treatment')
    client.destroy()
  })

  it('ignores invalid remote config and keeps the last-good config', () => {
    const transport = createMockRemoteTransport()
    const { client, events } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    transport.pushConfig(remoteConfig, 1)
    const before = client.getVariant('exp')

    transport.pushRaw({ type: 'config.replace', version: 2, config: { experiments: { exp: { key: 'exp' } }, flags: {} } })
    expect(events.some((event) => event.code === AbErrorCode.ConfigInvalid)).toBe(true)
    expect(client.getVariant('exp')).toBe(before)
    client.destroy()
  })

  it('ignores malformed messages', () => {
    const transport = createMockRemoteTransport()
    const { client, events } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    transport.pushRaw({ nonsense: true })
    transport.pushRaw('a string')
    expect(events.some((event) => event.code === AbErrorCode.ConfigInvalid)).toBe(true)
    client.destroy()
  })

  it('rejects non-finite or unsafe remote versions before touching lastAppliedVersion', () => {
    const transport = createMockRemoteTransport()
    const { client, events } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    transport.pushRaw({ type: 'config.replace', version: Number.NaN, config: remoteConfig })
    transport.pushRaw({ type: 'config.replace', version: Number.POSITIVE_INFINITY, config: remoteConfig })
    transport.pushRaw({ type: 'config.replace', version: 1.5, config: remoteConfig })
    expect(events.filter((event) => event.code === AbErrorCode.ConfigInvalid).length).toBeGreaterThanOrEqual(3)

    transport.pushConfig(remoteConfig, 1)
    expect(client.getDebugState().isReady).toBe(true)
    expect(client.getVariant('exp')).toBe('treatment')
    client.destroy()
  })

  it('a remote update notifies subscribers', () => {
    const transport = createMockRemoteTransport()
    const { client } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    let notified = 0
    client.subscribe(() => {
      notified++
    })
    transport.pushConfig(remoteConfig, 1)
    expect(notified).toBeGreaterThan(0)
    client.destroy()
  })

  it('an admin override survives a remote update', () => {
    const transport = createMockRemoteTransport()
    const { client } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    client.setAdminOverride({ experiments: { exp: { enabled: false } } })
    transport.pushConfig(remoteConfig, 1)
    expect(client.getAssignment('exp').reason).toBe('EXPERIMENT_DISABLED')
    client.destroy()
  })

  it('a forced override still wins over remote config', () => {
    const transport = createMockRemoteTransport()
    const { client } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    client.setForcedOverride('exp', 'forced-variant')
    transport.pushConfig(remoteConfig, 1)
    const assignment = client.getAssignment('exp')
    expect(assignment.reason).toBe('FORCED_OVERRIDE')
    expect(assignment.variant).toBe('forced-variant')
    client.destroy()
  })

  it('a removed experiment clears its assignment once live/ready', () => {
    const transport = createMockRemoteTransport()
    const { client } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    transport.pushConfig(baseConfig, 1) // ready now, exp present
    client.getAssignment('exp')
    expect(client.getDebugState().assignments['exp']).toBeDefined()

    transport.pushConfig({ experiments: {}, flags: {} }, 2) // exp removed
    expect(client.getAssignment('exp').reason).toBe('EXPERIMENT_NOT_FOUND')
    expect(client.getDebugState().assignments['exp']).toBeUndefined()
    client.destroy()
  })

  it('does not clear a stored assignment while still bootstrapping (not ready)', () => {
    globalThis.localStorage.setItem(
      'abtest:notready',
      JSON.stringify({
        schemaVersion: 1,
        assignments: {
          exp: {
            experimentKey: 'exp',
            variantKey: 'control',
            bucketingId: 'user-1',
            hashVersion: 'murmur3_x86_32.v1',
            seed: 'exp-seed',
            assignedAt: 't',
            assignedBy: 'computed',
          },
        },
        cachedConfig: { experiments: {}, flags: {} },
        cachedConfigVersion: 1,
      }),
    )
    const transport = createMockRemoteTransport()
    const client = createAbClient({
      appKey: 'notready',
      persistence: 'local',
      defaultConfig: baseConfig,
      remote: { transport, reconnect: { enabled: false } },
    })
    client.initializeUser({ id: 'user-1' })
    expect(client.getDebugState().isReady).toBe(false)
    expect(client.getAssignment('exp').reason).toBe('EXPERIMENT_NOT_FOUND')
    expect(client.getDebugState().assignments['exp']).toBeDefined() // not cleared — still bootstrapping
    client.destroy()
  })
})

describe('remote transport — connection & reconnect', () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('emits the full connection-status lifecycle', () => {
    const transport = createMockRemoteTransport()
    const events: AbSdkEvent[] = []
    const client = createAbClient({
      appKey: 'status',
      persistence: 'memory',
      defaultConfig: baseConfig,
      remote: { transport, reconnect: { initialDelayMs: 100, jitter: false } },
      onEvent: (event) => events.push(event),
    })
    client.initializeUser({ id: 'user-1' })
    transport.simulateOpen()
    transport.simulateError()
    transport.simulateClose()

    const statuses = events.filter((event) => event.type === 'connection.status').map((event) => event.context?.['status'])
    for (const status of ['connecting', 'open', 'error', 'closed', 'reconnecting']) {
      expect(statuses).toContain(status)
    }
    client.destroy()
  })

  it('transport error emits AB_E_TRANSPORT_FAILED without crashing', () => {
    const transport = createMockRemoteTransport()
    const { client, events } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    expect(() => transport.simulateError(new Error('socket boom'))).not.toThrow()
    expect(events.some((event) => event.code === AbErrorCode.TransportFailed)).toBe(true)
    client.destroy()
  })

  it('WebSocket unavailable degrades to bootstrap readiness with AB_E_TRANSPORT_FAILED', () => {
    vi.stubGlobal('WebSocket', undefined)
    const events: AbSdkEvent[] = []
    const client = createAbClient({
      appKey: 'no-ws',
      persistence: 'memory',
      defaultConfig: baseConfig,
      remote: { url: 'ws://localhost/config' },
      onEvent: (event) => events.push(event),
    })
    client.initializeUser({ id: 'user-1' })
    expect(client.getDebugState().isReady).toBe(true)
    expect(events.some((event) => event.code === AbErrorCode.TransportFailed)).toBe(true)
    client.destroy()
  })

  it('schedules a reconnect after close and reconnects when the timer fires', () => {
    vi.useFakeTimers()
    const transport = createMockRemoteTransport()
    const client = createAbClient({
      appKey: 'recon',
      persistence: 'memory',
      defaultConfig: baseConfig,
      remote: { transport, reconnect: { initialDelayMs: 100, jitter: false } },
    })
    client.initializeUser({ id: 'user-1' })
    expect(transport.connectCount).toBe(1)
    transport.simulateOpen()
    transport.simulateClose()
    expect(transport.connectCount).toBe(1)
    vi.advanceTimersByTime(100)
    expect(transport.connectCount).toBe(2)
    client.destroy()
    vi.useRealTimers()
  })

  it('schedules a reconnect after transport error even when close is not emitted', () => {
    vi.useFakeTimers()
    const transport = createMockRemoteTransport()
    const client = createAbClient({
      appKey: 'recon-error',
      persistence: 'memory',
      defaultConfig: baseConfig,
      remote: { transport, reconnect: { initialDelayMs: 100, jitter: false } },
    })
    client.initializeUser({ id: 'user-1' })
    expect(transport.connectCount).toBe(1)
    transport.simulateError(new Error('error without close'))
    vi.advanceTimersByTime(100)
    expect(transport.connectCount).toBe(2)
    client.destroy()
    vi.useRealTimers()
  })

  it('reset() preserves live remote readiness after the stream already synced', () => {
    const transport = createMockRemoteTransport()
    const { client } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    transport.pushConfig(remoteConfig, 1)
    expect(client.getDebugState().isReady).toBe(true)

    client.reset()
    client.initializeUser({ id: 'user-1' })
    expect(client.getDebugState().isReady).toBe(true)
    expect(client.getVariant('exp')).toBe('treatment')
    client.destroy()
  })

  it('reset() before the first remote sync still waits for config.replace', () => {
    const transport = createMockRemoteTransport()
    const { client } = makeRemoteClient(transport)
    client.initializeUser({ id: 'user-1' })
    expect(client.getDebugState().isReady).toBe(false)

    client.reset()
    client.initializeUser({ id: 'user-1' })
    expect(client.getDebugState().isReady).toBe(false)

    transport.pushConfig(remoteConfig, 1)
    expect(client.getDebugState().isReady).toBe(true)
    client.destroy()
  })

  it('destroy() closes the transport and cancels a pending reconnect', () => {
    vi.useFakeTimers()
    const transport = createMockRemoteTransport()
    const closeSpy = vi.spyOn(transport, 'close')
    const client = createAbClient({
      appKey: 'destroy-recon',
      persistence: 'memory',
      defaultConfig: baseConfig,
      remote: { transport, reconnect: { initialDelayMs: 100, jitter: false } },
    })
    client.initializeUser({ id: 'user-1' })
    transport.simulateClose()
    client.destroy()
    expect(closeSpy).toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(transport.connectCount).toBe(1) // no reconnect after destroy
    vi.useRealTimers()
  })
})

describe('remote update cross-tab sync', () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
    vi.stubGlobal('BroadcastChannel', undefined) // isolate the storage-event path
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a remote update in one tab propagates the cached config to a second tab', () => {
    const transport = createMockRemoteTransport()
    const sharedOpts: CreateAbClientOptions = { appKey: 'xtab-remote', persistence: 'local', defaultConfig: baseConfig }
    const a = createAbClient({ ...sharedOpts, remote: { transport, reconnect: { enabled: false } } })
    const b = createAbClient({ ...sharedOpts })
    a.initializeUser({ id: 'user-1' })
    b.initializeUser({ id: 'user-1' })

    transport.pushConfig(remoteConfig, 2) // A applies + persists + notifies

    globalThis.dispatchEvent(new StorageEvent('storage', { key: 'abtest:xtab-remote' }))

    // B now evaluates against the synced (all-treatment) config.
    expect(b.getVariant('exp')).toBe('treatment')
    a.destroy()
    b.destroy()
  })

  it('a remote cache sync can mark a remote-configured second tab ready', () => {
    const transportA = createMockRemoteTransport()
    const transportB = createMockRemoteTransport()
    const sharedOpts: CreateAbClientOptions = { appKey: 'xtab-ready', persistence: 'local', defaultConfig: baseConfig }
    const a = createAbClient({ ...sharedOpts, remote: { transport: transportA, reconnect: { enabled: false } } })
    const b = createAbClient({ ...sharedOpts, remote: { transport: transportB, reconnect: { enabled: false } } })
    a.initializeUser({ id: 'user-1' })
    b.initializeUser({ id: 'user-1' })
    expect(b.getDebugState().isReady).toBe(false)

    transportA.pushConfig(remoteConfig, 2)
    globalThis.dispatchEvent(new StorageEvent('storage', { key: 'abtest:xtab-ready' }))

    expect(b.getDebugState().isReady).toBe(true)
    expect(b.getVariant('exp')).toBe('treatment')
    a.destroy()
    b.destroy()
  })

  it('cross-tab assignment sync ignores assignments from a different user session', () => {
    const sharedOpts: CreateAbClientOptions = { appKey: 'xtab-users', persistence: 'local', defaultConfig: baseConfig }
    const a = createAbClient(sharedOpts)
    const b = createAbClient(sharedOpts)
    a.initializeUser({ id: 'user-a' })
    b.initializeUser({ id: 'user-b' })
    a.getAssignment('exp')

    globalThis.dispatchEvent(new StorageEvent('storage', { key: 'abtest:xtab-users' }))

    expect(b.getDebugState().assignments['exp']).toBeUndefined()
    a.destroy()
    b.destroy()
  })
})
