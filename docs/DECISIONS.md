# Decisions

Date: 2026-06-04

This document records architectural decisions and scope boundaries. The goal is to satisfy the assignment requirements without sprawling into an unfinished feature-flag platform.

## Decision Principle

We are not building a mini LaunchDarkly, but a production-shaped frontend A/B SDK:

- deterministic assignment;
- sticky local persistence;
- React integration;
- protected config backend;
- realtime full config replace;
- admin/mock editing;
- exposure tracking;
- tests, packaging and docs.

Criterion: every implemented part addresses a direct requirement or a real review question. Everything else is reserved as an extension point.

## Implemented Now

### SDK Shape

- `createAbClient()` instead of a hidden global singleton.
- Multiple independent experiments.
- Feature flags through the same evaluation pipeline.
- Factory-first architecture for SSR, tests and multi-instance use cases.
- `subscribe(listener) -> unsubscribe` for React adapter and imperative consumers.
- An optional client-side singleton can be added as sugar, but is not the foundation.

Why:

- SSR must not share user state between requests.
- Tests get independent instances.
- The host application may have multiple environments or namespaces.

### Assignment

- MurmurHash3 x86 32-bit.
- Correct JS 32-bit arithmetic via `Math.imul` and `>>> 0`.
- `hashVersion` in persisted assignment.
- Per-experiment `seed`.
- `bucketingId` as randomization/provenance id.
- Key-sorted variants before bucketing.
- Relative variant weights.
- Sticky provenance validation.

Why:

- Assignment is synchronous, portable and deterministic.
- `hashVersion` makes an algorithm change an explicit rerandomization event.
- `seed` separates the public experiment key from the randomization salt.
- `bucketingId` prepares the SDK for a future server-side assignment store.

### Sticky Semantics

- Weight change keeps existing valid sticky assignment.
- Disabled experiment returns control and keeps assignment.
- Removed experiment clears assignment.
- Removed variant recomputes or falls back to control.
- Seed/hashVersion change recomputes.

Why:

- Pure deterministic hash is not sticky when split boundaries change.
- Sticky behavior must be explicit and testable.

### Runtime Reason Model

- Runtime `reason` is returned from `getAssignment()`.
- Persisted assignment stores provenance, not runtime reason.
- `VARIANT_REMOVED_REASSIGNED` and `VARIANT_REMOVED_FALLBACK` are separate reasons.

Why:

- Persisted `reason` becomes stale across sessions.
- Runtime reason powers debug UI, tests and exposure eligibility.

### Exposure Tracking

- Pluggable `onExposure`.
- Typed `ExposureEvent` payload with no raw PII.
- In-memory dedupe per client/session.
- `track: false` for admin/QA/debug peek.
- React exposure only after commit.
- StrictMode double invoke deduped.

Why:

- A/B testing without exposure events is not measurable.
- React concurrent render must remain side-effect free.

### Observability

- Pluggable `logger`.
- Pluggable `onEvent(event)` for SDK lifecycle/debug/error events.
- Structured error/event codes.
- All callbacks are wrapped and never throw into the host app.

Why:

- The requirement explicitly calls out logging extensibility.
- Consumers need structured diagnostics without scraping free-form strings.

### User And Privacy

- Bucket by `id`, not `email`.
- Raw email is not persisted.
- Caller-provided `traits` are memory-only and are not persisted.
- Anonymous id support.
- Anonymous id uses `crypto.randomUUID()` when available, with fallback when unavailable.
- `anon -> known` keeps already assigned experiment stickiness.
- `known -> different known` resets assignments by default.
- `reset()` / `clear()` removes user, assignments and config cache.
- `createAbClient({ persistence: "local" | "memory", tracking: boolean })`.

Why:

- Email / trait persistence is a PII risk.
- Local sticky assignment is per-device.
- Logout/right-to-clear flows need a full reset.
- Privacy-aware toggles are cheap and valuable.

### Persistence

- Storage adapter abstraction.
- LocalStorage default.
- In-memory fallback.
- All storage access guarded with try/catch.
- Corrupted storage recovers safely.
- `appKey` prefixes storage keys to avoid app/environment collisions.
- Unsupported `schemaVersion` is safely discarded in v1; migrations are reserved.
- Last-known config and config version persisted for bootstrap.

Why:

- Browser storage can be unavailable, disabled, quota-limited or corrupted.
- Bootstrap config reduces flicker for returning users.

### Readiness And SSR

- Readiness states: `uninitialized -> initialized(bootstrap) -> live(remote synced)`.
- `useSyncExternalStore` for React integration.
- Stable memoized snapshots.
- Safe `getServerSnapshot`.
- React hooks do not throw before init/SSR; they return control fallback with `isReady=false`.
- Imperative API can throw for contract violations.
- React subpath includes `"use client"`.
- Core has no React imports.

Why:

- SSR and Next.js are common React integration targets in 2026.
- Hydration must not crash.
- Render must stay pure.

### Remote Config

- Full `config.replace` only.
- Monotonic server-owned `version`.
- Client persists `lastAppliedVersion`.
- Incoming config applies only when `version > lastAppliedVersion`.
- Reconnect receives latest full snapshot.
- Stale/replayed updates ignored.
- Connection status events for UI.

Why:

- Full replace makes experiment removal unambiguous.
- It avoids patch ambiguity, gap detection and delta replay.
- It is more reliable for v1 while still production-shaped.

