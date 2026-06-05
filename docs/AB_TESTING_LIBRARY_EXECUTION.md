# A/B Testing Frontend Library Execution Brief

Дата: 2026-06-04

Цель: реализовать A/B testing SDK: deterministic assignment, sticky local persistence, React adapter, protected config backend, realtime full config replace, admin/mock UI, feature flags, exposure tracking, tests, packaging checks and clear documentation.

## Guiding Documents

- `docs/BEHAVIOR_CONTRACT.md` is the source of truth for runtime behavior.
- `docs/DECISIONS.md` is the source of truth for scope boundaries and architecture trade-offs.
- Tests must mirror the behavior contract branch-for-branch.

## Final Scope

### Implemented Now

- Modular framework-agnostic core SDK.
- React adapter with SSR-safe hooks.
- `createAbClient()` factory-first API.
- User initialization and update APIs.
- Deterministic MurmurHash3 assignment with `hashVersion`.
- Sticky assignment backed by persisted provenance.
- Multiple independent experiments.
- Feature flags using the same evaluation pipeline.
- Exposure tracking through pluggable `onExposure`.
- Pluggable `logger` and `onEvent` lifecycle hooks.
- Local persistence with memory fallback.
- Last-known config bootstrap cache with persisted version.
- Cross-tab sync via storage events and BroadcastChannel.
- Realtime remote config via WebSocket `config.replace`.
- Protected backend admin write API.
- Public config read and WebSocket stream.
- Admin/mock page for split and enabled-state editing.
- QA forced overrides, including URL override helper.
- `subscribe(listener)` for React adapter and imperative consumers.
- `getDebugState()` for admin/debug UI.
- Error codes and fail-open runtime policy.
- `reset()` / `clear()` lifecycle APIs.
- `destroy()` teardown API.
- Pre-commit checks, CI workflow and package validation.

### Simplified For V1

- Remote updates use full config replace only.
- Reconnect receives full current config from server.
- No field-level patch protocol.
- No heartbeat protocol.
- Privacy controls are `persistence: "memory"`, `tracking: false` and `reset()` / `clear()`, not a full consent manager.

### Reserved Extensions

- Layers and mutual exclusion groups.
- Server-side assignment store for cross-device sticky assignment.
- Feature flag prerequisites.
- Dynamic consent state machine.
- Field-level config patches.
- Heartbeat/ping-pong protocol.
- Vector clocks and multi-writer config control.
- Analytics integrations beyond `onExposure`.
- Advanced traffic allocation and holdout engine.

## Architecture

```text
React app
  -> @library/react
       -> AbTestingProvider
       -> useExperiment()
       -> useFeatureFlag()
  -> @library/core
       -> createAbClient()
       -> evaluation pipeline
       -> persistence adapters
       -> remote transport
       -> cross-tab sync
       -> exposure hooks

Backend control plane
  -> public config read
  -> public WebSocket config.replace stream
  -> protected admin config write
  -> validation + monotonic version

Example app
  -> user initialization
  -> variant display
  -> feature-gated section
  -> feature flag demo
  -> admin live config editing
```

## Proposed Repository Shape

