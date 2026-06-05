import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAbClient } from '../src/core/abTestingClient'
import { createCrossTabSync } from '../src/core/storageSync'
import type { CreateAbClientOptions, ExperimentConfig, RemoteConfig } from '../src/core/types'

// A deterministic, in-process BroadcastChannel mock that delivers to other
// instances sharing a name (but never echoes to the sender).
class MockBroadcastChannel {
  static channels: MockBroadcastChannel[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(public readonly name: string) {
    MockBroadcastChannel.channels.push(this)
  }

  postMessage(data: unknown): void {
    for (const channel of MockBroadcastChannel.channels) {
      if (channel !== this && channel.name === this.name) channel.onmessage?.({ data })
    }
  }

  close(): void {
    MockBroadcastChannel.channels = MockBroadcastChannel.channels.filter((channel) => channel !== this)
  }
}

describe('createCrossTabSync — storage events', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fires onRemoteChange for a matching storage key', () => {
    let calls = 0
    const sync = createCrossTabSync('xs', () => {
      calls++
    })
    globalThis.dispatchEvent(new StorageEvent('storage', { key: 'abtest:xs' }))
    expect(calls).toBe(1)
    sync.close()
  })

  it('ignores storage events for unrelated keys', () => {
    let calls = 0
    const sync = createCrossTabSync('xs', () => {
      calls++
    })
    globalThis.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }))
    expect(calls).toBe(0)
    sync.close()
  })

  it('stops firing after close()', () => {
    let calls = 0
    const sync = createCrossTabSync('xs', () => {
      calls++
    })
    sync.close()
    globalThis.dispatchEvent(new StorageEvent('storage', { key: 'abtest:xs' }))
    expect(calls).toBe(0)
  })
})

describe('createCrossTabSync — BroadcastChannel (mocked)', () => {
  beforeEach(() => {
    MockBroadcastChannel.channels = []
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fires onRemoteChange when another channel posts', () => {
    let calls = 0
    const sync = createCrossTabSync('bc', () => {
      calls++
    })
    const other = new MockBroadcastChannel('abtest-sync:bc')
    other.postMessage({ type: 'sync' })
    expect(calls).toBe(1)
    sync.close()
  })

  it('notify() reaches other tabs but never echoes to itself', () => {
    let selfCalls = 0
    const sync = createCrossTabSync('bc', () => {
      selfCalls++
    })
    let otherCalls = 0
    const other = new MockBroadcastChannel('abtest-sync:bc')
    other.onmessage = () => {
      otherCalls++
    }
    sync.notify()
    expect(otherCalls).toBe(1)
    expect(selfCalls).toBe(0)
    sync.close()
  })
})

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

describe('cross-tab sync via two clients (storage-event path)', () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
    // Isolate the storage-event path so the assertions are deterministic.
    vi.stubGlobal('BroadcastChannel', undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a storage event makes a second client pick up the first client’s assignment', () => {
    const opts: CreateAbClientOptions = { appKey: 'xtab', persistence: 'local', defaultConfig: config }
    const a = createAbClient(opts)
    const b = createAbClient(opts)
    a.initializeUser({ id: 'user-1' })
    b.initializeUser({ id: 'user-1' })

    const first = a.getAssignment('exp')
    expect(b.getDebugState().assignments['exp']).toBeUndefined()

    globalThis.dispatchEvent(new StorageEvent('storage', { key: 'abtest:xtab' }))

    expect(b.getDebugState().assignments['exp']).toBeDefined()
    expect(b.getAssignment('exp').reason).toBe('STICKY')
    expect(b.getAssignment('exp').variant).toBe(first.variant)

    a.destroy()
    b.destroy()
  })
})

describe('cross-tab sync — anti-loop', () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
    MockBroadcastChannel.channels = []
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a synced client re-reads memory only and does not echo a notify back', () => {
    const a = createAbClient({ appKey: 'echo', persistence: 'local', defaultConfig: config })
    a.initializeUser({ id: 'user-1' })
    a.getAssignment('exp')

    const external = new MockBroadcastChannel('abtest-sync:echo')
    let echoed = 0
    external.onmessage = () => {
      echoed++
    }

    // External tab signals a change → client A re-reads. It must NOT post back.
    external.postMessage({ type: 'sync' })
    expect(echoed).toBe(0)

    a.destroy()
  })
})
