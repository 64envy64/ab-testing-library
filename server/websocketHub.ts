/**
 * WebSocket hub: tracks connected clients, sends the current full config on connect,
 * and broadcasts `config.replace` on every accepted admin update. A broken client is
 * dropped, never allowed to crash the server. No heartbeat in v1.
 */
import type { WebSocket, WebSocketServer } from 'ws'

import type { ConfigReplaceMessage } from '../src/core/types'
import type { ConfigSnapshot } from './configStore'

function toMessage(snapshot: ConfigSnapshot): ConfigReplaceMessage {
  return { type: 'config.replace', version: snapshot.version, config: snapshot.config }
}

export class WebSocketHub {
  private readonly clients = new Set<WebSocket>()

  constructor(
    server: WebSocketServer,
    private readonly getSnapshot: () => ConfigSnapshot,
  ) {
    server.on('connection', (socket: WebSocket) => {
      this.clients.add(socket)
      socket.on('close', () => {
        this.clients.delete(socket)
      })
      socket.on('error', () => {
        this.clients.delete(socket)
      })
      // Send the current full config immediately on connect.
      this.sendTo(socket, toMessage(this.getSnapshot()))
    })
  }

  broadcast(snapshot: ConfigSnapshot): void {
    const message = toMessage(snapshot)
    for (const socket of [...this.clients]) this.sendTo(socket, message)
  }

  get clientCount(): number {
    return this.clients.size
  }

  closeAll(): void {
    for (const socket of [...this.clients]) {
      try {
        socket.terminate()
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()
  }

  private sendTo(socket: WebSocket, message: ConfigReplaceMessage): void {
    try {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
    } catch {
      // A broken client must never crash the server.
      this.clients.delete(socket)
    }
  }
}
