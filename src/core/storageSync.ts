/**
 * Cross-tab synchronization (docs/BEHAVIOR_CONTRACT.md "Cross-Tab Contract").
 *
 * Storage events are the required path; `BroadcastChannel` is the preferred, faster
 * path when available. Both merely signal "another tab changed the persisted
 * state" — the client responds by re-reading storage into memory WITHOUT writing
 * back, which prevents echo loops. Safe in non-DOM environments (becomes a no-op).
 */
type GlobalWithEvents = typeof globalThis & {
  addEventListener?: (type: string, listener: (event: Event) => void) => void
  removeEventListener?: (type: string, listener: (event: Event) => void) => void
  BroadcastChannel?: typeof BroadcastChannel
}

export interface CrossTabSync {
  /** Tell other tabs this tab changed the persisted state (BroadcastChannel ping). */
  notify(): void
  close(): void
}

export function createCrossTabSync(appKey: string, onRemoteChange: () => void): CrossTabSync {
  const env = globalThis as GlobalWithEvents
  const storageKey = `abtest:${appKey}`
  const channelName = `abtest-sync:${appKey}`

  let channel: BroadcastChannel | null = null
  if (typeof env.BroadcastChannel === 'function') {
    try {
      const broadcast = new env.BroadcastChannel(channelName)
      broadcast.onmessage = () => {
        onRemoteChange()
      }
      // Don't keep a Node process alive for an open channel (no-op in browsers).
      const unref = (broadcast as { unref?: () => void }).unref
      if (typeof unref === 'function') unref.call(broadcast)
      channel = broadcast
    } catch {
      channel = null
    }
  }

  let storageListener: ((event: Event) => void) | null = null
  if (typeof env.addEventListener === 'function') {
    storageListener = (event: Event) => {
      const storageEvent = event as StorageEvent
      // key === null happens on storage.clear(); also react to our namespaced key.
      if (storageEvent.key === null || storageEvent.key === storageKey) onRemoteChange()
    }
    env.addEventListener('storage', storageListener)
  }

  return {
    notify() {
      if (channel !== null) {
        try {
          channel.postMessage({ type: 'sync' })
        } catch {
          /* ignore — sync is best-effort */
        }
      }
    },
    close() {
      if (channel !== null) {
        try {
          channel.close()
        } catch {
          /* ignore */
        }
        channel = null
      }
      if (storageListener !== null && typeof env.removeEventListener === 'function') {
        env.removeEventListener('storage', storageListener)
        storageListener = null
      }
    },
  }
}
