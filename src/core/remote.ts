/**
 * Remote config transport v1 (docs/BEHAVIOR_CONTRACT.md "Remote Config Contract").
 *
 * Full-replace only — no patch protocol, gap detection, delta replay, heartbeat or
 * vector clocks. The transport owns a single connection (connect/close); the client
 * orchestrates reconnect (backoff + jitter) so it can derive all connection-status
 * events from the four transport handlers.
 */
import { AbError, AbErrorCode } from './errors'
import type { ReconnectOptions, RemoteConfigTransport, TransportHandlers } from './types'

export interface ResolvedReconnectOptions {
  initialDelayMs: number
  maxDelayMs: number
  jitter: boolean
  enabled: boolean
}

const DEFAULT_RECONNECT: ResolvedReconnectOptions = {
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: true,
  enabled: true,
}

export function resolveReconnectOptions(options?: ReconnectOptions): ResolvedReconnectOptions {
  return {
    initialDelayMs: options?.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
    jitter: options?.jitter ?? DEFAULT_RECONNECT.jitter,
    enabled: options?.enabled ?? DEFAULT_RECONNECT.enabled,
  }
}

/**
 * Exponential backoff with optional "full jitter" (random in [base/2, base]).
 * `random` is injectable for deterministic tests.
 */
export function computeBackoffDelay(
  attempt: number,
  options: Pick<ResolvedReconnectOptions, 'initialDelayMs' | 'maxDelayMs' | 'jitter'>,
  random: () => number = Math.random,
): number {
  const base = Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** Math.max(0, attempt))
  if (!options.jitter) return base
  return Math.round(base / 2 + random() * (base / 2))
}

/**
 * WebSocket transport factory. A single connection per `connect()` call;
 * `connect()` may be called again (the client uses this to reconnect). When
 * WebSocket is unavailable (e.g. SSR/Node), `connect()` reports AB_E_TRANSPORT_FAILED
 * via `onError` instead of throwing.
 */
export function createWebSocketTransport(url: string): RemoteConfigTransport {
  let socket: WebSocket | null = null

  function teardown(): void {
    if (socket !== null) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      socket = null
    }
  }

  return {
    connect(handlers: TransportHandlers): void {
      teardown()
      const WebSocketCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
      if (typeof WebSocketCtor !== 'function') {
        handlers.onError(
          new AbError(AbErrorCode.TransportFailed, 'WebSocket is not available in this environment', { url }),
        )
        return
      }

      let ws: WebSocket
      try {
        ws = new WebSocketCtor(url)
      } catch (error) {
        handlers.onError(error)
        return
      }

      socket = ws
      ws.onopen = () => {
        handlers.onOpen()
      }
      ws.onmessage = (event: MessageEvent) => {
        let parsed: unknown
        try {
          parsed = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        } catch (error) {
          handlers.onError(error)
          return
        }
        handlers.onMessage(parsed)
      }
      ws.onerror = (event: Event) => {
        handlers.onError(event)
      }
      ws.onclose = () => {
        handlers.onClose()
      }
    },
    close(): void {
      teardown()
    },
  }
}
