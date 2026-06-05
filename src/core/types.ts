/**
 * Public type surface for the A/B testing SDK.
 *
 * These types mirror docs/BEHAVIOR_CONTRACT.md. No `any` is used anywhere in the
 * public API — the client, persistence, transport and React layers all consume
 * this contract.
 */
import type { AbErrorCode } from './errors'

// ───────────────────────────── User ─────────────────────────────

/**
 * User identity and traits passed to `initializeUser` / `updateUser`.
 *
 * `id` is the randomization unit. `email`, if provided, is kept in memory only —
 * it is never persisted to storage and never used for bucketing. `traits` are also
 * memory-only to avoid persisting caller-provided PII (privacy; see "User Identity
 * Contract"). Persistence strips both fields from the stored shape.
 */
export interface UserData {
  id?: string
  anonymousId?: string
  email?: string
  traits?: Record<string, JsonValue>
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

// ──────────────────────────── Config ────────────────────────────

export interface VariantConfig {
  key: string
  /** Relative weight (>= 0). Weights need not sum to 100; weight 0 = paused variant. */
  weight: number
}

export interface ExperimentConfig {
  key: string
  /** Randomization salt, decoupled from `key` so it can be rotated to re-randomize. */
  seed: string
  enabled: boolean
  /** Variant returned on control/fallback paths; must reference a key in `variants`. */
  controlVariant: string
  variants: VariantConfig[]
  /** Reserved (layers) — shape only in v1, not yet evaluated. */
  layerKey?: string
  /** Reserved (mutual exclusion groups) — shape only in v1, not yet evaluated. */
  exclusionGroup?: string
}

export interface FeatureFlagConfig {
  key: string
  seed: string
  enabled: boolean
  /** Rollout percentage in [0, 100]. Evaluated as an on/off weighted experiment. */
  rollout: number
}

/** The remote/default config payload. Version is tracked separately (on the wire message and in persistence). */
export interface RemoteConfig {
  experiments: Record<string, ExperimentConfig>
  flags: Record<string, FeatureFlagConfig>
}

// ────────────────────────── Assignment ──────────────────────────

/**
 * Persisted assignment record. Stores the provenance of the inputs it was computed
 * from (`bucketingId`, `hashVersion`, `seed`) so algorithm / seed changes are
 * detectable and identity continuity is explicit. Notably it does NOT store the
 * runtime `reason`, which is recomputed on every evaluation.
 */
export interface PersistedAssignment {
  experimentKey: string
  variantKey: string
  bucketingId: string
  hashVersion: string
  seed: string
  /** ISO-8601 timestamp of first assignment. */
  assignedAt: string
  /** How it was first assigned. `"server"` is reserved for a future assignment store. */
  assignedBy: 'computed' | 'server'
}

export type AssignmentReason =
  | 'STICKY'
  | 'COMPUTED'
  | 'FORCED_OVERRIDE'
  | 'EXPERIMENT_DISABLED'
  | 'EXPERIMENT_NOT_FOUND'
  | 'VARIANT_REMOVED_REASSIGNED'
  | 'VARIANT_REMOVED_FALLBACK'
  // Reserved for a future traffic-allocation / holdout engine; never emitted in v1.
  | 'NOT_IN_EXPERIMENT'
  | 'DEFAULT_FALLBACK'

// `"server"` is reserved for a future server-side assignment store; never emitted in v1.
export type AssignmentSource = 'computed' | 'server' | 'forced' | 'default'

export interface AssignmentResult {
  experimentKey: string
  variant: string
  reason: AssignmentReason
  source: AssignmentSource
  isReady: boolean
  /** Whether this evaluation is exposure-eligible (see exposure policy). */
  trackable: boolean
}

// ─────────────────────────── Exposure ───────────────────────────

export interface ExposureEvent {
  experimentKey: string
  variant: string
  reason: AssignmentReason
  source: AssignmentSource
  bucketingId: string
  configVersion?: number
  /** ISO-8601 timestamp. */
  timestamp: string
}

// ───────────────────────── Observability ────────────────────────

export type AbLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Pluggable logger. `console` satisfies this interface. Callbacks are wrapped and never throw into the host app. */
export interface AbLogger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

export type AbSdkEventType =
  | 'ready'
  | 'user.initialized'
  | 'user.updated'
  | 'config.updated'
  | 'assignment.created'
  | 'assignment.reset'
  | 'connection.status'
  | 'error'

/** SDK lifecycle event delivered to `onEvent`. `code` is present on error/warn events. */
export interface AbSdkEvent {
  type: AbSdkEventType
  code?: AbErrorCode
  message?: string
  context?: Record<string, unknown>
  /** ISO-8601 timestamp. */
  timestamp: string
}

// ────────────────────────── Client options ──────────────────────

export type PersistenceMode = 'local' | 'memory'

// ─────────────────────── Remote transport (v1) ──────────────────

/** Full-replace remote config message. v1 has no patch/delta protocol. */
export interface ConfigReplaceMessage {
  type: 'config.replace'
  version: number
  config: RemoteConfig
}

export interface TransportHandlers {
  onOpen(): void
  /** Raw inbound message (validated by the client). */
  onMessage(message: unknown): void
  onError(error: unknown): void
  onClose(): void
}

/** A single-connection transport. `connect` may be called again to reconnect. */
export interface RemoteConfigTransport {
  connect(handlers: TransportHandlers): void
  close(): void
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'reconnecting' | 'error'

export interface ReconnectOptions {
  initialDelayMs?: number
  maxDelayMs?: number
  jitter?: boolean
  /** Set false to disable automatic reconnect. Default: true. */
  enabled?: boolean
}

export interface RemoteOptions {
  /** WebSocket URL of the config control plane (used when no explicit transport is given). */
  url?: string
  /** Explicit transport instance (e.g. the mock transport in tests). Overrides `url`. */
  transport?: RemoteConfigTransport
  reconnect?: ReconnectOptions
}

export interface CreateAbClientOptions {
  /** Namespaces persisted storage keys; isolates apps/environments sharing one origin. */
  appKey: string
  defaultConfig?: RemoteConfig
  /** Variant returned when an experiment is unknown/unresolved. Default: `"control"`. */
  fallbackVariant?: string
  remote?: RemoteOptions
  /** Default: `"local"` (transparently falls back to memory when storage is unavailable). */
  persistence?: PersistenceMode
  /** Master switch for exposure callbacks. Default: `true`. */
  tracking?: boolean
  /** Dev/test strictness: turn selected fail-open warnings into throws. Default: `false`. */
  strict?: boolean
  /** Prefix for URL forced overrides, e.g. `?ab_force_<key>=<variant>`. Default: `"ab_force_"`. */
  urlOverridePrefix?: string
  logger?: AbLogger
  onEvent?: (event: AbSdkEvent) => void
  onExposure?: (event: ExposureEvent) => void
}

// ───────────────────────── Persisted state ──────────────────────

/** Persisted user shape — deliberately excludes `email` and caller-provided `traits`. */
export interface PersistedUserData {
  id?: string
  anonymousId?: string
}

export interface PersistedState {
  schemaVersion: number
  user?: PersistedUserData
  assignments: Record<string, PersistedAssignment>
  cachedConfig?: RemoteConfig
  cachedConfigVersion?: number
}

// ─────────────────────────── Client API ─────────────────────────

export interface UpdateUserOptions {
  /** Recompute variant assignments under the active bucketing id. */
  reassignVariant?: boolean
}

export interface EvaluateOptions {
  /** Whether this read is exposure-eligible (fires the `onExposure` callback). */
  track?: boolean
}

export interface DebugState {
  initialized: boolean
  isReady: boolean
  bucketingId: string | null
  user: PersistedUserData | undefined
  experiments: string[]
  flags: string[]
  assignments: Record<string, PersistedAssignment>
  forcedOverrides: Record<string, string>
  adminOverrideKeys: string[]
  schemaVersion: number
  hashVersion: string
}

/** Result of a feature-flag read: the boolean plus the underlying on/off assignment. */
export interface FeatureFlagResult {
  enabled: boolean
  assignment: AssignmentResult
}

/** Partial config patch applied as the admin override layer (patches existing keys). */
export interface AdminOverrideInput {
  experiments?: Record<string, Partial<ExperimentConfig>>
  flags?: Record<string, Partial<FeatureFlagConfig>>
}

export interface UrlOverrideOptions {
  /** Override the client's configured `urlOverridePrefix` for this call. */
  prefix?: string
}

export interface AbClient {
  /** Initialize the user session and assignment context. */
  initializeUser(userData: UserData, options?: UpdateUserOptions): void
  /** Update stored user data; recompute assignments only when `reassignVariant` is set. */
  updateUser(userData: UserData, options?: UpdateUserOptions): void
  /** Full evaluation result for an experiment. Throws before `initializeUser`. */
  getAssignment(experimentKey: string, options?: EvaluateOptions): AssignmentResult
  /** Variant key for an experiment. Throws before `initializeUser`. */
  getVariant(experimentKey: string, options?: EvaluateOptions): string
  /** Whether a feature flag is enabled for the active user. */
  isFeatureEnabled(flagKey: string, options?: EvaluateOptions): boolean
  /** Render-safe, side-effect-free experiment read (no persist/track/emit). Returns the default before init. */
  peekAssignment(experimentKey: string): AssignmentResult
  /** Render-safe, side-effect-free feature-flag read. Returns disabled+default before init. */
  peekFeatureFlag(flagKey: string): FeatureFlagResult
  /** The always-safe default assignment (used for SSR `getServerSnapshot` and pre-init reads). */
  defaultAssignment(experimentKey: string): AssignmentResult
  /** The always-safe default feature-flag result (used for SSR `getServerSnapshot`). */
  defaultFeatureFlag(flagKey: string): FeatureFlagResult
  /** Replace the base/default config (fail-open: invalid config is rejected with issues). */
  setConfig(config: RemoteConfig): void
  /** Clear the stored assignment for a single experiment. */
  resetAssignment(experimentKey: string): void
  /** Full wipe: removes user, assignments and cached config; the client becomes uninitialized. */
  reset(): void
  /** Alias for {@link AbClient.reset}. */
  clear(): void
  /** Read-only snapshot for admin/QA/debug tooling (no raw PII). */
  getDebugState(): DebugState
  /** Subscribe to store changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Resolves once the client is ready (initialized, and — with a remote — after the first config sync). */
  ready(): Promise<void>
  /** QA: force a variant for an experiment (read-time only — never persisted or tracked). */
  setForcedOverride(experimentKey: string, variant: string): void
  /** Clear a single forced override, or all when no key is given. */
  clearForcedOverride(experimentKey?: string): void
  /** Parse `?<prefix><key>=<variant>` URL params into forced overrides. */
  loadForcedOverridesFromUrl(searchParams: URLSearchParams, options?: UrlOverrideOptions): void
  /** Admin: layer a partial config patch on top of base/remote config (survives setConfig). */
  setAdminOverride(config: AdminOverrideInput): void
  /** Clear a single admin override, or all when no key is given. */
  clearAdminOverride(experimentKey?: string): void
  /** Tear down listeners/resources. */
  destroy(): void
}
