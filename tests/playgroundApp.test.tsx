import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AdminConfigPanel } from '../playground/src/admin/AdminConfigPanel'
import { App } from '../playground/src/App'
import { createAbClient } from '../src/core/abTestingClient'
import type { AbClient, RemoteConfig } from '../src/core/types'

const testConfig: RemoteConfig = {
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
    newCheckoutFlow: { key: 'newCheckoutFlow', seed: 'newCheckoutFlow.v1', enabled: true, rollout: 100 },
  },
}

const stubConnection = { getStatus: () => 'open', subscribe: () => () => {} }

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response
}

function mockBackend(putResponse?: () => Response) {
  const fetchMock = vi.fn((_input: unknown, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    if (method === 'PUT') {
      return Promise.resolve(putResponse ? putResponse() : jsonResponse(200, { version: 2, config: testConfig }))
    }
    return Promise.resolve(jsonResponse(200, { version: 1, config: testConfig }))
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', undefined)
  return fetchMock
}

class MockWebSocket {
  static instances: MockWebSocket[] = []
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }

  close(): void {}
}

function makeClient(persistence: 'memory' | 'local' = 'memory', appKey = 'example-test'): AbClient {
  globalThis.localStorage.clear()
  return createAbClient({ appKey, persistence, defaultConfig: testConfig })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('example App', () => {
  beforeEach(() => {
    mockBackend()
  })

  it('renders the console (smoke)', () => {
    render(<App client={makeClient()} connection={stubConnection} apiBase="http://test" adminToken="demo" />)
    expect(screen.getByText('A/B Testing Console')).toBeTruthy()
  })

  it('renders the activity log when an event log is provided', () => {
    const entries = [{ id: 1, time: '12:00:00', kind: 'config' as const, text: 'config → v2' }]
    const stubEventLog = {
      getEntries: () => entries, // stable reference, as useSyncExternalStore requires
      subscribe: () => () => {},
    }
    render(
      <App
        client={makeClient()}
        connection={stubConnection}
        eventLog={stubEventLog}
        apiBase="http://test"
        adminToken="demo"
      />,
    )
    expect(screen.getByText('Activity log')).toBeTruthy()
    expect(screen.getByText('config → v2')).toBeTruthy()
  })

  it('initializing a user updates the experiment hook output', async () => {
    render(<App client={makeClient()} connection={stubConnection} apiBase="http://test" adminToken="demo" />)
    expect(screen.queryAllByText('DEFAULT_FALLBACK').length).toBeGreaterThan(0)
    fireEvent.change(screen.getByLabelText('User ID'), { target: { value: 'user-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Initialize user' }))
    await waitFor(() => {
      expect(screen.queryAllByText('DEFAULT_FALLBACK').length).toBe(0)
    })
  })

  it('renders the treatment-only section for variant-b (via QA force)', async () => {
    const client = makeClient()
    render(<App client={client} connection={stubConnection} apiBase="http://test" adminToken="demo" />)
    fireEvent.change(screen.getByLabelText('User ID'), { target: { value: 'user-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Initialize user' }))
    fireEvent.click(screen.getByRole('button', { name: /force variant-b/i }))
    await waitFor(() => {
      expect(screen.getByText(/Variant B copy/)).toBeTruthy()
    })
  })

  it('renders the feature-flag section when enabled', async () => {
    render(<App client={makeClient()} connection={stubConnection} apiBase="http://test" adminToken="demo" />)
    fireEvent.change(screen.getByLabelText('User ID'), { target: { value: 'user-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Initialize user' }))
    await waitFor(() => {
      expect(screen.getByText(/New checkout flow/)).toBeTruthy()
    })
  })

  it('does not persist raw email', async () => {
    const client = makeClient('local', 'email-test')
    render(<App client={client} connection={stubConnection} apiBase="http://test" adminToken="demo" />)
    fireEvent.change(screen.getByLabelText('User ID'), { target: { value: 'user-1' } })
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'secret@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Initialize user' }))
    await waitFor(() => {
      expect(screen.queryAllByText('DEFAULT_FALLBACK').length).toBe(0)
    })
    expect(globalThis.localStorage.getItem('abtest:email-test') ?? '').not.toContain('secret@example.com')
  })
})

describe('AdminConfigPanel', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
  })

  it('PUTs the correct shape to the backend', async () => {
    const fetchMock = mockBackend()
    render(<AdminConfigPanel apiBase="http://test" adminToken="demo-token" />)
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Apply to backend/i }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply to backend/i }))
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PUT')
      expect(putCall).toBeDefined()
      const init = putCall![1] as RequestInit
      expect(init.method).toBe('PUT')
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer demo-token')
      const body = JSON.parse(init.body as string) as { config: RemoteConfig; currentVersion?: number }
      expect(body.config.experiments['checkout-copy']).toBeDefined()
      expect(body.config.flags['newCheckoutFlow']).toBeDefined()
    })
  })

  it('shows an actionable error when the backend rejects the update', async () => {
    mockBackend(() => jsonResponse(500, { error: 'internal_error' }))
    render(<AdminConfigPanel apiBase="http://test" adminToken="demo-token" />)
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Apply to backend/i }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply to backend/i }))
    await waitFor(() => {
      expect(screen.getByText(/Update failed/i)).toBeTruthy()
    })
  })

  it('recovers from a version conflict by syncing to the latest version', async () => {
    mockBackend(() => jsonResponse(409, { error: 'version_conflict', currentVersion: 7 }))
    render(<AdminConfigPanel apiBase="http://test" adminToken="demo-token" />)
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Apply to backend/i }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply to backend/i }))
    await waitFor(() => {
      expect(screen.getByText(/changed elsewhere.*version 7/i)).toBeTruthy()
    })
  })

  it('syncs controls from the live config stream', async () => {
    mockBackend()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<AdminConfigPanel apiBase="http://test" adminToken="demo-token" />)
    await waitFor(() => {
      expect((screen.getByLabelText('variant-b weight') as HTMLInputElement).value).toBe('50')
    })

    const socket = MockWebSocket.instances[0]
    expect(socket?.url).toBe('ws://test/config/stream')
    socket?.push({
      type: 'config.replace',
      version: 2,
      config: {
        experiments: {
          'checkout-copy': {
            ...testConfig.experiments['checkout-copy']!,
            variants: [
              { key: 'control', weight: 70 },
              { key: 'variant-b', weight: 30 },
            ],
          },
        },
        flags: {
          newCheckoutFlow: { ...testConfig.flags.newCheckoutFlow!, rollout: 65 },
        },
      },
    })

    await waitFor(() => {
      expect((screen.getByLabelText('variant-b weight') as HTMLInputElement).value).toBe('30')
      expect((screen.getByLabelText('flag rollout') as HTMLInputElement).value).toBe('65')
      expect(screen.getByText('2')).toBeTruthy()
    })
  })
})
