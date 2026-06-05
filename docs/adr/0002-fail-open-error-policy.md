# ADR 0002: Fail open; only the synchronous contract throws

- Status: Accepted
- Date: 2026-06-05

## Context

An experimentation SDK must never take down the host app. But some misuse is a genuine
programmer error worth surfacing loudly. The ТЗ says both "throw helpful errors" and
"handle edge cases" — these apply to different situations.

## Decision

- **Throw** only for synchronous contract violations: evaluating (`getVariant` /
  `getAssignment` / `isFeatureEnabled`) before `initializeUser`, and an invalid
  `appKey`/`defaultConfig`/`setConfig` under `strict: true`.
- **Fail open** for everything else — unknown experiment/flag, corrupted storage, invalid
  or stale remote config, transport failure — returning a safe default and reporting a
  structured `AbIssue` (with an `AbErrorCode`) via the `logger` / `onEvent` hook.
- **Async callbacks never throw into the host**, even under `strict`. Invalid remote
  config keeps the last-good config; `onExposure` / `onEvent` / listeners are wrapped.
- React surfaces differ on purpose: a missing `<AbTestingProvider>` throws (integration
  contract), but using a hook before `initializeUser` returns `DEFAULT_FALLBACK`.

## Consequences

- Production apps degrade gracefully; bugs surface as structured, switchable codes.
- `strict` gives tests/dev fast, loud feedback on the synchronous paths.
- The throw-vs-fallback split is explicit and tested, so it can't drift.
