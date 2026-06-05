# Behavior Contract

Date: 2026-06-04

This document captures the behavior of the A/B testing SDK as a testable contract. The implementation and unit tests must mirror this contract branch-for-branch.

## Core Principle

Key principles of the SDK:

- do not crash the host application due to runtime/config/network problems;
- preserve deterministic and sticky assignment within a device;
- explicitly separate implemented behavior from future extensions;
- keep the React render pure, and run analytics side effects only after commit;
- honestly document the boundaries: local persistence is not the same as a cross-device assignment store.

## Public Runtime Surfaces

### Imperative Core API

- `createAbClient(options)` creates an independent client instance.
- `initializeUser(userData, options?)` initializes the user session and assignment context.
- `updateUser(userData, options?)` updates user state; reassignment happens only with an explicit `reassignVariant: true`.
- `getAssignment(experimentKey, options?)` returns the full evaluation information.
- `getVariant(experimentKey, options?)` returns only the variant key and may track exposure.
- `isFeatureEnabled(flagKey, options?)` uses the same evaluation pipeline as experiments.
- `setConfig(config)` applies the base/default config.
- `setAdminOverride(partialConfig)` applies an admin/debug override layer on top of the remote/default config.
- `clearAdminOverride(key?)` clears the admin override for a single key or for the entire layer.
- `setForcedOverride(key, variant)` applies a QA/URL forced override for read-time evaluation.
- `clearForcedOverride(key?)` clears the forced override for a single key or for the entire layer.
- `loadForcedOverridesFromUrl(searchParams, options?)` parses URL overrides, for example `?ab_force_checkout=B`.
- `subscribe(listener)` subscribes imperative consumers and the React adapter to store changes; returns `unsubscribe`.
- `resetAssignment(experimentKey)` clears the assignment of a single experiment.
- `reset()` / `clear()` clears user, assignments, exposure state and overrides. If a
  live remote config has already synced in this runtime, that non-PII config snapshot
  remains available so re-initializing a user does not get stuck in `isReady=false`.
- `destroy()` closes transports, storage listeners and the cross-tab channel.
- `getDebugState()` returns a read-only snapshot for the admin/debug UI.

### React API

- `AbTestingProvider` provides a stable client instance.
- `useExperiment(experimentKey)` reads the assignment through an SSR-safe external store.
- `useFeatureFlag(flagKey)` reads the feature flag through the same store.
- The React adapter does not perform side effects during render.
- Exposure from React is dispatched only in `useEffect` after commit.

## Assignment Record

The persisted assignment stores provenance, not the runtime reason.

```ts
type PersistedAssignment = {
  experimentKey: string;
  variantKey: string;
  bucketingId: string;
  hashVersion: string;
  seed: string;
  assignedAt: string;
  assignedBy: "computed" | "server";
};
```

Why `reason` is not stored:

- on the first computation the runtime reason may be `COMPUTED`;
- on the next session the same assignment is already evaluated as `STICKY`;
- a persisted `reason` would become stale and would mislead debug/analytics.

## Runtime Assignment Result

```ts
type AssignmentReason =
  | "STICKY"
  | "COMPUTED"
  | "FORCED_OVERRIDE"
  | "EXPERIMENT_DISABLED"
  | "EXPERIMENT_NOT_FOUND"
  | "VARIANT_REMOVED_REASSIGNED"
  | "VARIANT_REMOVED_FALLBACK"
  | "NOT_IN_EXPERIMENT"
  | "DEFAULT_FALLBACK";

type AssignmentSource = "computed" | "server" | "forced" | "default";

type AssignmentResult = {
  experimentKey: string;
  variant: string;
  reason: AssignmentReason;
  source: AssignmentSource;
  isReady: boolean;
  trackable: boolean;
};
```

Forward compatibility notes:

- `source="server"` is reserved for a future server-side assignment store.
- `NOT_IN_EXPERIMENT` is reserved for a future traffic-allocation/holdout engine.

