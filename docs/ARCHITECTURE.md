# Architecture

A framework-agnostic core surrounded by thin, swappable adapters, with React as one
consumer. The core never imports React; the backend is a separate demo control plane.

## Layers

```mermaid
flowchart TD
  subgraph react["ab-testing-library/react  (use client)"]
    P[AbTestingProvider] --> H1[useExperiment]
    P --> H2[useFeatureFlag]
  end

  subgraph core["ab-testing-library  (framework-agnostic core)"]
    C[AbTestingClient]
    C --> A[assignment pipeline]
    C --> O[override layer]
    C --> X[exposure tracker]
    A --> HSH[hash · MurmurHash3]
    A --> V[config validation]
  end

  subgraph adapters["adapters"]
    S[storage adapter\nlocalStorage / memory]
    R[remote transport\nWebSocket / mock]
    XT[cross-tab\nstorage events + BroadcastChannel]
  end

  subgraph backend["server/  (demo control plane)"]
    EP[GET /config · WS /config/stream · PUT /admin/config]
  end

  H1 -->|peek / subscribe| C
  H2 -->|peek / subscribe| C
  C --> S
  C --> R
  C --> XT
  R <-->|config.replace| EP
  X -->|onExposure| SINK[analytics sink]
```

The React adapter only ever calls the client's side-effect-free `peek*` reads during
render and `subscribe` for updates; it imports core *types* only, so the React bundle
carries no core runtime.

## Evaluation pipeline

`getAssignment(key)` is a single deterministic pipeline. Each branch maps to exactly one
runtime `reason` (and exposure eligibility). The pure function lives in
`src/core/assignment.ts`; the client applies the resulting persist/clear side effects.

```mermaid
flowchart TD
  start([getAssignment / peek]) --> forced{forced override?}
  forced -->|yes| F[FORCED_OVERRIDE\nno persist · no track]
  forced -->|no| eff[effective config =\nbase/cached → admin overlay]
  eff --> found{experiment present?}
  found -->|no| NF[EXPERIMENT_NOT_FOUND → fallback\nclear stored record only if isReady]
  found -->|yes| en{enabled?}
  en -->|no| DIS[EXPERIMENT_DISABLED → control\nkeep stored record]
  en -->|yes| has{stored assignment?}
  has -->|no| COMP[COMPUTED\nbucket by seed:currentId · persist]
  has -->|yes| prov{provenance valid?\nhashVersion & seed match}
  prov -->|yes, variant exists| ST[STICKY]
  prov -->|variant removed| RR[recompute under stored id →\nREASSIGNED or FALLBACK]
  prov -->|seed/hash changed| RC[COMPUTED\nre-randomize under stored id]
```

**Provenance invariant.** A persisted assignment stores the inputs it was computed from
(`bucketingId`, `hashVersion`, `seed`). Stickiness holds only while those still match the
current config; any mismatch is detected and triggers a rule-based recompute. This is why
changing a split never churns already-assigned users, while changing a `seed` (or
`HASH_VERSION`) deliberately re-randomizes them.

## Identity & bucketing

- Randomization unit is `id`; `email` is in-memory only and never persisted or bucketed.
- No `id` → an anonymous id is generated (`crypto.randomUUID()` with a non-secure fallback).
- `anon → known` keeps existing assignments under their original `bucketingId`; new
  experiments use the known id. `known → different known` resets assignments.
- Recomputes use the *stored* `bucketingId` (identity continuity); first-time assignments
  use the current one. `bucketingId` is also the seam for a future server-side store.

## Remote config & readiness

```mermaid
sequenceDiagram
  participant App
  participant Client
  participant Storage
  participant WS as Control plane
  App->>Client: createAbClient({ remote })
  Client->>Storage: rehydrate cached config + version
  Client->>WS: connect (backoff + jitter on retry)
  App->>Client: initializeUser(user)
  Note over Client: isReady=false (remote configured, not synced)
  WS-->>Client: config.replace { version, config }
  alt version > lastApplied
    Client->>Storage: persist cached config + version
    Client-->>App: config.updated · ready
  else version <= lastApplied
    Client-->>App: AB_E_REMOTE_STALE (already current → mark synced)
  end
  Note over Client: isReady=true once a valid config is confirmed
```

Readiness: `uninitialized → initialized(bootstrap) → live(synced)`. With no remote,
ready == initialized. With a remote, ready flips once a valid `config.replace` confirms
sync — including a same-version snapshot that confirms the cached config is current.

## Cross-tab sync

A change persisted in one tab is signalled to others via `BroadcastChannel` (preferred)
and `storage` events (required path). Receivers re-read storage into memory only and never
write back, so there is no echo loop. Each tab keeps its own active user; only experiment
data (assignments, cached config/version) syncs.

## React store

Hooks subscribe via `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`:

- `getSnapshot` returns a per-key memoized, referentially-stable result (via the client's
  pure `peekAssignment` / `peekFeatureFlag`), so an unrelated experiment changing does not
  re-render the component.
- `getServerSnapshot` always returns the safe default → crash-free SSR/hydration; the
  store then reconciles to the live value after hydration.
- Render is pure; exposure fires from a post-commit `useEffect` (StrictMode's double
  invocation is absorbed by the in-memory dedupe).

## Packaging

`./` (core) and `./react` are independent entry points. React is an optional peer
dependency and is externalized from the build, so a non-React consumer never pulls React.
Built as dual ESM/CJS with per-condition `.d.ts` / `.d.cts`, `"sideEffects": false`, and
validated by `publint` + `arethetypeswrong`. Zero runtime dependencies.
