import { useEffect, useState, useSyncExternalStore } from 'react'

import { SDK_VERSION, type AbClient, type DebugState } from 'ab-testing-library'
import { AbTestingProvider, useExperiment, useFeatureFlag } from 'ab-testing-library/react'

import { AdminConfigPanel } from './admin/AdminConfigPanel'
import type { DemoConnection, DemoEvent, EventLog } from './client'
import { CHECKOUT_EXPERIMENT, CHECKOUT_FLAG, TREATMENT_VARIANT } from './config'

export interface AppProps {
  client: AbClient
  connection: DemoConnection
  eventLog?: EventLog
  apiBase: string
  adminToken: string
}

export function App({ client, connection, eventLog, apiBase, adminToken }: AppProps) {
  return (
    <AbTestingProvider client={client}>
      <div className="app">
        <TopBar connection={connection} />
        <div className="grid">
          <UserPanel client={client} />
          <ExperimentPanel client={client} />
          <FeatureFlagPanel />
          <AdminConfigPanel apiBase={apiBase} adminToken={adminToken} />
          {eventLog && <EventLogPanel eventLog={eventLog} />}
          <DebugPanel client={client} />
        </div>
      </div>
    </AbTestingProvider>
  )
}

/** Re-render on any client change and expose the current (fresh) debug snapshot. */
function useDebugState(client: AbClient): DebugState {
  const [snapshot, setSnapshot] = useState(() => client.getDebugState())
  useEffect(() => {
    const update = (): void => {
      setSnapshot(client.getDebugState())
    }
    update()
    return client.subscribe(update)
  }, [client])
  return snapshot
}

function statusKind(status: string): 'ok' | 'warn' | 'err' {
  if (status === 'open') return 'ok'
  if (status === 'error' || status === 'closed') return 'err'
  return 'warn'
}

function TopBar({ connection }: { connection: DemoConnection }) {
  const status = useSyncExternalStore(connection.subscribe, connection.getStatus, () => 'connecting')
  return (
    <header className="topbar">
      <h1>A/B Testing Console</h1>
      <div className="topbar-meta">
        <span className={`badge ${statusKind(status)}`}>
          <span className="dot" />
          backend: {status}
        </span>
        <span className="badge">
          sdk <span className="mono">{SDK_VERSION}</span>
        </span>
      </div>
    </header>
  )
}

