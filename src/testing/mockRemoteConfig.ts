/**
 * In-memory mock remote-config transport for tests and the admin demo.
 *
 * It implements the same `RemoteConfigTransport` interface as the WebSocket
 * transport, so the client exercises the production code path. The test/admin
 * drives it deterministically: push a `config.replace`, or simulate open / close /
 * error. Nothing happens automatically.
 */
import type {
  ConfigReplaceMessage,
  RemoteConfig,
  RemoteConfigTransport,
  TransportHandlers,
} from '../core/types'

export interface MockRemoteTransport extends RemoteConfigTransport {
  /** Simulate the server pushing a full config replace at a given version. */
  pushConfig(config: RemoteConfig, version: number): void
  /** Send an arbitrary raw inbound message (for malformed-message tests). */
  pushRaw(message: unknown): void
  simulateOpen(): void
  simulateClose(): void
  simulateError(error?: unknown): void
  /** How many times the client has called `connect()` (useful for reconnect assertions). */
  readonly connectCount: number
  /** Whether the transport is currently "open". */
  readonly isOpen: boolean
}

export function createMockRemoteTransport(): MockRemoteTransport {
  let handlers: TransportHandlers | null = null
  let connectCount = 0
  let open = false

  return {
    connect(nextHandlers: TransportHandlers): void {
      handlers = nextHandlers
      connectCount += 1
    },
    close(): void {
      open = false
      handlers = null
    },
    pushConfig(config: RemoteConfig, version: number): void {
      const message: ConfigReplaceMessage = { type: 'config.replace', version, config }
      handlers?.onMessage(message)
    },
    pushRaw(message: unknown): void {
      handlers?.onMessage(message)
    },
    simulateOpen(): void {
      open = true
      handlers?.onOpen()
    },
    simulateClose(): void {
      open = false
      handlers?.onClose()
    },
    simulateError(error?: unknown): void {
      handlers?.onError(error ?? new Error('mock transport error'))
    },
    get connectCount(): number {
      return connectCount
    },
    get isOpen(): boolean {
      return open
    },
  }
}