```text
.
├── README.md
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── tsup.config.ts
├── vitest.config.ts
├── eslint.config.js
├── lint-staged.config.js
├── .github/
│   └── workflows/
│       └── ci.yml
├── .husky/
│   ├── pre-commit
│   └── pre-push
├── docs/
│   ├── AB_TESTING_LIBRARY_EXECUTION.md
│   ├── BEHAVIOR_CONTRACT.md
│   └── DECISIONS.md
├── src/
│   ├── index.ts
│   ├── core/
│   │   ├── abTestingClient.ts
│   │   ├── assignment.ts
│   │   ├── config.ts
│   │   ├── debug.ts
│   │   ├── errors.ts
│   │   ├── events.ts
│   │   ├── exposure.ts
│   │   ├── featureFlags.ts
│   │   ├── hash.ts
│   │   ├── persistence.ts
│   │   ├── remote.ts
│   │   ├── storageSync.ts
│   │   └── types.ts
│   ├── react/
│   │   ├── index.ts
│   │   ├── AbTestingProvider.tsx
│   │   ├── useExperiment.ts
│   │   └── useFeatureFlag.ts
│   └── testing/
│       └── mockRemoteConfig.ts
├── server/
│   ├── index.ts
│   ├── auth.ts
│   ├── configStore.ts
│   ├── validation.ts
│   └── websocketHub.ts
├── playground/
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx
│       ├── admin/
│       │   └── AdminConfigPanel.tsx
│       └── main.tsx
└── tests/
    ├── assignment.test.ts
    ├── client.test.ts
    ├── exposure.test.ts
    ├── featureFlags.test.ts
    ├── hash.test.ts
    ├── persistence.test.ts
    ├── reactHooks.test.tsx
    ├── remoteConfig.test.ts
    ├── server.test.ts
    └── storageSync.test.ts
```

## Public API Draft

```ts
const client = createAbClient({
  appKey: "demo",
  defaultConfig,
  fallbackVariant: "control",
  remote: {
    url: "ws://localhost:8787/config",
  },
  persistence: "local",
  tracking: true,
  strict: false,
  logger: console,
  onEvent(event) {
    console.info("[ab-sdk]", event);
  },
  onExposure(event) {
    analytics.track("Experiment Viewed", event);
  },
});

client.initializeUser({ id: "user-123" });

const unsubscribe = client.subscribe((snapshot) => {
  console.info("A/B state changed", snapshot.version);
});

const assignment = client.getAssignment("checkout-copy", { track: false });
const variant = client.getVariant("checkout-copy");
const enabled = client.isFeatureEnabled("newCheckoutFlow");

client.setAdminOverride({
  experiments: {
    "checkout-copy": { enabled: true },
  },
});

client.setForcedOverride("checkout-copy", "variant-b");
client.loadForcedOverridesFromUrl(new URLSearchParams(location.search));
client.clearForcedOverride("checkout-copy");
client.clearAdminOverride("checkout-copy");

const debugState = client.getDebugState();

client.updateUser({ id: "user-123", plan: "pro" });
client.resetAssignment("checkout-copy");
unsubscribe();
client.reset();
client.destroy();
```

React:

```tsx
<AbTestingProvider client={client}>
  <Checkout />
</AbTestingProvider>

function Checkout() {
  const checkout = useExperiment("checkout-copy");
  const newFlow = useFeatureFlag("newCheckoutFlow");

  if (!checkout.isReady) return null;

  return newFlow.enabled ? <NewCheckout /> : <LegacyCheckout />;
}
```

## Data Model

### User

```ts
type UserData = {
  id?: string;
  anonymousId?: string;
  traits?: Record<string, JsonValue>; // memory-only, not persisted
};
```

Raw email should not be persisted. If the host app passes email, the SDK may keep it in memory only or store a redacted/hash form if explicitly configured later.

### Experiment Config

```ts
type ExperimentConfig = {
  key: string;
  seed: string;
  enabled: boolean;
  controlVariant: string;
  variants: Array<{
    key: string;
    weight: number;
  }>;
  layerKey?: string;
  exclusionGroup?: string;
};
```

`layerKey` and `exclusionGroup` are reserved shape only in v1.

### Feature Flag Config

```ts
type FeatureFlagConfig = {
  key: string;
  seed: string;
  enabled: boolean;
  rollout: number;
};
```

Internally this is evaluated as an `on` / `off` weighted experiment.

### Exposure Event

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

Exposure events must not include raw email or other PII.

### Persisted State

```ts
type PersistedState = {
  schemaVersion: 1;
  user?: UserData;
  assignments: Record<string, PersistedAssignment>;
  cachedConfig?: RemoteConfig;
  cachedConfigVersion?: number;
};
```

`appKey` prefixes persisted storage keys. Unsupported `schemaVersion` values are safely discarded with a structured warning in v1; migrations are reserved for future versions.

## Backend Contract

Endpoints:

- `GET /health` returns service status.
- `GET /config` returns public current config and version.
- `WS /config/stream` sends current full config on connect and every accepted admin update.
- `PUT /admin/config` replaces config, requires bearer admin token.

Realtime message:

```ts
type ConfigReplaceMessage = {
  type: "config.replace";
  version: number;
  config: RemoteConfig;
};
```

Security:

- Admin mutations require `Authorization: Bearer <token>`.
- Public config contains no user data or secrets.
- Server validates payloads before accepting them.
- Server increments monotonic version on accepted mutation.
- Logs do not include raw PII.

## Test Plan

Tests mirror `docs/BEHAVIOR_CONTRACT.md`:

- `initializeUser`, `updateUser`, `getAssignment`, `getVariant`.
- Contract error before initialization.
- Hook fallback before initialization.
- MurmurHash3 vectors.
- Golden assignment snapshots.
- Distribution test over 100k ids.
- Split change keeps sticky assignment.
- Disabled experiment returns control and keeps assignment.
- Removed experiment clears assignment.
- Removed variant reassigns or falls back.
- Seed/hashVersion change recomputes.
- Corrupted localStorage recovers.
- Memory persistence works.
- Storage key namespacing through `appKey`.
- Unsupported schema version safe-discard.
- Cached config and version rehydrate.
- Stale remote version ignored.
- Full config replace applied.
- Admin override survives remote update.
- Forced override returns `FORCED_OVERRIDE` and does not persist.
- URL forced override helper parses configured prefix.
- `subscribe()` notifies consumers and unsubscribe works.
- Identity stitching: anon -> known keeps existing sticky assignments.
- Identity stitching: new experiments after login use known bucketing id.
- Identity stitching: known -> different known resets assignments.
- Exposure tracking is deduped.
- React render does not track exposure.
- React effect tracks after commit.
- StrictMode double effect dedupes.
- Cross-tab sync updates memory without echo loops.
- Backend rejects missing/invalid admin token.
- Backend rejects invalid config payload.

## Run Scripts

Package scripts should include:

- `npm run dev` starts the playground app.
- `npm run server` starts the backend control plane.
- `npm run test` runs unit and integration tests.
- `npm run typecheck` runs `tsc --noEmit`.
- `npm run lint` runs ESLint.
- `npm run build` builds library outputs.
- `npm run publint` validates package publishing shape.
- `npm run attw` validates TypeScript package exports.
- `npm run size` checks bundle budget.

## Quality Gates

Local:

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run publint`
- `npm run attw`
- `npm run size`

Git hooks:

- pre-commit: lint staged files and run related tests.
- pre-push: typecheck and full tests.

CI:

- install from clean checkout;
- lint;
- typecheck;
- test;
- build;
- publint;
- arethetypeswrong;
- size limit.

## README Requirements

README must include:

- 60-second quickstart.
- Library overview.
- Install/setup.
- Core API docs.
- React API docs.
- Logger, events and exposure tracking docs.
- QA forced override docs.
- Backend/admin setup.
- Example usage snippets.
- How to simulate remote config updates.
- How to run tests and checks.
- Limitations:
  - local sticky assignment is per-device;
  - cross-device sticky requires future server-side assignment store;
  - v1 uses full config replace, not patch;
  - layers/mutual exclusion are reserved extensions.
  - advanced holdout/traffic allocation is reserved.

## Acceptance Criteria

- Clean clone installs and runs.
- Example app starts.
- Backend starts.
- Admin page can live-edit split and enabled state.
- Variant updates propagate through WebSocket full replace.
- Assignments persist across reload.
- Corrupted persistence does not crash the app.
- Cross-tab sync works.
- Feature flag `newCheckoutFlow` works.
- Exposure tracking is test-covered.
- Forced override and admin override are test-covered.
- Logger/event hooks are documented.
- React hooks are SSR-safe and render-pure.
- Pre-commit checks are implemented.
- CI workflow exists.
- Package exports are typed and validated.
- Docs clearly explain implemented scope and reserved extensions.
