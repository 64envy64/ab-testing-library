import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type ControlPlane, createControlPlane } from '../server/index'
import type { RemoteConfig } from '../src/core/types'

const seedConfig: RemoteConfig = {
  experiments: {
    exp: {
      key: 'exp',
      seed: 's',
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

const validNewConfig: RemoteConfig = {
  experiments: {
    exp: {
      key: 'exp',
      seed: 's',
      enabled: false,
      controlVariant: 'control',
      variants: [
        { key: 'control', weight: 100 },
        { key: 'treatment', weight: 0 },
      ],
    },
  },
  flags: {},
}

const ADMIN_TOKEN = 'test-admin-token'

let plane: ControlPlane
let baseUrl: string
let wsUrl: string

beforeEach(async () => {
  // Pin the initial version so the HTTP/WS assertions below stay deterministic;
  // the default (epoch) seeding is covered separately in "version durability".
  plane = createControlPlane({ config: seedConfig, adminToken: ADMIN_TOKEN, initialVersion: 1 })
  const port = await plane.listen(0)
  baseUrl = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/config/stream`
})

afterEach(async () => {
  await plane.close()
})

function adminPut(body: unknown, token: string | null = ADMIN_TOKEN): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers['Authorization'] = `Bearer ${token}`
  return fetch(`${baseUrl}/admin/config`, {
    method: 'PUT',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()))
      } catch (error) {
        reject(error as Error)
      }
    })
    socket.once('error', reject)
  })
}

describe('control plane — HTTP', () => {
  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('GET /config returns version + config and leaks no secrets', async () => {
    const res = await fetch(`${baseUrl}/config`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { version: number; config: RemoteConfig }
    expect(body.version).toBe(1)
    expect(body.config).toEqual(seedConfig)
    expect(Object.keys(body).sort()).toEqual(['config', 'version'])
    expect(JSON.stringify(body)).not.toContain(ADMIN_TOKEN)
  })

  it('admin PUT without a token → 401', async () => {
    expect((await adminPut({ config: validNewConfig }, null)).status).toBe(401)
  })

  it('admin PUT with a bad token → 401', async () => {
    expect((await adminPut({ config: validNewConfig }, 'wrong-token')).status).toBe(401)
  })

  it('admin PUT with invalid JSON → 400', async () => {
    expect((await adminPut('definitely not json')).status).toBe(400)
  })

  it('admin PUT over the body limit → 413', async () => {
    const oversized = JSON.stringify({ config: validNewConfig, padding: 'x'.repeat(1_000_001) })
    expect((await adminPut(oversized)).status).toBe(413)
  })

  it('admin PUT with an invalid config → 400', async () => {
    const res = await adminPut({ config: { experiments: { exp: { key: 'exp' } }, flags: {} } })
    expect(res.status).toBe(400)
  })

  it('admin PUT with a valid config → increments the monotonic version', async () => {
    const res = await adminPut({ config: validNewConfig })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { version: number; config: RemoteConfig }
    expect(body.version).toBe(2)
    expect(body.config).toEqual(validNewConfig)

    const read = (await (await fetch(`${baseUrl}/config`)).json()) as { version: number }
    expect(read.version).toBe(2)
  })

  it('admin PUT with a stale currentVersion → 409', async () => {
    const res = await adminPut({ config: validNewConfig, currentVersion: 999 })
    expect(res.status).toBe(409)
  })

  it('rejects cleanly when trying to listen on an occupied port', async () => {
    const occupied = new URL(baseUrl).port
    const second = createControlPlane({ config: seedConfig, adminToken: ADMIN_TOKEN })
    await expect(second.listen(Number(occupied))).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})

describe('control plane — version durability across restarts', () => {
  it('seeds the version from an epoch by default (never rewinds to 1 on restart)', () => {
    const fresh = createControlPlane({ config: seedConfig, adminToken: ADMIN_TOKEN })
    // A real epoch-ms value, not the old reset-to-1 default.
    expect(fresh.store.snapshot().version).toBeGreaterThan(1_000_000_000_000)
  })

  it('a later-started control plane keeps a strictly higher version (monotonic across restart)', () => {
    const earlier = createControlPlane({ config: seedConfig, adminToken: ADMIN_TOKEN, initialVersion: 1_000 })
    earlier.store.replace(validNewConfig) // -> 1001
    const restarted = createControlPlane({ config: seedConfig, adminToken: ADMIN_TOKEN, initialVersion: 2_000 })
    expect(restarted.store.snapshot().version).toBeGreaterThan(earlier.store.snapshot().version)
  })
})

describe('control plane — WebSocket', () => {
  it('sends the current config on connect', async () => {
    const socket = new WebSocket(wsUrl)
    const message = await nextMessage(socket)
    expect(message).toMatchObject({ type: 'config.replace', version: 1 })
    socket.close()
  })

  it('broadcasts config.replace to connected clients after an admin update', async () => {
    const socket = new WebSocket(wsUrl)
    await nextMessage(socket) // connect snapshot (version 1)
    const broadcast = nextMessage(socket)

    expect((await adminPut({ config: validNewConfig })).status).toBe(200)

    const message = await broadcast
    expect(message).toMatchObject({ type: 'config.replace', version: 2 })
    socket.close()
  })

  it('reports how many clients received the broadcast', async () => {
    const socket = new WebSocket(wsUrl)
    await nextMessage(socket) // connect snapshot
    const res = await adminPut({ config: validNewConfig })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { clients: number }
    expect(body.clients).toBeGreaterThanOrEqual(1)
    socket.close()
  })
})