### Backend

- Public config read endpoint.
- Public WebSocket config stream.
- Protected admin write endpoint with bearer admin token.
- Server-side payload validation.
- Monotonic version increment on accepted mutation.
- Health endpoint.
- No raw PII in logs.
- In-memory store is allowed for assignment scope, but shaped as a control plane.

Why:

- The task asks for remote control and protected backend expectations.
- Admin mutation must be genuinely protected, not hand-waved.

### Cross-Tab Sync

- Browser `storage` events implemented.
- `BroadcastChannel` used when available.
- Incoming tab messages update memory without echoing back to storage.

Why:

- Storage events are required.
- BroadcastChannel is a cleaner modern primitive.
- Anti-loop behavior must be explicit.

### Admin And Debug

- Admin override is a separate config layer.
- Remote updates do not erase admin overrides.
- `setAdminOverride()` / `clearAdminOverride()` manage the admin layer.
- `setForcedOverride()` / `clearForcedOverride()` manage QA forced variants.
- URL helper parses `ab_force_` parameters without making URL parsing implicit core magic.
- `getDebugState()` exposes read-only SDK state.
- Admin/mock page can live-edit split and enabled state.

Why:

- QA/admin controls should not be overwritten by remote refresh.
- Forced overrides are read-time only and never persisted.
- Surfacing assignment reasons is needed for debugging in real use.

### Quality Gates

- ESLint flat config.
- Strict TypeScript.
- Vitest unit tests.
- React hook tests.
- Backend tests.
- Pre-commit: staged ESLint + related tests.
- Optional pre-push: typecheck + full tests.
- CI: lint, typecheck, test, build, publint, arethetypeswrong, size limit.
- Dual package output with typed exports.

Why:

- Reviewers will run from a clean clone first.
- Packaging quality is visible immediately in a library submission.

## Simplified For V1

### Full Replace Instead Of Patch

Implemented:

```ts
{ type: "config.replace", version, config }
```

Not implemented:

- field-level patches;
- delta replay;
- gap detection;
- `version == last + 1` enforcement.

Reason:

- Full replace is less ambiguous.
- Experiment removal is deterministic.
- Reconnect is simpler: server sends current full snapshot.

### Reconnect Without Heartbeat

Implemented:

- reconnect with backoff and jitter;
- server sends full snapshot on connect/reconnect;
- connection status events.

Not implemented:

- heartbeat ping/pong;
- half-open detection protocol.

Reason:

- Heartbeat is valuable in production systems but not necessary for this v1 assignment.

### Consent

Implemented:

- `persistence: "memory"` option;
- `tracking: false` option;
- full `reset()` / `clear()`.

Not implemented:

- dynamic `setConsent()` state machine;
- full consent manager.

Reason:

- Privacy-aware primitives are useful now.
- A full consent manager is product scope, not SDK core scope.

## Reserved Extensions

These are intentionally not implemented in v1. Their shape may appear in types/docs only where it prevents future breaking changes.

- Layers and mutual exclusion groups.
- Server-side assignment store for cross-device sticky assignment.
- Feature flag prerequisites.
- Dynamic consent state machine.
- Field-level config patches.
- Heartbeat/ping-pong protocol.
- Vector clocks and multi-writer config control.
- Analytics integrations beyond `onExposure`.
- Advanced traffic allocation and holdout engine.

## Requirement Mapping

| Requirement | Decision |
| --- | --- |
| Multiple experiments | Core config supports independent experiment keys |
| Initialize/update user | `initializeUser`, `updateUser`, identity contract |
| Sticky assignment | Persisted provenance + sticky matrix |
| Deterministic assignment | MurmurHash3 + seed + hashVersion |
| Respect split percentage | Relative weighted variants |
| Local persistence | Storage adapter + localStorage + memory fallback |
| Rehydrate state | User, assignments, config cache and version restore |
| Realtime updates | WebSocket full `config.replace` |
| Enable/disable | Evaluation pipeline disabled branch |
| Helpful errors | Error codes + fail-open policy |
| Edge cases | Behavior contract and tests mirror every branch |
| Extensibility | Logger/exposure/storage/transport boundaries |
| Logging plugin support | `logger` + `onEvent` structured callbacks |
| QA/admin override mode | Forced overrides + admin override layer |
| Feature flags | Flags use the same evaluation pipeline |
| Cross-tab sync | Storage events + BroadcastChannel |
| Admin interface | Protected backend + admin/mock page |
| Public subscriptions | `subscribe(listener)` for hooks and imperative consumers |
| Pre-commit | lint-staged + related unit tests |
| React integration | Provider/hooks with SSR-safe external store |
| Future scalability | Factory-first, typed exports, reserved extensions |

## Non-Goals For V1

- We do not claim cross-device sticky assignment without a backend assignment store.
- We do not implement a full experimentation analytics backend.
- We do not implement RBAC/OIDC in the demo admin backend.
- We do not implement a full consent-management platform.
- We do not implement multi-writer distributed config coordination.

## Review Checklist

Before final submission:

- Clean clone can install dependencies.
- Example app starts.
- Backend starts.
- Admin page updates config live.
- WebSocket update changes SDK state.
- Tests pass.
- Typecheck passes.
- Lint passes.
- Build passes.
- README quickstart works in under 60 seconds.
- README documents the limitations explicitly.
- `BEHAVIOR_CONTRACT.md` and tests match branch-for-branch.