function UserPanel({ client }: { client: AbClient }) {
  const debug = useDebugState(client)
  // Seed the field from the restored session (if any) so it matches the live state.
  const [userId, setUserId] = useState(() => client.getDebugState().user?.id ?? 'user-123')
  const [email, setEmail] = useState('')

  function initialize(): void {
    const userData = email.trim() === '' ? { id: userId.trim() } : { id: userId.trim(), email: email.trim() }
    if (debug.initialized) client.updateUser(userData)
    else client.initializeUser(userData)
  }

  return (
    <section className="card">
      <h2>User session</h2>
      <p className="card-hint">
        Session identity and privacy-safe bucketing state.
      </p>
      <div className="field">
        <label htmlFor="ab-user-id">User ID</label>
        <input id="ab-user-id" type="text" value={userId} onChange={(event) => setUserId(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ab-user-email">Email (optional, in-memory only)</label>
        <input id="ab-user-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </div>
      <div className="row">
        <button type="button" className="primary" onClick={initialize}>
          {debug.initialized ? 'Update user' : 'Initialize user'}
        </button>
        <button type="button" className="ghost" onClick={() => client.reset()} disabled={!debug.initialized}>
          Reset
        </button>
      </div>
      <div className="card-foot">
        <div className="section-divider" />
        <dl className="kv">
          <dt>initialized</dt>
          <dd>{String(debug.initialized)}</dd>
          <dt>ready</dt>
          <dd>{String(debug.isReady)}</dd>
          <dt>bucketing id</dt>
          <dd>{debug.bucketingId ?? '—'}</dd>
        </dl>
      </div>
    </section>
  )
}

function ExperimentPanel({ client }: { client: AbClient }) {
  const assignment = useExperiment(CHECKOUT_EXPERIMENT)
  const isTreatment = assignment.variant === TREATMENT_VARIANT

  return (
    <section className="card">
      <h2>Experiment · {CHECKOUT_EXPERIMENT}</h2>
      <p className="card-hint">Checkout copy allocation.</p>
      <dl className="kv">
        <dt>variant</dt>
        <dd>
          <span className={`badge ${isTreatment ? '' : 'warn'}`}>{assignment.variant}</span>
        </dd>
        <dt>reason</dt>
        <dd>{assignment.reason}</dd>
        <dt>source</dt>
        <dd>{assignment.source}</dd>
        <dt>ready</dt>
        <dd>{String(assignment.isReady)}</dd>
      </dl>

      {isTreatment && (
        <div className="gated">
          <h3>Variant B copy</h3>
          <p>Treatment copy is visible for the {TREATMENT_VARIANT} group.</p>
        </div>
      )}

      <div className="card-foot">
        <div className="section-divider" />
        <div className="row">
          <button type="button" className="ghost" onClick={() => client.resetAssignment(CHECKOUT_EXPERIMENT)}>
            Re-roll assignment
          </button>
          <button type="button" className="ghost" onClick={() => client.setForcedOverride(CHECKOUT_EXPERIMENT, TREATMENT_VARIANT)}>
            QA: force {TREATMENT_VARIANT}
          </button>
          <button type="button" className="ghost" onClick={() => client.clearForcedOverride(CHECKOUT_EXPERIMENT)}>
            Clear force
          </button>
        </div>
      </div>
    </section>
  )
}

function FeatureFlagPanel() {
  const flag = useFeatureFlag(CHECKOUT_FLAG)
  return (
    <section className="card">
      <h2>Feature flag · {CHECKOUT_FLAG}</h2>
      <p className="card-hint">Checkout rollout gate.</p>
      <dl className="kv">
        <dt>enabled</dt>
        <dd>
          <span className={`badge ${flag.enabled ? 'ok' : 'warn'}`}>{String(flag.enabled)}</span>
        </dd>
        <dt>reason</dt>
        <dd>{flag.assignment.reason}</dd>
      </dl>
      {flag.enabled && (
        <div className="gated">
          <h3>New checkout flow</h3>
          <p>The new checkout experience is live for this user.</p>
        </div>
      )}
      <div className="card-foot">
        <div className="section-divider" />
        <dl className="kv">
          <dt>source</dt>
          <dd>{flag.assignment.source}</dd>
          <dt>ready</dt>
          <dd>{String(flag.assignment.isReady)}</dd>
        </dl>
      </div>
    </section>
  )
}

function DebugPanel({ client }: { client: AbClient }) {
  const debug = useDebugState(client)
  return (
    <section className="card span-2">
      <h2>SDK debug state</h2>
      <p className="card-hint">Current SDK snapshot without persisted PII.</p>
      <pre className="debug">{JSON.stringify(debug, null, 2)}</pre>
    </section>
  )
}

const NO_EVENTS: DemoEvent[] = []

function EventLogPanel({ eventLog }: { eventLog: EventLog }) {
  const entries = useSyncExternalStore(eventLog.subscribe, eventLog.getEntries, () => NO_EVENTS)
  return (
    <section className="card span-2">
      <h2>Activity log</h2>
      <p className="card-hint">
        Live SDK events — config broadcasts, assignments and exposures as they happen. Open a second tab to
        watch updates fan out.
      </p>
      {entries.length === 0 ? (
        <p className="eventlog-empty">No events yet — initialize a user or apply a config change.</p>
      ) : (
        <ul className="eventlog">
          {entries.map((entry) => (
            <li key={entry.id} className="eventlog-row">
              <span className="eventlog-time mono">{entry.time}</span>
              <span className={`eventlog-tag kind-${entry.kind}`}>{entry.kind}</span>
              <span className="eventlog-text mono">{entry.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
