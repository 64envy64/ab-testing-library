# ab-testing-library

A modular **A/B testing & feature-flag SDK** for the browser — a
framework-agnostic core with a thin React adapter, deterministic sticky assignment,
real-time remote config, cross-tab sync, exposure tracking, and a demo control
plane.

![license](https://img.shields.io/badge/license-MIT-22c55e)
![types](https://img.shields.io/badge/types-included-22c55e)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-22c55e)
![core size](https://img.shields.io/badge/core-~6.8kB%20br-22c55e)

```ts
const client = createAbClient({ appKey: 'web', remote: { url: 'wss://…/config/stream' } })
client.initializeUser({ id: user.id })
const variant = client.getVariant('checkout-copy') // 'control' | 'variant-b' — deterministic & sticky
```

---

## How it works

In plain terms:

1. You hand the SDK a **user id** and a **config** of experiments and feature flags.
2. It hashes the id into a **variant** — deterministically, so the same id always lands on
   the same variant (no server round-trip, no randomness).
3. That choice is **saved in `localStorage`**, so it stays stable across reloads and tabs.
4. An optional **WebSocket** streams config changes (split %, enable/disable) to the running
   app live.
5. You read a variant with `getVariant(key)` / `isFeatureEnabled(key)`, or the
   `useExperiment` / `useFeatureFlag` hooks in React.

Changing a split later does **not** reshuffle users who are already assigned — see
[How a split change behaves](#how-a-split-change-behaves).

## Why this SDK

- **Deterministic & sticky** — variants are bucketed with MurmurHash3 (`seed:bucketingId`),
  so the same user gets the same variant across reloads on the same device. Provenance
  is stored, so split changes never churn assigned users.
- **Fails open** — runtime / config / network problems never throw into your app.
  Only a true contract violation (evaluating before `initializeUser`) throws.
- **Real-time** — a WebSocket `config.replace` stream updates the running app live;
  monotonic versioning ignores stale/replayed messages; reconnect with backoff + jitter.
- **SSR-safe React** — hooks use `useSyncExternalStore` with memoized, referentially
  stable snapshots; exposure fires only after commit (never during render); a stable
  `getServerSnapshot` keeps hydration crash-free.
- **Cross-tab** — assignments and config sync between tabs via `storage` events and
  `BroadcastChannel`, with no echo loops.
- **Exposure tracking** — pluggable `onExposure`, deduped per session, so you can
  actually measure the experiment.
- **Clear about scope** — local persistence is per-device; cross-device stickiness
  requires the (reserved) server-side assignment store. See [Limitations](#limitations).
- **Tiny & dependency-free** — zero runtime dependencies; React is a peer dependency;
  `./` (core) and `./react` are separate entry points so non-React consumers never
  pull React.

## Install

```bash
npm install ab-testing-library
# React adapter additionally needs React 18.3+ or 19 (peer dependency)
```

## Quickstart (60 seconds)

### Framework-agnostic core

```ts
import { createAbClient, type RemoteConfig } from 'ab-testing-library'

const defaultConfig: RemoteConfig = {
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
    newCheckoutFlow: { key: 'newCheckoutFlow', seed: 'newCheckoutFlow.v1', enabled: true, rollout: 25 },
  },
}

const client = createAbClient({ appKey: 'web', defaultConfig })
client.initializeUser({ id: 'user-123' })

client.getVariant('checkout-copy')          // 'control' | 'variant-b'
client.isFeatureEnabled('newCheckoutFlow')  // boolean
```

### React

```tsx
import { createAbClient } from 'ab-testing-library'
import { AbTestingProvider, useExperiment, useFeatureFlag } from 'ab-testing-library/react'

const client = createAbClient({ appKey: 'web', defaultConfig })
client.initializeUser({ id: 'user-123' })

function Root() {
  return (
    <AbTestingProvider client={client}>
      <Checkout />
    </AbTestingProvider>
  )
}

function Checkout() {
  const { variant, isReady } = useExperiment('checkout-copy')
  const { enabled } = useFeatureFlag('newCheckoutFlow')

  if (!isReady) return <Skeleton /> // optional: avoid the control→variant flip
  return (
    <>
      {variant === 'variant-b' ? <NewCopy /> : <ControlCopy />}
      {enabled && <NewCheckoutFlow />}
    </>
  )
}
```

> The core never imports React. The `./react` entry is the only React-aware code and
> ships with a `"use client"` directive for the Next.js App Router / RSC.

## Core API

### `createAbClient(options)`

| option | type | default | notes |
| --- | --- | --- | --- |
| `appKey` | `string` | — (required) | namespaces persisted storage keys across apps/environments |
| `defaultConfig` | `RemoteConfig` | empty | offline bootstrap config |
| `fallbackVariant` | `string` | `'control'` | returned for unknown/unresolved experiments |
| `remote` | `{ url?, transport?, reconnect? }` | — | enables the WebSocket config stream |
| `persistence` | `'local' \| 'memory'` | `'local'` | falls back to memory if storage is unavailable |
| `tracking` | `boolean` | `true` | master switch for exposure callbacks |
| `strict` | `boolean` | `false` | dev/test: turn fail-open warnings into throws (sync paths only) |
| `urlOverridePrefix` | `string` | `'ab_force_'` | prefix for URL-driven QA overrides |
| `logger` | `AbLogger` | — | `console` satisfies it |
| `onEvent` | `(e: AbSdkEvent) => void` | — | lifecycle + structured error events |
| `onExposure` | `(e: ExposureEvent) => void` | — | analytics sink |

### Methods

```ts
client.initializeUser(userData, { reassignVariant? })
client.updateUser(userData, { reassignVariant? })

client.getAssignment(key, { track? })   // → { experimentKey, variant, reason, source, isReady, trackable }
client.getVariant(key, { track? })       // → string
client.isFeatureEnabled(flagKey, { track? }) // → boolean

client.peekAssignment(key)               // render-safe, side-effect-free read (default before init)
client.peekFeatureFlag(flagKey)          // → { enabled, assignment }

client.setConfig(config)                 // replace the base/default config
client.setAdminOverride(partialConfig)   // QA/admin layer on top of base/remote (survives setConfig)
client.clearAdminOverride(key?)
client.setForcedOverride(key, variant)   // QA: force a variant (read-time only; never persisted/tracked)
client.clearForcedOverride(key?)
client.loadForcedOverridesFromUrl(new URLSearchParams(location.search)) // ?ab_force_<key>=<variant>

client.subscribe(listener)               // → unsubscribe
client.resetAssignment(key)
client.reset() / client.clear()          // full wipe (logout / right-to-be-forgotten)
client.getDebugState()                   // read-only snapshot (no PII)
client.destroy()                         // tear down transport / cross-tab / listeners
```

### Assignment result & reasons

`getAssignment` returns `{ variant, reason, source, isReady, trackable }`. `reason` explains
the evaluation and drives exposure eligibility:

| reason | meaning | exposure-eligible |
| --- | --- | --- |
| `STICKY` | reused a valid persisted assignment | ✅ |
| `COMPUTED` | freshly bucketed (or re-randomized) | ✅ |
| `VARIANT_REMOVED_REASSIGNED` | assigned variant gone → re-bucketed | ✅ |
| `VARIANT_REMOVED_FALLBACK` | assigned variant gone → control | ✅ |
| `EXPERIMENT_DISABLED` | experiment off → control | — |
| `EXPERIMENT_NOT_FOUND` | unknown experiment → fallback | — |
| `FORCED_OVERRIDE` | QA forced variant | — |
| `DEFAULT_FALLBACK` | not initialized yet (React/SSR) | — |
| `NOT_IN_EXPERIMENT` | reserved (holdout/traffic allocation) | — |

## Feature flags

Flags reuse the experiment pipeline (a flag is an on/off weighted experiment), so they
are sticky and provenance-backed too:

```ts
client.isFeatureEnabled('newCheckoutFlow')          // boolean
const { enabled, assignment } = client.peekFeatureFlag('newCheckoutFlow')
```

## Remote config & live updates

Point the client at a control plane and it boots from the cached config, then reconciles
live over WebSocket:

```ts
const client = createAbClient({
  appKey: 'web',
  defaultConfig,                          // shown until the live config arrives
  remote: { url: 'ws://localhost:8787/config/stream' },
})
```

- Bootstrap from the last-known cached config (no flicker for returning users).
- `isReady` flips to `true` after the first `config.replace` confirms sync.
- Monotonic `version`: a config is applied only when `version > lastApplied`; stale/
  replayed messages are ignored (and reported as `AB_E_REMOTE_STALE`).
- Reconnect with exponential backoff + jitter; `connection.status` lifecycle events
  (`connecting` / `open` / `closed` / `reconnecting` / `error`) via `onEvent`.

### How a split change behaves

Assignments are **sticky**: once a user is bucketed, changing the split percentage later
does **not** move them. A 50/50 → 80/20 change only affects users who haven't been assigned
yet — everyone already in the experiment keeps their variant. This is what keeps a running
experiment valid: you never silently re-bucket your sample mid-flight.

A user is only re-bucketed when something fundamental changes:

| Trigger | Result |
| --- | --- |
| Split % changes | **No change** — assigned users stay sticky |
| `enabled: false` → `true` again | Variant is preserved across the toggle |
| A variant is removed from the config | Re-bucketed among the remaining variants (or control) |
| `seed` changes | Intentional re-randomization — everyone is re-bucketed |
| `updateUser(…, { reassignVariant: true })` or a new `user.id` | Re-bucketed |
| `resetAssignment(key)` / `reset()` | Assignment cleared, recomputed fresh |

This is a deliberate choice: **stable by default**, with a few explicit, predictable
triggers for re-randomization.

### Simulating remote updates

The repo ships a demo control plane and a tests/admin-friendly mock transport.

**With the demo backend** (see [Running the demo](#running-the-demo)):

```bash
npm run server            # control plane on http://localhost:8787
curl -X PUT http://localhost:8787/admin/config \
  -H "Authorization: Bearer dev-only-admin-token" \
  -H "content-type: application/json" \
  -d '{"config": { "experiments": { … }, "flags": { … } }}'
# → version increments, broadcast to every connected client over WebSocket
```

**In tests, with the mock transport** (no network):

```ts
import { createMockRemoteTransport } from 'ab-testing-library/testing'

const transport = createMockRemoteTransport()
const client = createAbClient({ appKey: 'test', remote: { transport } })
client.initializeUser({ id: 'user-1' })
transport.pushConfig(newConfig, 2)        // applied if 2 > lastApplied
transport.simulateOpen() / simulateClose() / simulateError()
```

## Overrides (QA / admin)

- **Forced override** (per-tab, read-time only — never persisted, never tracked):
  `client.setForcedOverride('checkout-copy', 'variant-b')` or
  `?ab_force_checkout-copy=variant-b` via `loadForcedOverridesFromUrl(...)`.
- **Admin override** (a local config patch layer that survives remote refreshes):
  `client.setAdminOverride({ experiments: { 'checkout-copy': { enabled: false } } })`.

Precedence: **forced override → admin override → remote/cached config → default config**.

## Exposure tracking

Wire `onExposure` to your analytics. Exposures are deduped in-memory per session by
`(bucketingId, experimentKey, variant)` and fire only for exposure-eligible reads:

```ts
createAbClient({
  appKey: 'web',
  onExposure: (e) => analytics.track('Experiment Viewed', e),
})
```

In React, exposure fires from an effect **after commit** (never during render); a
StrictMode double-invoked effect is absorbed by the dedupe. Pass `{ track: false }` to a
hook or read for a side-effect-free peek.

## Architecture

Core (framework-agnostic) ↔ adapters (storage / remote transport / cross-tab) ↔ React.
See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for diagrams and
**[docs/BEHAVIOR_CONTRACT.md](docs/BEHAVIOR_CONTRACT.md)** for the testable runtime
contract. Key decisions are recorded in **[docs/adr/](docs/adr/)** and
**[docs/DECISIONS.md](docs/DECISIONS.md)**.

## Project structure

```text
src/
  index.ts            core entry (no React)
  core/               types, hash, config validation, assignment pipeline,
                      persistence, remote transport, overrides, exposure, cross-tab, client
  react/              AbTestingProvider, useExperiment, useFeatureFlag (use client)
  testing/            mock remote transport
server/               demo control plane (Node http + ws)
playground/           runnable React console + admin panel (Vite)
tests/                unit + integration (Vitest)
docs/                 architecture, behavior contract, decisions, ADRs, testing
```

## Running the demo

```bash
git clone <repo> && cd ab-testing-library
npm ci
npm run server   # terminal 1 — control plane on :8787
npm run dev      # terminal 2 — playground console on :5173
```

Open the console, initialize a user, then edit the split / enabled state / rollout in the
admin panel — the change is `PUT` to the backend, broadcast over WebSocket, and the
running SDK updates live.

## Scripts

| script | purpose |
| --- | --- |
| `npm run dev` | playground app (Vite) |
| `npm run server` | demo control plane |
| `npm test` | unit + integration tests (Vitest) |
| `npm run typecheck` | `tsc --noEmit` (app + node projects) |
| `npm run lint` | ESLint (flat config) |
| `npm run build` | dual ESM/CJS + `.d.ts` (tsup) |
| `npm run publint` / `npm run attw` | package-publish validation |
| `npm run size` | bundle-size budget |

## Testing

198 tests cover the assignment pipeline (every reason branch), the MurmurHash3
implementation (known vectors + a 100k-id distribution test), persistence recovery,
remote config, cross-tab sync, exposure, the React hooks, and the backend. The suite
mirrors the behavior contract branch-for-branch — see **[docs/TESTING.md](docs/TESTING.md)**.

## Limitations

This is a focused v1 with deliberate boundaries:

- **Local persistence is per-device.** True cross-device sticky assignment requires a
  server-side assignment store (reserved extension).
- **Remote config is full-replace only** — no patch/delta protocol or heartbeat.
- **Reserved (not built):** layers / mutual-exclusion groups, server-side assignment
  store, flag prerequisites, a full consent manager, advanced traffic allocation. See
  [docs/DECISIONS.md](docs/DECISIONS.md) for the rationale and the
  Implemented / Simplified / Reserved ledger.

## Troubleshooting

- **`AB_E_NOT_INITIALIZED` thrown by `getVariant`** — call `initializeUser` first. (React
  hooks return a safe `DEFAULT_FALLBACK` instead of throwing.)
- **Admin panel shows "Backend unreachable"** — start the control plane with `npm run server`.
- **`isReady` stays `false`** — a remote is configured but no `config.replace` has been
  received yet; the app still evaluates against the bootstrap/cached config.
- **Variant didn't change after editing the split** — assignments are sticky. Use a new
  user, "Re-roll assignment", or toggle the experiment's enabled state (which applies to
  everyone immediately).

## License

[MIT](LICENSE)