## Evaluation Pipeline

`getAssignment(key)` must follow a single deterministic pipeline:

```text
1. effectiveConfig = merge(default -> persisted bootstrap -> remote@version -> adminOverride)
2. forced override exists for key?
   -> FORCED_OVERRIDE, source=forced, do not persist, do not track
3. experiment missing from effectiveConfig?
   -> EXPERIMENT_NOT_FOUND, variant=fallbackVariant, fail-open
4. experiment disabled?
   -> EXPERIMENT_DISABLED, variant=control, keep existing persisted assignment
5. persisted assignment exists?
   5a. hashVersion and seed match, stored bucketingId is valid, and variant exists
       -> STICKY
   5b. persisted variant was removed
       -> VARIANT_REMOVED_REASSIGNED if recompute yields valid variant
       -> VARIANT_REMOVED_FALLBACK if fallback/control is used
   5c. seed or hashVersion changed
       -> recompute and persist new assignment -> COMPUTED
6. no persisted assignment
   -> bucket with MurmurHash3(seed:bucketingId), persist provenance -> COMPUTED
7. future traffic allocation holdout
   -> NOT_IN_EXPERIMENT, variant=control
```

## Provenance Invariant

An assignment remains sticky only while its provenance matches current evaluation inputs:

- `hashVersion` matches current hashing algorithm;
- `seed` matches the experiment seed;
- `bucketingId` is present and records the identity used when this assignment was created;
- `variantKey` still exists in current experiment config.

Seed/hash mismatches are treated as stale provenance and trigger recomputation. A stored
`bucketingId` is intentionally retained for already-created assignments, including the
documented `anon -> known` identity-stitching case below.

## Hashing Contract

- Use MurmurHash3 x86 32-bit.
- JS implementation must use `Math.imul` and unsigned coercion (`>>> 0`) for correct 32-bit arithmetic.
- Bucket input is `seed + ":" + bucketingId`.
- Bucket range is derived from unsigned hash: `hash / 2^32`.
- Variants are sorted by key before cumulative weighting so JSON order cannot reshuffle assignments.
- Weights are treated as relative weights, not necessarily percentages summing to 100.
- `hashVersion` is part of assignment provenance; changing the algorithm is an explicit rerandomization event.
- Tests must include known hash vectors, golden assignment snapshots, and distribution checks.

## Config Hygiene

- Zero-weight variants are valid and mean paused variants.
- Empty variants, negative weights, invalid shapes, or invalid seeds fail-open with warning.
- Invalid experiment config is treated as disabled/fallback, not as a host-app crash.
- Remote config is untrusted input and must be runtime-validated.
- Core validators stay lightweight and zero-dependency.

## Sticky Matrix

| Event | Behavior | Runtime Reason |
| --- | --- | --- |
| Split/weight changed | Keep valid persisted assignment | `STICKY` |
| Variant removed | Recompute or fallback/control | `VARIANT_REMOVED_REASSIGNED` / `VARIANT_REMOVED_FALLBACK` |
| Experiment disabled | Return control, keep persisted assignment | `EXPERIMENT_DISABLED` |
| Experiment removed | Clear assignment and return control | `EXPERIMENT_NOT_FOUND` |
| Seed changed | Recompute and persist | `COMPUTED` |
| Hash version changed | Recompute and persist | `COMPUTED` |

## Exposure Tracking

Exposure is a first-class SDK behavior because A/B tests must be measurable.

```ts
type ExposureEvent = {
  experimentKey: string;
  variant: string;
  reason: AssignmentReason;
  source: AssignmentSource;
  bucketingId: string;
  configVersion?: number;
  timestamp: string;
};
```

- `onExposure(event)` is pluggable.
- Exposure events must not contain raw email or other PII.
- Exposure is deduped in-memory per client/session by `(bucketingId, experimentKey, variant)`.
- Exposure dedupe is not persisted; analytics should receive exposure per session.
- `getAssignment(key, { track: false })` and `getVariant(key, { track: false })` allow safe peek/debug reads.
- React hooks never fire exposure during render; they fire after commit in `useEffect`.
- StrictMode double effects are handled by in-memory dedupe.

