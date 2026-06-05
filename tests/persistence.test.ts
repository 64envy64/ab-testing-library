import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AbErrorCode, type AbIssue } from '../src/core/errors'
import {
  createMemoryStorage,
  createPersistenceStore,
  emptyPersistedState,
  SCHEMA_VERSION,
} from '../src/core/persistence'
import type { PersistedAssignment, PersistedState } from '../src/core/types'

const sampleAssignment: PersistedAssignment = {
  experimentKey: 'exp',
  variantKey: 'a',
  bucketingId: 'u1',
  hashVersion: 'h',
  seed: 's',
  assignedAt: 't',
  assignedBy: 'computed',
}

const noop = (): void => {}

describe('createMemoryStorage', () => {
  it('round-trips get/set/remove', () => {
    const storage = createMemoryStorage()
    expect(storage.getItem('k')).toBeNull()
    storage.setItem('k', 'v')
    expect(storage.getItem('k')).toBe('v')
    storage.removeItem('k')
    expect(storage.getItem('k')).toBeNull()
  })
})

describe('createPersistenceStore (memory mode)', () => {
  it('returns empty state when nothing is stored', () => {
    const store = createPersistenceStore('app', 'memory', noop)
    expect(store.load()).toEqual(emptyPersistedState())
  })

  it('saves and loads a round-trip on the same instance', () => {
    const store = createPersistenceStore('app', 'memory', noop)
    const state: PersistedState = {
      schemaVersion: SCHEMA_VERSION,
      user: { id: 'u1' },
      assignments: { exp: sampleAssignment },
    }
    store.save(state)
    expect(store.load()).toEqual(state)
  })

  it('strips legacy persisted traits when loading a user', () => {
    globalThis.localStorage.setItem(
      'abtest:legacy-traits',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, user: { id: 'u1', traits: { email: 'secret@example.com' } }, assignments: {} }),
    )
    const store = createPersistenceStore('legacy-traits', 'local', noop)
    expect(store.load().user).toEqual({ id: 'u1' })
    expect(globalThis.localStorage.getItem('abtest:legacy-traits') ?? '').not.toContain('secret@example.com')
  })

  it('round-trips cachedConfig and cachedConfigVersion (remote bootstrap)', () => {
    const store = createPersistenceStore('cfg', 'memory', noop)
    const state: PersistedState = {
      schemaVersion: SCHEMA_VERSION,
      assignments: {},
      cachedConfig: { experiments: {}, flags: {} },
      cachedConfigVersion: 7,
    }
    store.save(state)
    expect(store.load()).toEqual(state)
  })
})

describe('createPersistenceStore (local mode) — recovery & namespacing', () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('discards corrupted JSON and reports a StorageCorrupt issue', () => {
    globalThis.localStorage.setItem('abtest:recover', '{not valid json')
    const issues: AbIssue[] = []
    const store = createPersistenceStore('recover', 'local', (issue) => issues.push(issue))
    expect(store.load()).toEqual(emptyPersistedState())
    expect(issues.some((issue) => issue.code === AbErrorCode.StorageCorrupt)).toBe(true)
    expect(globalThis.localStorage.getItem('abtest:recover')).toBeNull()
  })

  it('safe-discards an unsupported schemaVersion', () => {
    globalThis.localStorage.setItem('abtest:schema', JSON.stringify({ schemaVersion: 999, assignments: {} }))
    const issues: AbIssue[] = []
    const store = createPersistenceStore('schema', 'local', (issue) => issues.push(issue))
    expect(store.load()).toEqual(emptyPersistedState())
    expect(issues.some((issue) => issue.message.includes('schemaVersion'))).toBe(true)
  })

  it('discards a non-object payload', () => {
    globalThis.localStorage.setItem('abtest:weird', '42')
    const store = createPersistenceStore('weird', 'local', noop)
    expect(store.load()).toEqual(emptyPersistedState())
  })

  it('drops malformed assignment records inside an otherwise valid payload', () => {
    globalThis.localStorage.setItem(
      'abtest:bad-assignment',
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        user: { id: 'u1' },
        assignments: {
          exp: {
            experimentKey: 'exp',
            variantKey: 'control',
            hashVersion: 'h',
            seed: 's',
            assignedAt: 't',
            assignedBy: 'computed',
          },
        },
      }),
    )
    const issues: AbIssue[] = []
    const store = createPersistenceStore('bad-assignment', 'local', (issue) => issues.push(issue))
    expect(store.load().assignments).toEqual({})
    expect(issues.some((issue) => issue.message.includes('Invalid persisted assignment'))).toBe(true)
    expect(globalThis.localStorage.getItem('abtest:bad-assignment')).not.toContain('"exp"')
  })

  it('namespaces storage keys by appKey', () => {
    const a = createPersistenceStore('app-a', 'local', noop)
    const b = createPersistenceStore('app-b', 'local', noop)
    a.save({ schemaVersion: SCHEMA_VERSION, assignments: { x: sampleAssignment } })
    expect(Object.keys(b.load().assignments)).toEqual([])
    expect(globalThis.localStorage.getItem('abtest:app-a')).not.toBeNull()
    expect(globalThis.localStorage.getItem('abtest:app-b')).toBeNull()
  })

  it('degrades on a write failure (quota) without throwing', () => {
    const issues: AbIssue[] = []
    const memory = new Map<string, string>()
    const state: PersistedState = {
      schemaVersion: SCHEMA_VERSION,
      user: { id: 'quota-user' },
      assignments: { exp: sampleAssignment },
    }
    // Probe key (`__abtest_probe__`) succeeds so the adapter selects localStorage;
    // the real namespaced write then fails, simulating a quota error mid-session.
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key.startsWith('abtest:')) throw new Error('QuotaExceededError')
        memory.set(key, value)
      },
      removeItem: (key: string) => {
        memory.delete(key)
      },
      clear: () => {
        memory.clear()
      },
    })
    const store = createPersistenceStore('quota', 'local', (issue) => issues.push(issue))
    expect(() => store.save(state)).not.toThrow()
    expect(store.load()).toEqual(state)
    expect(issues.some((issue) => issue.code === AbErrorCode.StorageCorrupt)).toBe(true)
  })
})
