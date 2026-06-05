import { StrictMode, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'

import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAbClient } from '../src/core/abTestingClient'
import { AbTestingProvider, useExperiment, useFeatureFlag } from '../src/react'
import type { AbClient, CreateAbClientOptions, ExposureEvent, RemoteConfig } from '../src/core/types'

const config: RemoteConfig = {
  experiments: {
    exp: {
      key: 'exp',
      seed: 'exp-seed',
      enabled: true,
      controlVariant: 'control',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'treatment', weight: 50 },
      ],
    },
    other: {
      key: 'other',
      seed: 'other-seed',
      enabled: true,
      controlVariant: 'control',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'treatment', weight: 50 },
      ],
    },
  },
  flags: {
    newCheckoutFlow: { key: 'newCheckoutFlow', seed: 'flag-seed', enabled: true, rollout: 100 },
  },
}

function makeClient(overrides: Partial<CreateAbClientOptions> = {}): AbClient {
  return createAbClient({ appKey: 'react', persistence: 'memory', defaultConfig: config, ...overrides })
}

function wrapper(client: AbClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AbTestingProvider client={client}>{children}</AbTestingProvider>
  }
}

afterEach(() => {
  cleanup()
})

describe('AbTestingProvider', () => {
  it('renders its children', () => {
    const client = makeClient()
    const { getByText } = render(
      <AbTestingProvider client={client}>
        <span>hello</span>
      </AbTestingProvider>,
    )
    expect(getByText('hello')).toBeTruthy()
  })
})

describe('useExperiment', () => {
  it('returns the safe default before init without crashing', () => {
    const client = makeClient()
    const { result } = renderHook(() => useExperiment('exp'), { wrapper: wrapper(client) })
    expect(result.current.reason).toBe('DEFAULT_FALLBACK')
    expect(result.current.variant).toBe('control')
    expect(result.current.isReady).toBe(false)
  })

  it('updates after initializeUser', () => {
    const client = makeClient()
    const { result } = renderHook(() => useExperiment('exp'), { wrapper: wrapper(client) })
    expect(result.current.reason).toBe('DEFAULT_FALLBACK')
    act(() => {
      client.initializeUser({ id: 'user-1' })
    })
    expect(['COMPUTED', 'STICKY']).toContain(result.current.reason)
    expect(result.current.isReady).toBe(true)
  })

  it('updates after a config change', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-2' }) // user-2 → treatment for exp-seed
    const { result } = renderHook(() => useExperiment('exp'), { wrapper: wrapper(client) })
    expect(result.current.variant).toBe('treatment')
    act(() => {
      client.setConfig({ experiments: { exp: { ...config.experiments.exp!, enabled: false } }, flags: {} })
    })
    expect(result.current.reason).toBe('EXPERIMENT_DISABLED')
  })

  it('does not re-render when an unrelated experiment changes (stable snapshot)', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    let renders = 0
    renderHook(
      () => {
        renders++
        return useExperiment('exp')
      },
      { wrapper: wrapper(client) },
    )
    const baseline = renders
    act(() => {
      client.getAssignment('other') // unrelated change → store emits, but exp snapshot is stable
    })
    expect(renders).toBe(baseline)
  })

  it('throws an actionable error when used without a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useExperiment('exp'))).toThrow(/AbTestingProvider/)
    spy.mockRestore()
  })
})

describe('exposure timing', () => {
  it('does not fire exposure during render and fires once after commit', () => {
    const exposures: ExposureEvent[] = []
    const client = makeClient({ onExposure: (event) => exposures.push(event) })
    client.initializeUser({ id: 'user-1' })
    const peekSpy = vi.spyOn(client, 'peekAssignment')
    const getAssignmentSpy = vi.spyOn(client, 'getAssignment')

    const { rerender } = renderHook(() => useExperiment('exp'), { wrapper: wrapper(client) })
    expect(peekSpy).toHaveBeenCalled() // render path uses the pure peek
    expect(exposures).toHaveLength(1) // exposure fired by the post-commit effect
    const getAssignmentCalls = getAssignmentSpy.mock.calls.length

    rerender()
    rerender()
    expect(exposures).toHaveLength(1) // renders do not add exposures
    expect(getAssignmentSpy.mock.calls.length).toBe(getAssignmentCalls) // renders do not fire the tracking call

    peekSpy.mockRestore()
    getAssignmentSpy.mockRestore()
  })

  it('dedupes a StrictMode double-invoked effect to a single exposure', () => {
    const exposures: ExposureEvent[] = []
    const client = makeClient({ onExposure: (event) => exposures.push(event) })
    client.initializeUser({ id: 'user-1' })
    function StrictWrapper({ children }: { children: ReactNode }) {
      return (
        <StrictMode>
          <AbTestingProvider client={client}>{children}</AbTestingProvider>
        </StrictMode>
      )
    }
    renderHook(() => useExperiment('exp'), { wrapper: StrictWrapper })
    expect(exposures).toHaveLength(1)
  })

  it('track:false suppresses exposure', () => {
    const exposures: ExposureEvent[] = []
    const client = makeClient({ onExposure: (event) => exposures.push(event) })
    client.initializeUser({ id: 'user-1' })
    renderHook(() => useExperiment('exp', { track: false }), { wrapper: wrapper(client) })
    expect(exposures).toHaveLength(0)
  })
})

describe('useFeatureFlag', () => {
  it('returns the enabled state and the underlying assignment', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' })
    const { result } = renderHook(() => useFeatureFlag('newCheckoutFlow'), { wrapper: wrapper(client) })
    expect(result.current.enabled).toBe(true)
    expect(result.current.assignment.variant).toBe('on')
  })

  it('returns the disabled default before init', () => {
    const client = makeClient()
    const { result } = renderHook(() => useFeatureFlag('newCheckoutFlow'), { wrapper: wrapper(client) })
    expect(result.current.enabled).toBe(false)
  })
})

describe('SSR', () => {
  it('getServerSnapshot renders a safe default without crashing', () => {
    const client = makeClient()
    client.initializeUser({ id: 'user-1' }) // even when initialized, SSR uses the default
    function Display() {
      const assignment = useExperiment('exp')
      return <span>{`${assignment.variant}:${assignment.reason}:${String(assignment.isReady)}`}</span>
    }
    const html = renderToString(
      <AbTestingProvider client={client}>
        <Display />
      </AbTestingProvider>,
    )
    expect(html).toContain('control:DEFAULT_FALLBACK:false')
  })

  it('the React entry exposes the provider and hooks', async () => {
    const mod = await import('../src/react/index')
    expect(typeof mod.AbTestingProvider).toBe('function')
    expect(typeof mod.useExperiment).toBe('function')
    expect(typeof mod.useFeatureFlag).toBe('function')
  })
})
