/**
 * Storage adapter + persistence store (docs/BEHAVIOR_CONTRACT.md "Persistence
 * Contract"). Every storage access is guarded; localStorage that is unavailable,
 * corrupt, or quota-limited transparently degrades to in-memory storage. Storage
 * keys are namespaced by `appKey`, and the payload is versioned with
 * `schemaVersion` — an unsupported version is safely discarded.
 */
import { AbErrorCode, abIssue, type AbIssue } from './errors'
import type {
  PersistedAssignment,
  PersistedState,
  PersistedUserData,
  PersistenceMode,
  RemoteConfig,
} from './types'

export const SCHEMA_VERSION = 1

export function emptyPersistedState(): PersistedState {
  return { schemaVersion: SCHEMA_VERSION, assignments: {} }
}

export interface StorageAdapter {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function createMemoryStorage(): StorageAdapter {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

function probeLocalStorage(): Storage | null {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage
    if (!candidate) return null
    const probeKey = '__abtest_probe__'
    candidate.setItem(probeKey, '1')
    candidate.removeItem(probeKey)
    return candidate
  } catch {
    return null
  }
}

function createLocalStorageAdapter(storage: Storage): StorageAdapter {
  return {
    getItem: (key) => {
      try {
        return storage.getItem(key)
      } catch {
        return null
      }
    },
    // Writes may throw on quota; the caller (save) catches and degrades.
    setItem: (key, value) => {
      storage.setItem(key, value)
    },
    removeItem: (key) => {
      try {
        storage.removeItem(key)
      } catch {
        /* ignore */
      }
    },
  }
}

export interface PersistenceStore {
  load(): PersistedState
  save(state: PersistedState): void
  remove(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isAssignedBy(value: unknown): value is PersistedAssignment['assignedBy'] {
  return value === 'computed' || value === 'server'
}

function isPersistedAssignment(value: unknown, mapKey: string): value is PersistedAssignment {
  if (!isRecord(value)) return false
  return (
    value.experimentKey === mapKey &&
    isString(value.variantKey) &&
    isString(value.bucketingId) &&
    isString(value.hashVersion) &&
    isString(value.seed) &&
    isString(value.assignedAt) &&
    isAssignedBy(value.assignedBy)
  )
}

function readPersistedUser(value: unknown): PersistedUserData | undefined {
  if (!isRecord(value)) return undefined
  const user: PersistedUserData = {}
  if (value.id !== undefined) {
    if (!isString(value.id)) return undefined
    user.id = value.id
  }
  if (value.anonymousId !== undefined) {
    if (!isString(value.anonymousId)) return undefined
    user.anonymousId = value.anonymousId
  }
  return Object.keys(user).length > 0 ? user : undefined
}

export function createPersistenceStore(
  appKey: string,
  mode: PersistenceMode,
  onIssue: (issue: AbIssue) => void,
): PersistenceStore {
  const storageKey = `abtest:${appKey}`

  let adapter: StorageAdapter
  if (mode === 'memory') {
    adapter = createMemoryStorage()
  } else {
    const local = probeLocalStorage()
    // Unavailable localStorage (SSR / Node / disabled) is a normal, silent fallback;
    // only genuine corruption and write failures are surfaced as issues.
    adapter = local ? createLocalStorageAdapter(local) : createMemoryStorage()
  }

  function discard(message: string): PersistedState {
    onIssue(abIssue(AbErrorCode.StorageCorrupt, `${message}; discarding persisted state`, { appKey }))
    try {
      adapter.removeItem(storageKey)
    } catch {
      /* ignore */
    }
    return emptyPersistedState()
  }

  function reportCorrupt(message: string, context?: Record<string, unknown>): void {
    onIssue(abIssue(AbErrorCode.StorageCorrupt, message, { appKey, ...context }))
  }

  function cleanAssignments(input: unknown): {
    assignments: Record<string, PersistedAssignment>
    cleaned: boolean
  } {
    if (input === undefined) return { assignments: {}, cleaned: false }
    if (!isRecord(input)) {
      reportCorrupt('Persisted assignments had an unexpected shape; dropping assignments')
      return { assignments: {}, cleaned: true }
    }

    const assignments: Record<string, PersistedAssignment> = {}
    let cleaned = false
    for (const [key, value] of Object.entries(input)) {
      if (isPersistedAssignment(value, key)) {
        assignments[key] = value
      } else {
        cleaned = true
        reportCorrupt('Invalid persisted assignment; dropping assignment', { experimentKey: key })
      }
    }
    return { assignments, cleaned }
  }

  function persistCleaned(state: PersistedState): void {
    try {
      adapter.setItem(storageKey, JSON.stringify(state))
    } catch {
      /* best-effort cleanup only */
    }
  }

  function load(): PersistedState {
    const raw = adapter.getItem(storageKey)
    if (raw === null) return emptyPersistedState()

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return discard('Corrupted JSON in persisted state')
    }

    if (!isRecord(parsed) || typeof parsed.schemaVersion !== 'number') {
      return discard('Persisted state has an unexpected shape')
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      return discard(`Unsupported persisted schemaVersion ${String(parsed.schemaVersion)}`)
    }

    const user = parsed.user === undefined ? undefined : readPersistedUser(parsed.user)
    const userCleaned =
      parsed.user !== undefined &&
      (user === undefined || JSON.stringify(user) !== JSON.stringify(parsed.user))
    if (userCleaned) reportCorrupt('Persisted user had an unexpected shape; dropping user')

    const cleanedAssignments = cleanAssignments(parsed.assignments)
    const state: PersistedState = {
      schemaVersion: SCHEMA_VERSION,
      user,
      assignments: cleanedAssignments.assignments,
      cachedConfig: isRecord(parsed.cachedConfig) ? (parsed.cachedConfig as unknown as RemoteConfig) : undefined,
      cachedConfigVersion:
        typeof parsed.cachedConfigVersion === 'number' ? parsed.cachedConfigVersion : undefined,
    }

    if (userCleaned || cleanedAssignments.cleaned) persistCleaned(state)
    return state
  }

  function save(state: PersistedState): void {
    let serialized: string
    try {
      serialized = JSON.stringify(state)
    } catch (error) {
      onIssue(
        abIssue(AbErrorCode.StorageCorrupt, 'Failed to serialize persisted state; skipping write', {
          appKey,
          error: String(error),
        }),
      )
      return
    }

    try {
      adapter.setItem(storageKey, serialized)
    } catch (error) {
      onIssue(
        abIssue(AbErrorCode.StorageCorrupt, 'Failed to persist state (storage quota or write error)', {
          appKey,
          error: String(error),
        }),
      )
      adapter = createMemoryStorage()
      adapter.setItem(storageKey, serialized)
    }
  }

  function remove(): void {
    try {
      adapter.removeItem(storageKey)
    } catch {
      /* ignore */
    }
  }

  return { load, save, remove }
}
