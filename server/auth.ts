/**
 * Admin authentication for the control plane.
 *
 * The admin token comes from `AB_ADMIN_TOKEN`. A clearly-named insecure fallback is
 * used only when the env var is absent (local/dev) and the caller is expected to warn.
 * Comparison is constant-time to avoid leaking the token via timing.
 */
import { timingSafeEqual } from 'node:crypto'

export const DEV_FALLBACK_ADMIN_TOKEN = 'dev-only-admin-token'

export function resolveAdminToken(): { token: string; isDevFallback: boolean } {
  const fromEnv = process.env.AB_ADMIN_TOKEN
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { token: fromEnv, isDevFallback: false }
  }
  return { token: DEV_FALLBACK_ADMIN_TOKEN, isDevFallback: true }
}

export function isAuthorized(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (authorizationHeader === undefined) return false
  const prefix = 'Bearer '
  if (!authorizationHeader.startsWith(prefix)) return false
  return constantTimeEqual(authorizationHeader.slice(prefix.length), expectedToken)
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  // Length is allowed to differ observably; the token contents are compared in
  // constant time once lengths match.
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}
