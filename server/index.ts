/**
 * Config control plane (docs/BEHAVIOR_CONTRACT.md "Backend Contract").
 *
 *   GET  /health         → { status: "ok" }
 *   GET  /config         → { version, config }            (public, no PII/secrets)
 *   WS   /config/stream  → config.replace on connect + on every accepted update
 *   PUT  /admin/config   → replace full config            (Bearer admin token)
 *
 * In-memory, full-replace only, monotonic version. No DB, RBAC/OIDC, server-side
 * assignment, patch protocol or heartbeat. `createControlPlane()` is exported for
 * tests; running this file directly (`npm run server`) starts it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

import { WebSocketServer } from 'ws'

import { validateRemoteConfig } from '../src/core/config'
import type { RemoteConfig } from '../src/core/types'
import { isAuthorized, resolveAdminToken } from './auth'
import { ConfigStore } from './configStore'
import { parseAdminPayload } from './validation'
import { WebSocketHub } from './websocketHub'

const MAX_BODY_BYTES = 1_000_000

const DEFAULT_CONFIG: RemoteConfig = {
  experiments: {
    'checkout-copy': {
      key: 'checkout-copy',
      seed: 'checkout-copy.v1',
      enabled: true,
      controlVariant: 'control',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'variant-b', weight: 50 },
      ],
    },
  },
  flags: {
    newCheckoutFlow: { key: 'newCheckoutFlow', seed: 'newCheckoutFlow.v1', enabled: true, rollout: 50 },
  },
}

export interface ControlPlaneOptions {
  config?: RemoteConfig
  adminToken?: string
  corsOrigin?: string
}

export interface ControlPlane {
  httpServer: Server
  store: ConfigStore
  hub: WebSocketHub
  listen(port: number): Promise<number>
  close(): Promise<void>
}

interface RequestContext {
  store: ConfigStore
  hub: WebSocketHub
  adminToken: string
  corsOrigin: string
}

export function createControlPlane(options: ControlPlaneOptions = {}): ControlPlane {
  const seed = options.config ?? DEFAULT_CONFIG
  const store = new ConfigStore(validateRemoteConfig(seed).valid ? seed : { experiments: {}, flags: {} }, 1)
  const adminToken = options.adminToken ?? resolveAdminToken().token
  const corsOrigin = options.corsOrigin ?? process.env.AB_CORS_ORIGIN ?? '*'

  const httpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer, path: '/config/stream' })
  wss.on('error', () => {
    /* handled by listen(); keep ws server errors from becoming unhandled events */
  })
  const hub = new WebSocketHub(wss, () => store.snapshot())

  const context: RequestContext = { store, hub, adminToken, corsOrigin }
  httpServer.on('request', (req, res) => {
    handleRequest(req, res, context).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
    })
  })

  return {
    httpServer,
    store,
    hub,
    listen(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          cleanup()
          reject(error)
        }
        const onListening = (): void => {
          cleanup()
          const address = httpServer.address()
          resolve(typeof address === 'object' && address !== null ? address.port : port)
        }
        const cleanup = (): void => {
          httpServer.off('error', onError)
          httpServer.off('listening', onListening)
          wss.off('error', onError)
        }
        httpServer.once('error', onError)
        wss.once('error', onError)
        httpServer.once('listening', onListening)
        httpServer.listen(port)
      })
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        hub.closeAll()
        wss.close(() => {
          httpServer.close((error) => {
            if (error) reject(error)
            else resolve()
          })
        })
      })
    },
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  setCorsHeaders(res, ctx.corsOrigin)
  const method = req.method ?? 'GET'
  const path = (req.url ?? '/').split('?')[0] ?? '/'

  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, { status: 'ok' })
    return
  }
  if (method === 'GET' && path === '/config') {
    const snapshot = ctx.store.snapshot()
    sendJson(res, 200, { version: snapshot.version, config: snapshot.config })
    return
  }
  if (method === 'PUT' && path === '/admin/config') {
    await handleAdminConfig(req, res, ctx)
    return
  }
  sendJson(res, 404, { error: 'not_found' })
}

async function handleAdminConfig(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  if (!isAuthorized(req.headers.authorization, ctx.adminToken)) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }

  let raw: string
  try {
    raw = await readBody(req, MAX_BODY_BYTES)
  } catch {
    sendJson(res, 413, { error: 'payload_too_large' })
    return
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'invalid_json' })
    return
  }

  const parsed = parseAdminPayload(body)
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.error })
    return
  }

  if (parsed.payload.currentVersion !== undefined && parsed.payload.currentVersion !== ctx.store.currentVersion) {
    sendJson(res, 409, { error: 'version_conflict', currentVersion: ctx.store.currentVersion })
    return
  }

  const snapshot = ctx.store.replace(parsed.payload.config)
  ctx.hub.broadcast(snapshot)
  sendJson(res, 200, { version: snapshot.version, config: snapshot.config, clients: ctx.hub.clientCount })
}

function setCorsHeaders(res: ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        reject(new Error('payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function startFromCli(): void {
  const port = Number(process.env.PORT ?? 8787)
  const { isDevFallback } = resolveAdminToken()
  const plane = createControlPlane()
  plane.listen(port).then(
    (boundPort) => {
      console.info(`[ab-sdk] control plane on http://localhost:${boundPort}`)
      console.info('[ab-sdk]   GET /health · GET /config · WS /config/stream · PUT /admin/config')
      if (isDevFallback) {
        console.warn('[ab-sdk] AB_ADMIN_TOKEN not set — using the insecure dev fallback token. Do NOT use in production.')
      }
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[ab-sdk] failed to start control plane on port ${port}: ${message}`)
      process.exitCode = 1
    },
  )
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

if (isMainModule()) {
  startFromCli()
}
