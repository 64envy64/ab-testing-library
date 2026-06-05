# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-05

Initial release — a framework-agnostic A/B testing & feature-flag core with a React
adapter, real-time remote config, a demo control plane, and a runnable playground.

### Added

- **Core client** (`createAbClient`): `initializeUser` / `updateUser`, `getAssignment` /
  `getVariant`, `isFeatureEnabled`, side-effect-free `peekAssignment` / `peekFeatureFlag`,
  `setConfig`, `reset` / `clear`, `getDebugState`, `subscribe`, `destroy`.
- **Deterministic assignment**: MurmurHash3 x86 32-bit (`Math.imul`, unsigned), versioned
  via `HASH_VERSION`; weighted variants over key-sorted ranges; per-experiment `seed`.
- **Sticky provenance**: persisted records carry `bucketingId` / `hashVersion` / `seed`;
  any input change is detected and triggers a rule-based recompute (sticky matrix).
- **Persistence**: storage adapter with `localStorage` + transparent in-memory fallback,
  `appKey` namespacing, versioned schema with safe-discard, quota/corruption recovery.
  `email` is never persisted.
- **Feature flags** evaluated through the same pipeline (sticky, provenance-backed).
- **Exposure tracking**: pluggable `onExposure`, in-memory per-session dedupe by
  `(bucketingId, experimentKey, variant)`, exposure-eligibility tied to the runtime reason.
- **Overrides**: QA forced overrides (read-time, never persisted/tracked) incl. a URL
  helper; admin override layer that survives remote refreshes.
- **Remote config**: WebSocket `config.replace` transport (full-replace only), monotonic
  `lastAppliedVersion`, bootstrap-from-cache readiness, reconnect with backoff + jitter,
  connection-status events. Mock transport under `ab-testing-library/testing`.
- **Cross-tab sync** via `storage` events + `BroadcastChannel`, with echo-loop protection.
- **React adapter** (`ab-testing-library/react`): `AbTestingProvider`, `useExperiment`,
  `useFeatureFlag` built on `useSyncExternalStore` — render-pure, memoized stable
  snapshots, SSR-safe `getServerSnapshot`, exposure fired only after commit.
- **Fail-open error policy** with structured `AbErrorCode` codes; only the synchronous
  imperative contract throws.
- **Demo control plane** (`server/`): `GET /health`, public `GET /config`, WebSocket
  `/config/stream`, bearer-protected `PUT /admin/config` with server-side validation,
  monotonic versioning, and optimistic concurrency (`409`).
- **Playground app** (`playground/`): operational React console + live admin panel.
- **Packaging**: ESM-first with `./` and `./react` entry points, `"sideEffects": false`,
  dual ESM/CJS + `.d.ts`, React as an optional peer dependency; validated with `publint`,
  `arethetypeswrong`, and `size-limit`. Zero runtime dependencies.

[0.1.0]: https://github.com/64envy64/ab-testing-library/releases/tag/v0.1.0