Trackable reasons:

- `STICKY`
- `COMPUTED`
- `VARIANT_REMOVED_REASSIGNED`
- `VARIANT_REMOVED_FALLBACK`

Non-trackable reasons:

- `FORCED_OVERRIDE`
- `EXPERIMENT_DISABLED`
- `EXPERIMENT_NOT_FOUND`
- `NOT_IN_EXPERIMENT`
- `DEFAULT_FALLBACK`

## User Identity Contract

- Randomization unit is `id`, not `email`.
- Raw email is not persisted to localStorage.
- Caller-provided `traits` are memory-only and are not persisted to localStorage.
- Anonymous users can get a generated anonymous id.
- Anonymous id generation uses `crypto.randomUUID()` when available and a non-cryptographic fallback only when secure random UUIDs are unavailable.
- `bucketingId` records which id was used for assignment.
- `anon -> known` keeps existing sticky assignments for already assigned experiments and preserves their `bucketingId`.
- New experiments after login may use the known user id as bucketing id.
- `known -> different known` is treated as a different person in the same browser and should reset assignments unless explicitly configured otherwise.
- `updateUser(..., { reassignVariant: true })` explicitly recomputes assignments for the active bucketing id.

## Readiness And Bootstrap

State machine:

```text
uninitialized -> initialized(bootstrap) -> live(remote synced)
```

- The SDK rehydrates persisted user, assignments, cached config and cached config version synchronously when possible.
- Last-known config is used as bootstrap cache to reduce flicker for returning users.
- First-ever visitors cannot be made flicker-free by a client-only SDK without blocking render.
- `isReady = initialized && (remoteOff || syncedAtLeastOnce)`.
- `syncedAtLeastOnce` flips on receiving any valid `config.replace` from the server — including one whose `version` equals the cached version (the server confirms the cache is current). Lower (stale) versions are still ignored and reported as `AB_E_REMOTE_STALE`. This keeps a returning user from being stuck not-ready when its cached version already matches the server's. Remote versions are monotonic and may start at `0`.
- Apps can use `isReady` to choose skeleton, hold render, or accept control-to-variant flip.

## SSR And React Contract

- Core package must not import React.
- React entry must be a separate subpath and include `"use client"`.
- `useSyncExternalStore` is required for SSR/hydration safety.
- `getServerSnapshot` always returns a safe default snapshot and never throws.
- `getSnapshot` must return stable references using memoized snapshots/version counters.
- Imperative `getVariant()` before initialization may throw as a contract error.
- React `useExperiment()` before initialization or during SSR must not throw; it returns control with `isReady=false` and `reason=DEFAULT_FALLBACK`.

## Persistence Contract

- Storage is adapter-based.
- `appKey` prefixes storage keys to avoid collisions across apps and environments.
- Default persistence is `localStorage` when available.
- Every storage operation is guarded with try/catch.
- If localStorage is unavailable, corrupted, quota-limited, or disabled, SDK falls back to in-memory storage.
- Persisted payloads are versioned with `schemaVersion`.
- In v1, unsupported schema versions are safely discarded with a warning; migrations are reserved for later versions.
- `createAbClient({ persistence: "memory" })` disables local persistence explicitly.
- `createAbClient({ tracking: false })` disables exposure callbacks.
- `reset()` / `clear()` removes user, assignments, overrides and exposure state. A
  live-synced remote config snapshot may remain in memory because it is not user data.

## Observability Contract

- `logger` can be provided to receive structured warnings, errors and debug messages.
- `onEvent(event)` can be provided for SDK lifecycle events.
- `onExposure(event)` remains the dedicated analytics hook for exposure events.
- Logger and event callbacks are wrapped; they never throw into the host app.
- Error/event payloads use structured codes rather than relying on free-form strings.

