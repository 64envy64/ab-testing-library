/**
 * Stateful core client (docs/BEHAVIOR_CONTRACT.md). Framework-agnostic and
 * browser-safe: it holds user state, the effective config and assignment
 * provenance, applies the evaluation pipeline, fires exposures, syncs remote config
 * and persists through the storage adapter. Fails open — runtime/config/storage/
 * network problems are surfaced as structured issues, never thrown into the host
 * app; only contract violations (evaluating before init) throw.
 *
 * Evaluation pipeline order:
 *   base/default/bootstrap/remote config → admin override layer → forced override
 *   (read-time) → experiment lookup → assignment pipeline → exposure eligibility.
 *
 * React bindings live in the `./react` adapter; the demo control plane is in `server/`.
 */
import { evaluateExperiment } from './assignment'
import { normalizeRemoteConfig, validateRemoteConfig } from './config'
import { buildDebugState } from './debug'
import { AbError, AbErrorCode, abIssue, type AbIssue } from './errors'
import { Emitter, nowIso } from './events'
import { ExposureTracker } from './exposure'
import { flagToExperiment, FLAG_OFF, FLAG_ON } from './featureFlags'
import { OverrideLayer } from './overrides'
import { createPersistenceStore, emptyPersistedState, type PersistenceStore } from './persistence'
import {
  computeBackoffDelay,
  createWebSocketTransport,
  resolveReconnectOptions,
  type ResolvedReconnectOptions,
} from './remote'
import { type CrossTabSync, createCrossTabSync } from './storageSync'
import type {
  AbClient,
  AbLogger,
  AbSdkEvent,
  AbSdkEventType,
  AdminOverrideInput,
  AssignmentResult,
  ConnectionStatus,
  CreateAbClientOptions,
  DebugState,
  EvaluateOptions,
  ExperimentConfig,
  ExposureEvent,
  FeatureFlagResult,
  PersistedState,
  PersistedUserData,
  PersistenceMode,
  RemoteConfig,
  RemoteConfigTransport,
  RemoteOptions,
  UpdateUserOptions,
  UrlOverrideOptions,
  UserData,
} from './types'

const EMPTY_CONFIG: RemoteConfig = { experiments: {}, flags: {} }

const NOOP_SYNC: CrossTabSync = {
  notify: () => {},
  close: () => {},
}

interface ResolvedOptions {
  appKey: string
  fallbackVariant: string
  persistence: PersistenceMode
  tracking: boolean
  strict: boolean
  urlOverridePrefix: string
  logger: AbLogger | undefined
  onEvent: ((event: AbSdkEvent) => void) | undefined
  onExposure: ((event: ExposureEvent) => void) | undefined
  remote: RemoteOptions | undefined
}

function resolveOptions(options: CreateAbClientOptions): ResolvedOptions {
  if (!options.appKey) {
    throw new AbError(AbErrorCode.ConfigInvalid, 'createAbClient requires a non-empty "appKey"')
  }
  return {
    appKey: options.appKey,
    fallbackVariant: options.fallbackVariant ?? 'control',
    persistence: options.persistence ?? 'local',
    tracking: options.tracking ?? true,
    strict: options.strict ?? false,
    urlOverridePrefix: options.urlOverridePrefix ?? 'ab_force_',
    logger: options.logger,
    onEvent: options.onEvent,
    onExposure: options.onExposure,
    remote: options.remote,
  }
}

function generateAnonymousId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `anon-${cryptoObj.randomUUID()}`
  }
  // Fallback for non-secure contexts where crypto.randomUUID is unavailable.
  return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Drop raw PII / caller-provided traits before writing the user to storage. */
function toPersistedUser(user: UserData): PersistedUserData {
  const { email, traits, ...rest } = user
  return rest
}

function isSamePersistedUser(
  current: PersistedUserData | undefined,
  incoming: PersistedUserData | undefined,
): boolean {
  if (current === undefined || incoming === undefined) return false
  if (current.id !== undefined || incoming.id !== undefined) {
    return current.id !== undefined && current.id === incoming.id
  }
  return current.anonymousId !== undefined && current.anonymousId === incoming.anonymousId
}

