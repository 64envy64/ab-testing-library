/**
 * Server-side admin payload validation. Reuses the SDK's zero-dependency
 * `validateRemoteConfig` so the server and client agree on what a valid config is.
 */
import { validateRemoteConfig } from '../src/core/config'
import type { RemoteConfig } from '../src/core/types'

export interface ParsedAdminPayload {
  config: RemoteConfig
  /** Optional optimistic-concurrency guard. */
  currentVersion?: number
}

export type AdminPayloadResult =
  | { ok: true; payload: ParsedAdminPayload }
  | { ok: false; status: number; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the parsed JSON body of `PUT /admin/config`: `{ config, currentVersion? }`. */
export function parseAdminPayload(body: unknown): AdminPayloadResult {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: 'Request body must be a JSON object' }
  }
  if (body.config === undefined) {
    return { ok: false, status: 400, error: 'Missing "config" in request body' }
  }

  const result = validateRemoteConfig(body.config)
  if (!result.valid) {
    return { ok: false, status: 400, error: `Invalid config: ${result.issues.map((issue) => issue.message).join('; ')}` }
  }

  let currentVersion: number | undefined
  if (body.currentVersion !== undefined) {
    if (typeof body.currentVersion !== 'number' || !Number.isInteger(body.currentVersion)) {
      return { ok: false, status: 400, error: '"currentVersion" must be an integer' }
    }
    currentVersion = body.currentVersion
  }

  return { ok: true, payload: { config: body.config as RemoteConfig, currentVersion } }
}