## Cross-Tab Contract

- Required path: browser `storage` events.
- Preferred path when available: `BroadcastChannel`.
- Incoming cross-tab updates update in-memory state without writing back to storage.
- This prevents echo loops.
- Cross-tab sync reflects persisted assignments and cached config/version for the same
  storage namespace.
- Each tab keeps its own active user/session context; assignments from a different
  persisted user are ignored during sync.
- Forced and admin overrides are in-memory per-tab QA/debug layers in v1 and are not
  synchronized across tabs.

## Remote Config Contract

V1 uses full replace only.

```ts
type ConfigReplaceMessage = {
  type: "config.replace";
  version: number;
  config: RemoteConfig;
};
```

- Server owns monotonic `version`.
- Client persists cached config and cached version.
- On boot, cached version initializes `lastAppliedVersion`.
- Client applies incoming config only when `incoming.version > lastAppliedVersion`.
- Stale or repeated config messages are ignored.
- On connect/reconnect, server sends the latest full `config.replace`.
- No field-level patches in v1.
- No delta replay or gap detection in v1.

## Backend Contract

- Public config read endpoint exposes non-sensitive config only.
- Public WebSocket endpoint streams `config.replace`.
- Protected admin write endpoints require bearer admin token.
- Server validates every admin payload.
- Server increments config version on accepted mutation.
- Admin writes with stale current version should return conflict when optimistic concurrency is used.
- Logs must not include raw PII.
- Server store can be in-memory for this assignment but must be shaped like a real control plane.

## Feature Flags

Feature flags reuse the same evaluation pipeline.

- A percentage rollout flag is modeled as a two-variant experiment: `on` / `off`.
- `isFeatureEnabled(flagKey)` is a wrapper around assignment evaluation.
- Flag assignments are sticky and provenance-backed.
- Flag prerequisites are reserved for a future extension.

## Error Policy

- Contract violations can throw in imperative API.
- Runtime/config/storage/network errors fail-open with warning and structured error codes.
- Async callbacks, transports, exposure hooks and storage listeners never throw into the host app.
- Strict mode may turn selected warnings into throws for dev/tests.

Error codes:

- `AB_E_NOT_INITIALIZED`
- `AB_E_STORAGE_CORRUPT`
- `AB_E_CONFIG_INVALID`
- `AB_E_TRANSPORT_FAILED`
- `AB_E_EXPERIMENT_NOT_FOUND`
- `AB_E_VARIANT_INVALID`
- `AB_E_REMOTE_STALE`
- `AB_E_ADMIN_AUTH`

## Defaults

- `fallbackVariant` defaults to `"control"`.
- `urlOverridePrefix` defaults to `"ab_force_"`.
- `persistence` defaults to `"local"`.
- `tracking` defaults to `true`.

## Testing Contract

Tests must map to this document:

- pipeline branch tests for every `AssignmentReason`;
- sticky matrix tests;
- provenance staleness tests for `hashVersion`, `seed`, `variant removed`;
- MurmurHash3 known vectors;
- golden assignment snapshots;
- distribution test over 100k ids with tolerance;
- storage corruption and memory fallback;
- storage key namespacing through `appKey`;
- unsupported schema version safe-discard;
- remote stale version ignored;
- full config replace applies;
- admin override survives remote update;
- forced override returns `FORCED_OVERRIDE` and does not persist;
- URL forced override helper parses configured prefix;
- exposure eligibility and dedupe;
- React render does not track;
- React effect tracks after commit;
- StrictMode double effect is deduped;
- SSR/default snapshot does not throw;
- `subscribe()` notifies consumers and returns working unsubscribe;
- cross-tab sync updates memory without storage echo loops;
- identity stitching: anon -> known keeps existing sticky assignments;
- identity stitching: new experiments after login use known bucketing id;
- identity stitching: known -> different known resets assignments;
- reset/clear removes persisted state;
- backend auth and validation.
