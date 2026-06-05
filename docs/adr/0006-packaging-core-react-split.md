# ADR 0006: Core / React split, zero runtime dependencies

- Status: Accepted
- Date: 2026-06-05

## Context

The SDK targets both non-React consumers and React apps (including RSC / Next.js App
Router). Bundling React into the core, or shipping one entry point, would force React on
everyone and break server components.

## Decision

- Two entry points via the `exports` map: `.` (framework-agnostic core) and `./react`
  (the adapter). React + React DOM are **optional peer dependencies**, externalized from
  the build. A third `./testing` entry exposes the mock transport.
- `"sideEffects": false`; dual ESM/CJS output with per-condition `.d.ts` / `.d.cts`. The
  React entry carries a `"use client"` directive (re-emitted onto the bundle by the build).
- **Zero runtime dependencies** — config validation is hand-rolled (no `zod`), and the
  WebSocket transport uses the browser's global `WebSocket`. The demo backend's `ws` is a
  dev dependency and is never shipped (`files: ["dist"]`).
- Validate the published shape in CI with `publint` and `arethetypeswrong`, and enforce a
  bundle budget with `size-limit`.

## Consequences

- Non-React consumers never pull React; the core stays tree-shakeable and tiny (~6 kB
  gzip core, ~0.7 kB react adapter).
- RSC-safe: the client boundary is explicit and verified.
- No dependency/version conflicts foisted on consumers; `node16`/bundler type resolution
  is validated, so types resolve correctly for ESM and CJS importers.
