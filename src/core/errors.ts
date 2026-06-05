/**
 * Error codes and structured error/issue payloads.
 *
 * Policy (see docs/BEHAVIOR_CONTRACT.md "Error Policy"): contract violations may
 * throw an `AbError` from the imperative API; runtime/config/storage/network
 * problems fail open and are surfaced as structured `AbIssue`s through the logger
 * / `onEvent` hook. Codes are structured so consumers can switch on them rather
 * than parsing free-form strings.
 */

export enum AbErrorCode {
  NotInitialized = 'AB_E_NOT_INITIALIZED',
  StorageCorrupt = 'AB_E_STORAGE_CORRUPT',
  ConfigInvalid = 'AB_E_CONFIG_INVALID',
  TransportFailed = 'AB_E_TRANSPORT_FAILED',
  ExperimentNotFound = 'AB_E_EXPERIMENT_NOT_FOUND',
  VariantInvalid = 'AB_E_VARIANT_INVALID',
  RemoteStale = 'AB_E_REMOTE_STALE',
  AdminAuth = 'AB_E_ADMIN_AUTH',
}

/** A structured, non-throwing diagnostic (validation issue, fail-open warning). */
export interface AbIssue {
  code: AbErrorCode
  message: string
  context?: Record<string, unknown>
}

/**
 * Error thrown for programmer-contract violations (e.g. calling the imperative
 * API before `initializeUser`). Carries a structured `code` and optional context.
 */
export class AbError extends Error {
  readonly code: AbErrorCode
  readonly context: Record<string, unknown> | undefined

  constructor(code: AbErrorCode, message: string, context?: Record<string, unknown>) {
    super(`[${code}] ${message}`)
    this.name = 'AbError'
    this.code = code
    this.context = context
  }
}

/** Build a structured issue for validators and fail-open warnings. */
export function abIssue(
  code: AbErrorCode,
  message: string,
  context?: Record<string, unknown>,
): AbIssue {
  return context === undefined ? { code, message } : { code, message, context }
}
