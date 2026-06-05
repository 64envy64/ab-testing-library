# Contributing

## Prerequisites

- **Node.js ≥ 20.19** (matches `engines` in `package.json`; the toolchain — Vite 6 / Vitest 4 — requires it).
- npm (the repo ships a `package-lock.json`; use `npm ci` for reproducible installs).

## Setup

```bash
npm ci          # clean, lockfile-exact install (also wires the git hooks via husky)
npm test        # run the suite
```

## Scripts

| script | purpose |
| --- | --- |
| `npm run dev` | example app (Vite) on :5173 |
| `npm run server` | demo control plane on :8787 |
| `npm test` / `npm run test:watch` | Vitest (run / watch) |
| `npm run test:coverage` | Vitest with V8 coverage + thresholds |
| `npm run typecheck` | `tsc --noEmit` for the app and node tsconfigs |
| `npm run lint` / `npm run lint:fix` | ESLint flat config |
| `npm run build` | dual ESM/CJS + `.d.ts` via tsup |
| `npm run publint` / `npm run attw` | validate the published package shape & types |
| `npm run size` | enforce the bundle-size budget |

## Quality gates

Every change must keep these green (CI runs all of them — see `.github/workflows/ci.yml`):

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run publint && npm run attw && npm run size
```

## Git hooks

Installed automatically by `npm ci` / `npm install` (husky `prepare` script):

- **pre-commit** (`lint-staged`): ESLint `--fix` on staged files + `vitest related --run`
  (only the tests affected by the staged files — keeps commits fast).
- **pre-push**: full `npm run typecheck` + `npm test`.

Set `HUSKY=0` to skip hooks in environments where they don't apply (CI runs the checks
explicitly).

## Conventions

- **Strict TypeScript**, no `any` in the public surface. `verbatimModuleSyntax` + `Bundler`
  resolution; prefer `import type`.
- **The core (`src/core`, `src/index.ts`) must never import React** — enforced by
  `tests/smoke.test.ts`. React-only code lives in `src/react` (which carries the
  `"use client"` directive).
- **Fail open.** Runtime / config / storage / network problems are surfaced as structured
  `AbIssue`s through the logger / `onEvent`; only the synchronous imperative contract
  (evaluating before `initializeUser`) throws. Async transport callbacks never throw into
  the host.
- **The hashing algorithm is versioned** (`HASH_VERSION`). Changing it re-randomizes every
  user, so it must be a deliberate, version-bumped change — guarded by golden tests.
- **Tests mirror the behavior contract** (`docs/BEHAVIOR_CONTRACT.md`) branch-for-branch.
  New behavior gets a contract line and a matching test.

## Adding an experiment or flag

Experiments/flags are data, not code — add them to your config (or the control plane),
shaped per `ExperimentConfig` / `FeatureFlagConfig`. Each experiment needs a stable
`seed` (decoupled from the public `key` so it can be rotated to re-randomize). Validate
untrusted config with `validateRemoteConfig` before use.
