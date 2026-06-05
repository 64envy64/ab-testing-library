# ADR 0004: React via useSyncExternalStore + a pure peek surface

- Status: Accepted
- Date: 2026-06-05

## Context

The React adapter subscribes components to an external store (the client). The classic
`useState` + `useEffect` subscribe pattern tears under concurrent rendering. Render must
be pure (no persistence, no exposure), but the SDK's `getAssignment` persists and fires
exposure. SSR/hydration must not crash or mismatch.

## Decision

Use `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`:

- Add side-effect-free `peekAssignment` / `peekFeatureFlag` to the client; `getSnapshot`
  calls these and returns a **per-key memoized, referentially-stable** result (via a
  `useRef` cache + value equality). An unrelated experiment changing therefore does not
  re-render the component.
- `getServerSnapshot` always returns the safe default (`DEFAULT_FALLBACK`); the store
  reconciles to the live value after hydration, so there is no hydration mismatch.
- Exposure fires from a post-commit `useEffect` (via `getAssignment({ track: true })`),
  never during render; StrictMode's double-invoked effect is absorbed by the exposure
  dedupe.

## Consequences

- Render-pure, tear-free, SSR-safe, with selective re-renders (scales to many experiments).
- The `peek*` reads are also useful outside React (conditional logic without exposure).
- No dependency on `use-sync-external-store/with-selector`; memoization is hand-rolled to
  keep the adapter dependency-free (~0.7 kB gzip).
