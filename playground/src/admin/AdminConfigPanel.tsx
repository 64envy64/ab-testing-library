import { useEffect, useState, type CSSProperties } from 'react'

import type { RemoteConfig } from 'ab-testing-library'

import { CHECKOUT_EXPERIMENT, CHECKOUT_FLAG, TREATMENT_VARIANT } from '../config'

interface Editable {
  experimentEnabled: boolean
  variantBWeight: number
  flagEnabled: boolean
  flagRollout: number
}

interface Status {
  kind: 'idle' | 'ok' | 'err'
  text: string
}

interface Seeds {
  experimentSeed: string
  flagSeed: string
}

interface ConfigSnapshot {
  version: number
  config: RemoteConfig
}

export interface AdminConfigPanelProps {
  apiBase: string
  adminToken: string
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** Versions are epoch-seeded (long, monotonic). Show a short, still-ticking suffix. */
function formatVersion(version: number | null): string {
  if (version === null) return '—'
  const s = String(version)
  return '#' + (s.length > 6 ? s.slice(-4) : s)
}

function toConfigStreamUrl(apiBase: string): string | null {
  try {
    const url = new URL(apiBase)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/config/stream'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function AdminConfigPanel({ apiBase, adminToken }: AdminConfigPanelProps) {
  const [editable, setEditable] = useState<Editable | null>(null)
  const [seeds, setSeeds] = useState<Seeds>({ experimentSeed: 'checkout-copy.v1', flagSeed: 'newCheckoutFlow.v1' })
  const [version, setVersion] = useState<number | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' })
  const [busy, setBusy] = useState(false)

  function applySnapshot(data: ConfigSnapshot): void {
    const experiment = data.config.experiments[CHECKOUT_EXPERIMENT]
    const flag = data.config.flags[CHECKOUT_FLAG]
    setEditable({
      experimentEnabled: experiment?.enabled ?? true,
      variantBWeight: experiment?.variants.find((variant) => variant.key === TREATMENT_VARIANT)?.weight ?? 50,
      flagEnabled: flag?.enabled ?? true,
      flagRollout: flag?.rollout ?? 50,
    })
    setSeeds({
      experimentSeed: experiment?.seed ?? 'checkout-copy.v1',
      flagSeed: flag?.seed ?? 'newCheckoutFlow.v1',
    })
    setVersion(data.version)
  }

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/config`)
        if (!res.ok) throw new Error(`GET /config → ${res.status}`)
        const data = (await res.json()) as ConfigSnapshot
        if (!active) return
        applySnapshot(data)
        setStatus({ kind: 'idle', text: '' })
      } catch (error) {
        if (active) {
          setStatus({ kind: 'err', text: `Backend unreachable — run \`npm run server\`. (${String(error)})` })
        }
      }
    })()
    return () => {
      active = false
    }
  }, [apiBase])

  useEffect(() => {
    const streamUrl = toConfigStreamUrl(apiBase)
    if (streamUrl === null || typeof WebSocket !== 'function') return

    let active = true
    const socket = new WebSocket(streamUrl)
    socket.onmessage = (event: MessageEvent) => {
      if (!active || typeof event.data !== 'string') return
      try {
        const message = JSON.parse(event.data) as { type?: unknown; version?: unknown; config?: unknown }
        if (message.type !== 'config.replace' || typeof message.version !== 'number') return
        applySnapshot({ version: message.version, config: message.config as RemoteConfig })
      } catch {
        /* ignore malformed demo messages */
      }
    }

    return () => {
      active = false
      socket.close()
    }
  }, [apiBase])

  function buildConfig(state: Editable): RemoteConfig {
    return {
      experiments: {
        [CHECKOUT_EXPERIMENT]: {
          key: CHECKOUT_EXPERIMENT,
          seed: seeds.experimentSeed,
          enabled: state.experimentEnabled,
          controlVariant: 'control',
          variants: [
            { key: 'control', weight: 100 - state.variantBWeight },
            { key: TREATMENT_VARIANT, weight: state.variantBWeight },
          ],
        },
      },
      flags: {
        [CHECKOUT_FLAG]: {
          key: CHECKOUT_FLAG,
          seed: seeds.flagSeed,
          enabled: state.flagEnabled,
          rollout: state.flagRollout,
        },
      },
    }
  }

  async function apply(): Promise<void> {
    if (editable === null || busy) return
    setBusy(true)
    setStatus({ kind: 'idle', text: 'Applying…' })
    try {
      const res = await fetch(`${apiBase}/admin/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ config: buildConfig(editable), currentVersion: version ?? undefined }),
      })
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string; currentVersion?: number }
        // Optimistic-concurrency recovery: the config changed elsewhere (another tab /
        // REST). Sync to the server's current version so the next Apply succeeds.
        if (res.status === 409 && typeof detail.currentVersion === 'number') {
          setVersion(detail.currentVersion)
          setStatus({
            kind: 'err',
            text: `Config changed elsewhere — now at version ${formatVersion(detail.currentVersion)}. Review and Apply again to overwrite.`,
          })
          return
        }
        throw new Error(`${res.status} ${detail.error ?? ''}`.trim())
      }
      const data = (await res.json()) as { version: number; clients?: number }
      setVersion(data.version)
      const n = data.clients ?? 0
      setStatus({
        kind: 'ok',
        text: `Applied — now at version ${formatVersion(data.version)} · broadcast to ${n} ${n === 1 ? 'client' : 'clients'}.`,
      })
    } catch (error) {
      setStatus({ kind: 'err', text: `Update failed: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(false)
    }
  }

  const disabled = editable === null

  return (
    <section className="card span-2">
      <h2>Admin · live config (control plane)</h2>
      <p className="card-hint">
        Edit the live config and broadcast it to every connected client.{' '}
        <span className="badge">demo token</span>
      </p>

      <div className="config-grid">
        <div className="config-block">
          <div className="config-block-head">
            <strong className="mono">{CHECKOUT_EXPERIMENT}</strong>
            <Toggle
              label={editable?.experimentEnabled ? 'enabled' : 'disabled'}
              checked={editable?.experimentEnabled ?? false}
              disabled={disabled}
              onChange={(checked) => setEditable((prev) => (prev ? { ...prev, experimentEnabled: checked } : prev))}
            />
          </div>
          <Slider
            ariaLabel="variant-b weight"
            value={editable?.variantBWeight ?? 50}
            disabled={disabled}
            onChange={(value) => setEditable((prev) => (prev ? { ...prev, variantBWeight: value } : prev))}
          />
          <p className="card-hint" style={{ margin: 0 }}>
            control {100 - (editable?.variantBWeight ?? 50)}% · {TREATMENT_VARIANT} {editable?.variantBWeight ?? 50}%
          </p>
        </div>

        <div className="config-block">
          <div className="config-block-head">
            <strong className="mono">{CHECKOUT_FLAG}</strong>
            <Toggle
              label={editable?.flagEnabled ? 'enabled' : 'disabled'}
              checked={editable?.flagEnabled ?? false}
              disabled={disabled}
              onChange={(checked) => setEditable((prev) => (prev ? { ...prev, flagEnabled: checked } : prev))}
            />
          </div>
          <Slider
            ariaLabel="flag rollout"
            value={editable?.flagRollout ?? 50}
            disabled={disabled}
            onChange={(value) => setEditable((prev) => (prev ? { ...prev, flagRollout: value } : prev))}
          />
          <p className="card-hint" style={{ margin: 0 }}>
            rollout {editable?.flagRollout ?? 50}% of users
          </p>
        </div>
      </div>

      <div className="section-divider" />

      <div className="config-foot">
        <button type="button" className="primary" onClick={() => void apply()} disabled={disabled || busy}>
          {busy ? 'Applying…' : 'Apply to backend'}
        </button>
        <span className="badge">
          version <span className="mono">{formatVersion(version)}</span>
        </span>
      </div>
      {status.text !== '' && (
        <p className={`status-line ${status.kind === 'idle' ? '' : status.kind}`}>{status.text}</p>
      )}
    </section>
  )
}

interface SliderProps {
  value: number
  disabled?: boolean
  ariaLabel: string
  onChange(value: number): void
}

function Slider({ value, disabled, ariaLabel, onChange }: SliderProps) {
  const clamped = clampPercent(value)
  return (
    <div className="slider-row">
      <input
        type="range"
        min={0}
        max={100}
        aria-label={ariaLabel}
        value={clamped}
        disabled={disabled ?? false}
        style={{ '--fill': `${clamped}%` } as CSSProperties}
        onChange={(event) => {
          onChange(clampPercent(event.target.valueAsNumber))
        }}
      />
      <span className="value">{clamped}%</span>
    </div>
  )
}

interface ToggleProps {
  label: string
  checked: boolean
  disabled?: boolean
  onChange(checked: boolean): void
}

function Toggle({ label, checked, disabled, onChange }: ToggleProps) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled ?? false}
        onChange={(event) => {
          onChange(event.target.checked)
        }}
      />
      <span className="track" />
      <span className="mono">{label}</span>
    </label>
  )
}
