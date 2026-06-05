# Testing

Tests mirror [`BEHAVIOR_CONTRACT.md`](./BEHAVIOR_CONTRACT.md) branch-for-branch. The
suite (Vitest, jsdom) is **190+ tests across 14 files**.

```bash
npm test            # run once
npm run test:watch  # watch mode
```

## Philosophy

- **Pure first.** The assignment pipeline and hashing are pure functions tested in
  isolation, then again through the client — so a failure points at the layer, not the
  integration.
- **Statistical, not hand-waved.** Hashing correctness is proven, not asserted: the
  implementation is cross-checked against canonical mmh3 vectors, pinned with golden
  snapshots (which enforce `HASH_VERSION` discipline — change the hash and CI goes red),
  and validated with a 100k-id distribution test (±1% tolerance) plus an independence
  test (no carryover between experiments).
- **Determinism.** No `Math.random`/time in assertions; the WebSocket reconnect test uses
  fake timers; `BroadcastChannel` is tested with an in-process mock; `storage` events are
  driven by explicit `dispatchEvent`.
- **Real paths.** The backend is tested over a real socket (`listen(0)` + `fetch` + a `ws`
  client); the playground app is tested via React Testing Library with the SDK injected and the
  backend `fetch` mocked.

## Coverage by area

| File | Area |
| --- | --- |
| `hash.test.ts` | MurmurHash3 vectors, determinism, unsigned range, distribution, independence, golden buckets |
| `config.test.ts` | zero-dependency validators, config hygiene, prototype-pollution guard |
| `assignment.test.ts` | every pipeline branch / reason, provenance staleness, sticky matrix |
| `client.test.ts` | init/update, identity transitions, persistence, fail-open, subscriptions, reset |
| `persistence.test.ts` | memory + local adapters, corruption/schema/quota recovery, namespacing |
| `featureFlags.test.ts` | flag → on/off experiment, rollout, stickiness |
| `exposure.test.ts` | dedupe, eligibility, `track:false` / `tracking:false`, throwing sink |
| `overrides.test.ts` | forced + admin overrides, URL parsing, precedence |
| `storageSync.test.ts` | storage-event + BroadcastChannel sync, anti-loop |
| `remoteConfig.test.ts` | readiness, version monotonicity, fail-open, reconnect, connection status, cross-tab |
| `reactHooks.test.tsx` | provider, hooks, SSR snapshot, render purity, commit-time exposure, StrictMode dedupe |
| `server.test.ts` | health, public config, admin auth, validation, version, WS broadcast, body limit |
| `playgroundApp.test.tsx` | console smoke, init flow, gated sections, activity log, admin PUT shape + conflict recovery, no-email persistence |
| `smoke.test.ts` | entry points importable, core has no React, `"use client"` on the React entry |

## Contract conformance

Every section of the behavior contract maps to implementation and tests:

| Contract section | Implementation | Tests |
| --- | --- | --- |
| Hashing contract | `core/hash.ts` | `hash.test.ts` |
| Config hygiene | `core/config.ts` | `config.test.ts` |
| Evaluation pipeline + sticky matrix | `core/assignment.ts` | `assignment.test.ts`, `client.test.ts` |
| Provenance invariant | `core/assignment.ts` + `PersistedAssignment` | `assignment.test.ts` |
| Exposure tracking | `core/exposure.ts` | `exposure.test.ts`, `reactHooks.test.tsx` |
| User identity contract | `core/abTestingClient.ts` | `client.test.ts` |
| Readiness & bootstrap | `core/abTestingClient.ts` | `remoteConfig.test.ts` |
| SSR & React contract | `react/*` | `reactHooks.test.tsx`, `smoke.test.ts` |
| Persistence contract | `core/persistence.ts` | `persistence.test.ts` |
| Cross-tab contract | `core/storageSync.ts` | `storageSync.test.ts` |
| Remote config contract | `core/remote.ts` + client | `remoteConfig.test.ts` |
| Backend contract | `server/*` | `server.test.ts` |
| Feature flags | `core/featureFlags.ts` | `featureFlags.test.ts` |
| Error policy / codes | `core/errors.ts` | across client/remote/server tests |
| Defaults | `core/abTestingClient.ts` | `hash.test.ts` (`HASH_VERSION`), `client.test.ts` |

Reserved contract values (`NOT_IN_EXPERIMENT`, `source: "server"`) are intentionally not
emitted in v1; they exist for forward compatibility (see `DECISIONS.md`).
