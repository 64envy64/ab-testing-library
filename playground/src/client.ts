import { type AbClient, type AbSdkEvent, createAbClient } from 'ab-testing-library'

import { APP_KEY, DEFAULT_CONFIG, WS_URL } from './config'

/** A small observable for the live backend connection status (driven by SDK events). */
export interface DemoConnection {
  getStatus(): string
  subscribe(listener: () => void): () => void
}

export type DemoEventKind = 'config' | 'assignment' | 'exposure' | 'connection' | 'user' | 'error'

export interface DemoEvent {
  id: number
  time: string
  kind: DemoEventKind
  text: string
}

/** Capped, newest-first activity feed so real-time / broadcast behaviour is visible in the UI. */
export interface EventLog {
  getEntries(): DemoEvent[]
  subscribe(listener: () => void): () => void
}

const MAX_EVENTS = 40

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString()
}

function describeEvent(event: AbSdkEvent): { kind: DemoEventKind; text: string } | null {
  const ctx = event.context ?? {}
  const str = (value: unknown): string => (value === undefined || value === null ? '' : String(value))
  switch (event.type) {
    case 'connection.status':
      return { kind: 'connection', text: `connection · ${str(ctx['status'])}` }
    case 'config.updated':
      return {
        kind: 'config',
        text: ctx['version'] !== undefined ? `config → v${str(ctx['version'])}` : 'config updated',
      }
    case 'assignment.created':
      return {
        kind: 'assignment',
        text: `assignment · ${str(ctx['experimentKey'])}${ctx['reason'] ? ` (${str(ctx['reason'])})` : ''}`,
      }
    case 'assignment.reset':
      return {
        kind: 'assignment',
        text: `assignment reset${ctx['experimentKey'] ? ` · ${str(ctx['experimentKey'])}` : ''}`,
      }
    case 'user.initialized':
      return { kind: 'user', text: 'user initialized' }
    case 'user.updated':
      return { kind: 'user', text: 'user updated' }
    case 'ready':
      return { kind: 'user', text: 'ready' }
    case 'error': {
      const code = str(event.code)
      // A stale/duplicate config on (re)connect is expected and handled, not a failure.
      if (code === 'AB_E_REMOTE_STALE') return { kind: 'config', text: 'config · in sync (stale ignored)' }
      return { kind: 'error', text: `error · ${code}` }
    }
    default:
      return null
  }
}

function createEventLog(): { log: EventLog; push: (kind: DemoEventKind, text: string, iso: string) => void } {
  let entries: DemoEvent[] = []
  let seq = 0
  const listeners = new Set<() => void>()

  function push(kind: DemoEventKind, text: string, iso: string): void {
    seq += 1
    // New array reference on every push so `useSyncExternalStore` re-renders;
    // the reference is stable between pushes so it never loops.
    entries = [{ id: seq, time: formatTime(iso), kind, text }, ...entries].slice(0, MAX_EVENTS)
    for (const listener of listeners) listener()
  }

  const log: EventLog = {
    getEntries: () => entries,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  return { log, push }
}

/**
 * Create the demo client once (factory-first) together with a connection-status
 * observable and an activity log, both driven by SDK events. Called from `main.tsx`;
 * the app receives them via props so it stays test-friendly (no module-level client).
 */
export function createDemoClient(): { client: AbClient; connection: DemoConnection; eventLog: EventLog } {
  let status = 'connecting'
  const listeners = new Set<() => void>()
  const { log, push } = createEventLog()

  const connection: DemoConnection = {
    getStatus: () => status,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  const client = createAbClient({
    appKey: APP_KEY,
    defaultConfig: DEFAULT_CONFIG,
    persistence: 'local',
    tracking: true,
    remote: { url: WS_URL },
    onExposure: (event) => {
      // In a real app this goes to your analytics sink (Segment/Amplitude/GA).
      console.info('[ab-demo] exposure', event)
      push('exposure', `exposure · ${event.experimentKey} = ${event.variant}`, event.timestamp)
    },
    onEvent: (event) => {
      if (event.type === 'connection.status' && typeof event.context?.['status'] === 'string') {
        status = event.context['status']
        for (const listener of listeners) listener()
      }
      const described = describeEvent(event)
      if (described) push(described.kind, described.text, event.timestamp)
    },
  })

  // Restore the previous session on reload. The SDK rehydrates the last user from
  // localStorage; re-initializing here makes the sticky assignment visible immediately —
  // exactly as a real app would call initializeUser with its authenticated user on load.
  const restored = client.getDebugState()
  if (!restored.initialized && restored.user !== undefined) {
    client.initializeUser(restored.user)
  }

  return { client, connection, eventLog: log }
}
