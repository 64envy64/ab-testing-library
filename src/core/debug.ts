/**
 * Read-only debug snapshot for admin/QA tooling (`getDebugState`). It exposes the
 * persisted (email-free) user, current bucketing id, known experiment/flag keys and
 * the stored assignments — never raw PII.
 */
import { HASH_VERSION } from './hash'
import { SCHEMA_VERSION } from './persistence'
import type { DebugState, PersistedAssignment, PersistedUserData, RemoteConfig } from './types'

export function buildDebugState(input: {
  initialized: boolean
  isReady: boolean
  bucketingId: string | null
  user: PersistedUserData | undefined
  effectiveConfig: RemoteConfig
  assignments: Record<string, PersistedAssignment>
  forcedOverrides: Record<string, string>
  adminOverrideKeys: string[]
}): DebugState {
  return {
    initialized: input.initialized,
    isReady: input.isReady,
    bucketingId: input.bucketingId,
    user: input.user,
    experiments: Object.keys(input.effectiveConfig.experiments),
    flags: Object.keys(input.effectiveConfig.flags),
    assignments: { ...input.assignments },
    forcedOverrides: { ...input.forcedOverrides },
    adminOverrideKeys: [...input.adminOverrideKeys],
    schemaVersion: SCHEMA_VERSION,
    hashVersion: HASH_VERSION,
  }
}
