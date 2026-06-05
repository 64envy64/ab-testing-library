/**
 * Public entry for the framework-agnostic A/B testing core SDK.
 *
 * Ships the stateful client: user state, safe persistence, deterministic
 * assignment, feature flags, exposure tracking, overrides, subscriptions,
 * cross-tab sync and remote config. React hooks live in the `./react` entry;
 * the demo control plane lives under `server/`.
 *
 * This module MUST NOT import React — enforced by `tests/smoke.test.ts`.
 */

/** Current SDK version. */
export const SDK_VERSION = '0.1.0'

// ── Client ──
export { createAbClient } from './core/abTestingClient'

// ── Public types ──
export type {
  UserData,
  VariantConfig,
  ExperimentConfig,
  FeatureFlagConfig,
  RemoteConfig,
  PersistedAssignment,
  PersistedUserData,
  PersistedState,
  AssignmentReason,
  AssignmentSource,
  AssignmentResult,
  ExposureEvent,
  AbLogger,
  AbLogLevel,
  AbSdkEvent,
  AbSdkEventType,
  CreateAbClientOptions,
  PersistenceMode,
  RemoteOptions,
  RemoteConfigTransport,
  TransportHandlers,
  ConfigReplaceMessage,
  ConnectionStatus,
  ReconnectOptions,
  AbClient,
  UpdateUserOptions,
  EvaluateOptions,
  DebugState,
  AdminOverrideInput,
  UrlOverrideOptions,
} from './core/types'

// ── Errors ──
export { AbError, AbErrorCode, abIssue } from './core/errors'
export type { AbIssue } from './core/errors'

// ── Hashing & bucketing ──
export {
  HASH_VERSION,
  murmur3_32,
  hashToUnitInterval,
  getBucketValue,
  selectVariantByBucket,
} from './core/hash'

// ── Config validation ──
export {
  validateExperimentConfig,
  validateFeatureFlagConfig,
  validateRemoteConfig,
  normalizeExperimentConfig,
} from './core/config'
export type { ValidationResult } from './core/config'