class AbTestingClient implements AbClient {
  private readonly options: ResolvedOptions
  private readonly storage: PersistenceStore
  private readonly changes = new Emitter()
  private readonly overrides = new OverrideLayer()
  private readonly exposure: ExposureTracker
  private readonly crossTab: CrossTabSync
  private readonly missingKeyWarnings = new Set<string>()
  private readonly transport: RemoteConfigTransport | null
  private readonly remoteConfigured: boolean
  private readonly reconnectOptions: ResolvedReconnectOptions
  private state: PersistedState
  private baseConfig: RemoteConfig
  private activeUser: UserData | undefined = undefined
  private bucketingId: string | null = null
  private initialized = false
  private isReady = false
  private destroyed = false
  private syncedAtLeastOnce = false
  private lastAppliedVersion = -1
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: CreateAbClientOptions) {
    this.options = resolveOptions(options)
    this.reconnectOptions = resolveReconnectOptions(options.remote?.reconnect)
    this.exposure = new ExposureTracker((event) => {
      try {
        this.options.onExposure?.(event)
      } catch {
        /* onExposure must never break the host app */
      }
    }, nowIso)
    this.baseConfig = this.acceptInitialConfig(options.defaultConfig ?? EMPTY_CONFIG)
    this.storage = createPersistenceStore(this.options.appKey, this.options.persistence, (issue) => {
      this.handleIssue(issue)
    })
    // Rehydrate persisted user / assignments / cached bootstrap config synchronously.
    this.state = this.storage.load()
    // Cross-tab sync only makes sense over shared (local) storage.
    this.crossTab =
      this.options.persistence === 'local'
        ? createCrossTabSync(this.options.appKey, () => {
            this.syncFromStorage()
          })
        : NOOP_SYNC
    this.sanitizeRehydratedState()
    this.lastAppliedVersion = this.state.cachedConfigVersion ?? -1

    this.transport = this.createTransport()
    this.remoteConfigured = this.transport !== null
    if (this.transport !== null) this.connectRemote()
  }

  initializeUser(userData: UserData, options?: UpdateUserOptions): void {
    this.ensureAlive()
    this.applyUser(userData, options?.reassignVariant ?? false)
    this.initialized = true
    this.isReady = this.computeReady()
    this.emitEvent('user.initialized')
    if (this.isReady) this.emitEvent('ready')
    this.changes.emit()
  }

  updateUser(userData: UserData, options?: UpdateUserOptions): void {
    this.ensureAlive()
    this.ensureInitialized()
    this.applyUser(userData, options?.reassignVariant ?? false)
    this.emitEvent('user.updated')
    this.changes.emit()
  }

  getAssignment(experimentKey: string, options?: EvaluateOptions): AssignmentResult {
    this.ensureAlive()
    this.ensureInitialized()

    const forced = this.overrides.getForced(experimentKey)
    if (forced !== undefined) {
      // Forced (QA) override: read-time only — never persisted, never tracked.
      return {
        experimentKey,
        variant: forced,
        reason: 'FORCED_OVERRIDE',
        source: 'forced',
        isReady: this.isReady,
        trackable: false,
      }
    }

    const experiment = this.effectiveConfig().experiments[experimentKey]
    if (experiment === undefined) this.warnMissingKey('experiment', experimentKey)
    return this.evaluate(experimentKey, experiment, options?.track ?? true)
  }

  getVariant(experimentKey: string, options?: EvaluateOptions): string {
    return this.getAssignment(experimentKey, options).variant
  }

  isFeatureEnabled(flagKey: string, options?: EvaluateOptions): boolean {
    this.ensureAlive()
    this.ensureInitialized()

    const forced = this.overrides.getForced(flagKey)
    if (forced !== undefined) return forced === FLAG_ON

    const flag = this.effectiveConfig().flags[flagKey]
    if (flag === undefined) {
      this.warnMissingKey('flag', flagKey)
      return false // fail open: unknown flag is off
    }
    const result = this.evaluate(flagKey, flagToExperiment(flag), options?.track ?? true)
    return result.variant === FLAG_ON
  }

  peekAssignment(experimentKey: string): AssignmentResult {
    // Render-safe: pure (no persist/track/emit). Returns the default before init.
    if (this.destroyed || !this.initialized || this.bucketingId === null) {
      return this.defaultAssignment(experimentKey)
    }
    const forced = this.overrides.getForced(experimentKey)
    if (forced !== undefined) {
      return { experimentKey, variant: forced, reason: 'FORCED_OVERRIDE', source: 'forced', isReady: this.isReady, trackable: false }
    }
    const experiment = this.effectiveConfig().experiments[experimentKey]
    return evaluateExperiment({
      experimentKey,
      experiment,
      persisted: this.state.assignments[experimentKey],
      currentBucketingId: this.bucketingId,
      fallbackVariant: this.options.fallbackVariant,
      isReady: this.isReady,
    }).result
  }

  peekFeatureFlag(flagKey: string): FeatureFlagResult {
    if (this.destroyed || !this.initialized || this.bucketingId === null) {
      return this.defaultFeatureFlag(flagKey)
    }
    const forced = this.overrides.getForced(flagKey)
    if (forced !== undefined) {
      const assignment: AssignmentResult = { experimentKey: flagKey, variant: forced, reason: 'FORCED_OVERRIDE', source: 'forced', isReady: this.isReady, trackable: false }
      return { enabled: forced === FLAG_ON, assignment }
    }
    const flag = this.effectiveConfig().flags[flagKey]
    if (flag === undefined) {
      return {
        enabled: false,
        assignment: { experimentKey: flagKey, variant: FLAG_OFF, reason: 'EXPERIMENT_NOT_FOUND', source: 'default', isReady: this.isReady, trackable: false },
      }
    }
    const assignment = evaluateExperiment({
      experimentKey: flagKey,
      experiment: flagToExperiment(flag),
      persisted: this.state.assignments[flagKey],
      currentBucketingId: this.bucketingId,
      fallbackVariant: this.options.fallbackVariant,
      isReady: this.isReady,
    }).result
    return { enabled: assignment.variant === FLAG_ON, assignment }
  }

  defaultAssignment(experimentKey: string): AssignmentResult {
    return {
      experimentKey,
      variant: this.options.fallbackVariant,
      reason: 'DEFAULT_FALLBACK',
      source: 'default',
      isReady: false,
      trackable: false,
    }
  }

  defaultFeatureFlag(flagKey: string): FeatureFlagResult {
    return {
      enabled: false,
      assignment: {
        experimentKey: flagKey,
        variant: FLAG_OFF,
        reason: 'DEFAULT_FALLBACK',
        source: 'default',
        isReady: false,
        trackable: false,
      },
    }
  }

  setConfig(config: RemoteConfig): void {
    this.ensureAlive()
    const { valid, issues } = validateRemoteConfig(config)
    if (!valid) {
      for (const issue of issues) this.handleIssue(issue)
      if (this.options.strict) {
        throw new AbError(AbErrorCode.ConfigInvalid, 'setConfig received an invalid config', { issueCount: issues.length })
      }
      return // fail open: keep the last-good config
    }
    this.baseConfig = config
    this.emitEvent('config.updated')
    this.changes.emit()
  }

  subscribe(listener: () => void): () => void {
    this.ensureAlive()
    return this.changes.subscribe(listener)
  }

  setForcedOverride(experimentKey: string, variant: string): void {
    this.ensureAlive()
    this.overrides.setForced(experimentKey, variant)
    this.changes.emit()
  }

  clearForcedOverride(experimentKey?: string): void {
    this.ensureAlive()
    this.overrides.clearForced(experimentKey)
    this.changes.emit()
  }

  loadForcedOverridesFromUrl(searchParams: URLSearchParams, options?: UrlOverrideOptions): void {
    this.ensureAlive()
    const prefix = options?.prefix ?? this.options.urlOverridePrefix
    let changed = false
    for (const [name, value] of searchParams.entries()) {
      if (name.startsWith(prefix) && name.length > prefix.length) {
        this.overrides.setForced(name.slice(prefix.length), value)
        changed = true
      }
    }
    if (changed) this.changes.emit()
  }

  setAdminOverride(config: AdminOverrideInput): void {
    this.ensureAlive()
    this.overrides.setAdmin(config)
    this.emitEvent('config.updated')
    this.changes.emit()
  }

  clearAdminOverride(experimentKey?: string): void {
    this.ensureAlive()
    this.overrides.clearAdmin(experimentKey)
    this.emitEvent('config.updated')
    this.changes.emit()
  }

  resetAssignment(experimentKey: string): void {
    this.ensureAlive()
    if (this.state.assignments[experimentKey] !== undefined) {
      delete this.state.assignments[experimentKey]
      this.persist()
      this.emitEvent('assignment.reset', { context: { experimentKey } })
      this.changes.emit()
    }
  }

  reset(): void {
    this.ensureAlive()
    const preserveRemoteSync = this.remoteConfigured && this.syncedAtLeastOnce
    const cachedConfig = preserveRemoteSync ? this.state.cachedConfig : undefined
    const cachedConfigVersion = preserveRemoteSync ? this.state.cachedConfigVersion : undefined
    const lastAppliedVersion = preserveRemoteSync ? this.lastAppliedVersion : -1

    this.state = emptyPersistedState()
    if (cachedConfig !== undefined) this.state.cachedConfig = cachedConfig
    if (cachedConfigVersion !== undefined) this.state.cachedConfigVersion = cachedConfigVersion
    this.activeUser = undefined
    this.bucketingId = null
    this.initialized = false
    this.isReady = false
    this.syncedAtLeastOnce = preserveRemoteSync
    this.lastAppliedVersion = lastAppliedVersion
    this.exposure.reset()
    this.overrides.clearAll()
    this.missingKeyWarnings.clear()
    this.storage.remove()
    this.emitEvent('assignment.reset')
    this.changes.emit()
  }

  clear(): void {
    this.reset()
  }

  getDebugState(): DebugState {
    return buildDebugState({
      initialized: this.initialized,
      isReady: this.isReady,
      bucketingId: this.bucketingId,
      user: this.state.user,
      effectiveConfig: this.effectiveConfig(),
      assignments: this.state.assignments,
      forcedOverrides: this.overrides.forcedSnapshot(),
      adminOverrideKeys: this.overrides.adminKeys(),
    })
  }

  destroy(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.transport?.close()
    this.crossTab.close()
    this.changes.clear()
    this.destroyed = true
  }

  // ──────────────────────────── internals ───────────────────────────

  private effectiveConfig(): RemoteConfig {
    // base/default → bootstrap/remote cached config → admin override layer.
    // (Forced overrides are applied per-read in getAssignment/isFeatureEnabled.)
    // Normalize first: a validated config may omit a map (treated as "none"), and
    // applyAdmin's no-op path returns it as-is — guarantee both maps so reads fail open.
    const base = normalizeRemoteConfig(this.state.cachedConfig ?? this.baseConfig)
    return this.overrides.applyAdmin(base)
  }

  private acceptInitialConfig(config: RemoteConfig): RemoteConfig {
    const { valid, issues } = validateRemoteConfig(config)
    if (valid) return config

    for (const issue of issues) this.handleIssue(issue)
    if (this.options.strict) {
      throw new AbError(AbErrorCode.ConfigInvalid, 'createAbClient received an invalid defaultConfig', {
        issueCount: issues.length,
      })
    }
    return EMPTY_CONFIG
  }

  private sanitizeRehydratedState(): void {
    if (this.state.user !== undefined) {
      this.state.user = toPersistedUser(this.state.user)
    }

    if (this.state.cachedConfig !== undefined) {
      const { valid, issues } = validateRemoteConfig(this.state.cachedConfig)
      if (!valid) {
        for (const issue of issues) this.handleIssue(issue)
        this.state.cachedConfig = undefined
        this.state.cachedConfigVersion = undefined
        this.persist()
      }
    }
  }

  private createTransport(): RemoteConfigTransport | null {
    const remote = this.options.remote
    if (remote === undefined) return null
    if (remote.transport !== undefined) return remote.transport
    if (remote.url !== undefined && remote.url.length > 0) {
      const hasWebSocket = typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function'
      if (!hasWebSocket) {
        this.handleIssue(
          abIssue(AbErrorCode.TransportFailed, 'WebSocket unavailable; remote config disabled', { url: remote.url }),
        )
        return null
      }
      return createWebSocketTransport(remote.url)
    }
    this.handleIssue(abIssue(AbErrorCode.TransportFailed, 'remote configured without a url or transport'))
    return null
  }

  private connectRemote(): void {
    if (this.destroyed || this.transport === null) return
    this.emitConnectionStatus('connecting')
    this.transport.connect({
      onOpen: () => {
        this.reconnectAttempts = 0
        this.emitConnectionStatus('open')
      },
      onMessage: (message) => {
        this.applyRemoteMessage(message)
      },
      onError: (error) => {
        this.handleIssue(abIssue(AbErrorCode.TransportFailed, 'Remote config transport error', { error: String(error) }))
        this.emitConnectionStatus('error')
        this.scheduleReconnect()
      },
      onClose: () => {
        this.emitConnectionStatus('closed')
        this.scheduleReconnect()
      },
    })
  }

  private applyRemoteMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      this.handleIssue(abIssue(AbErrorCode.ConfigInvalid, 'Ignoring malformed remote message (not an object)'))
      return
    }
    const candidate = message as { type?: unknown; version?: unknown; config?: unknown }
    if (
      candidate.type !== 'config.replace' ||
      typeof candidate.version !== 'number' ||
      !Number.isSafeInteger(candidate.version) ||
      candidate.version < 0
    ) {
      this.handleIssue(abIssue(AbErrorCode.ConfigInvalid, 'Ignoring remote message with an unexpected shape'))
      return
    }

    const version = candidate.version
    if (version <= this.lastAppliedVersion) {
      this.handleIssue(
        abIssue(
          AbErrorCode.RemoteStale,
          `Ignoring stale remote config version ${version} (applied ${this.lastAppliedVersion})`,
          { version, lastAppliedVersion: this.lastAppliedVersion },
        ),
      )
      // We still received a valid config from the server, confirming our cached
      // config is current (or newer): we are now in sync even though there is
      // nothing new to apply. This flips readiness for a returning user whose
      // cached version already equals the server's current version.
      this.markSynced()
      return
    }

    const { valid, issues } = validateRemoteConfig(candidate.config)
    if (!valid) {
      // The async transport path always fails open (never throws into the host),
      // even in strict mode; the last-good config remains in effect.
      for (const issue of issues) this.handleIssue(issue)
      return
    }

    this.state.cachedConfig = candidate.config as RemoteConfig
    this.state.cachedConfigVersion = version
    this.lastAppliedVersion = version
    this.persist()
    this.emitEvent('config.updated', { context: { version } })
    this.markSynced()
    this.changes.emit()
  }

  private markSynced(): void {
    if (this.syncedAtLeastOnce) return
    this.syncedAtLeastOnce = true
    this.updateReadiness()
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.transport === null || this.reconnectTimer !== null) return
    if (!this.reconnectOptions.enabled) return
    this.emitConnectionStatus('reconnecting')
    const delay = computeBackoffDelay(this.reconnectAttempts, this.reconnectOptions)
    this.reconnectAttempts += 1
    const timer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectRemote()
    }, delay)
    const maybeUnref = (timer as { unref?: () => void }).unref
    if (typeof maybeUnref === 'function') maybeUnref.call(timer)
    this.reconnectTimer = timer
  }

  private emitConnectionStatus(status: ConnectionStatus): void {
    this.emitEvent('connection.status', { context: { status } })
  }

  private updateReadiness(): void {
    const next = this.computeReady()
    if (next === this.isReady) return
    this.isReady = next
    if (next) this.emitEvent('ready')
    this.changes.emit()
  }

  /** Re-read shared storage into memory after another tab changed it (anti-loop: no write). */
  private syncFromStorage(): void {
    if (this.destroyed) return
    const loaded = this.storage.load()

    if (isSamePersistedUser(this.state.user, loaded.user)) {
      this.state.assignments = loaded.assignments
    }

    let cachedConfig = loaded.cachedConfig
    let cachedConfigVersion = loaded.cachedConfigVersion
    if (cachedConfig !== undefined) {
      const { valid, issues } = validateRemoteConfig(cachedConfig)
      if (!valid) {
        for (const issue of issues) this.handleIssue(issue)
        cachedConfig = undefined
        cachedConfigVersion = undefined
      }
    }

    this.state.cachedConfig = cachedConfig
    this.state.cachedConfigVersion = cachedConfigVersion
    if (cachedConfig !== undefined && cachedConfigVersion !== undefined && cachedConfigVersion > this.lastAppliedVersion) {
      this.lastAppliedVersion = cachedConfigVersion
      if (this.remoteConfigured) this.syncedAtLeastOnce = true
    }
    // Keep this tab's own active user / bucketing id; only experiment data syncs.
    this.updateReadiness()
    this.changes.emit()
  }

  private evaluate(key: string, experiment: ExperimentConfig | undefined, track: boolean): AssignmentResult {
    const outcome = evaluateExperiment({
      experimentKey: key,
      experiment,
      persisted: this.state.assignments[key],
      currentBucketingId: this.requireBucketingId(),
      fallbackVariant: this.options.fallbackVariant,
      isReady: this.isReady,
    })

    let mutated = false
    if (outcome.persist !== undefined) {
      this.state.assignments[key] = outcome.persist
      mutated = true
    } else if (outcome.clear === true && this.state.assignments[key] !== undefined) {
      delete this.state.assignments[key]
      mutated = true
    }

    if (mutated) {
      this.persist()
      this.emitEvent(outcome.persist !== undefined ? 'assignment.created' : 'assignment.reset', {
        context: { experimentKey: key, reason: outcome.result.reason },
      })
      this.changes.emit()
    }

    // Exposure fires only when: caller did not opt out, global tracking is on, and
    // the result is exposure-eligible (checked inside ExposureTracker.track).
    if (track && this.options.tracking) {
      this.exposure.track(outcome.result, this.requireBucketingId(), this.state.cachedConfigVersion)
    }

    return outcome.result
  }

  private applyUser(userData: UserData, reassign: boolean): void {
    const previous = this.state.user
    const previousId = previous?.id
    const merged: UserData = { ...this.activeUser, ...userData }

    let anonymousId = merged.anonymousId ?? previous?.anonymousId
    if (merged.id === undefined && anonymousId === undefined) {
      anonymousId = generateAnonymousId()
    }

    const newId = merged.id
    let reset = reassign
    if (previousId !== undefined && newId !== undefined && previousId !== newId) {
      reset = true // known → different known
    }
    if (reset) {
      this.state.assignments = {}
    }

    const bucketingId = newId ?? anonymousId
    if (bucketingId === undefined) {
      // Defensive: unreachable because an anonymous id is generated above.
      throw new AbError(AbErrorCode.NotInitialized, 'Unable to resolve a bucketing id for the user')
    }

    this.activeUser = anonymousId === undefined ? { ...merged } : { ...merged, anonymousId }
    this.state.user = toPersistedUser(this.activeUser)
    this.bucketingId = bucketingId
    this.persist()
  }

  private requireBucketingId(): string {
    if (this.bucketingId === null) {
      throw new AbError(AbErrorCode.NotInitialized, 'No active user; call initializeUser() first')
    }
    return this.bucketingId
  }

  private computeReady(): boolean {
    // Without a remote: ready once initialized. With a remote: ready only after the
    // first valid config.replace has synced.
    return this.initialized && (!this.remoteConfigured || this.syncedAtLeastOnce)
  }

  private persist(): void {
    this.storage.save(this.state)
    // Tell other tabs (BroadcastChannel ping; the storage event auto-fires).
    this.crossTab.notify()
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new AbError(AbErrorCode.NotInitialized, 'Call initializeUser() before evaluating experiments')
    }
  }

  private ensureAlive(): void {
    if (this.destroyed) {
      throw new AbError(AbErrorCode.NotInitialized, 'This client has been destroyed')
    }
  }

  private handleIssue(issue: AbIssue): void {
    this.emitEvent('error', { code: issue.code, message: issue.message, context: issue.context })
    try {
      this.options.logger?.warn(issue.message, issue.context)
    } catch {
      /* a logger must never break the host app */
    }
  }

  private warnMissingKey(kind: 'experiment' | 'flag', key: string): void {
    const warningKey = `${kind}:${key}`
    if (this.missingKeyWarnings.has(warningKey)) return
    this.missingKeyWarnings.add(warningKey)
    this.handleIssue(
      abIssue(AbErrorCode.ExperimentNotFound, `Unknown ${kind} "${key}"; returning fallback`, {
        key,
        kind,
      }),
    )
  }

  private emitEvent(
    type: AbSdkEventType,
    extra?: { code?: AbErrorCode; message?: string; context?: Record<string, unknown> },
  ): void {
    if (this.options.onEvent === undefined) return
    const event: AbSdkEvent = { type, timestamp: nowIso(), ...extra }
    try {
      this.options.onEvent(event)
    } catch {
      /* onEvent must never break the host app */
    }
  }
}

export function createAbClient(options: CreateAbClientOptions): AbClient {
  return new AbTestingClient(options)
}
