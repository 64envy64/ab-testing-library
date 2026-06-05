import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import type { EvaluateOptions, FeatureFlagResult } from '../core/types'
import { featureFlagResultsEqual, useAbClient } from './store'

/**
 * Subscribe a component to a feature flag. Returns `{ enabled, assignment }`.
 *
 * Same discipline as {@link useExperiment}: pure memoized render via the client's
 * side-effect-free `peekFeatureFlag`, exposure fired only after commit, and an
 * always-safe `getServerSnapshot`.
 */
export function useFeatureFlag(flagKey: string, options?: EvaluateOptions): FeatureFlagResult {
  const client = useAbClient()
  const track = options?.track

  const snapshotRef = useRef<FeatureFlagResult | null>(null)
  const serverRef = useRef<FeatureFlagResult | null>(null)

  const subscribe = useCallback((onStoreChange: () => void) => client.subscribe(onStoreChange), [client])

  const getSnapshot = useCallback((): FeatureFlagResult => {
    const next = client.peekFeatureFlag(flagKey)
    const cached = snapshotRef.current
    if (cached !== null && featureFlagResultsEqual(cached, next)) return cached
    snapshotRef.current = next
    return next
  }, [client, flagKey])

  const getServerSnapshot = useCallback((): FeatureFlagResult => {
    if (serverRef.current === null || serverRef.current.assignment.experimentKey !== flagKey) {
      serverRef.current = client.defaultFeatureFlag(flagKey)
    }
    return serverRef.current
  }, [client, flagKey])

  const result = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  useEffect(() => {
    if (track === false) return
    if (result.assignment.reason === 'DEFAULT_FALLBACK') return
    try {
      client.isFeatureEnabled(flagKey, { track: true })
    } catch {
      /* best-effort exposure */
    }
  }, [client, flagKey, result, track])

  return result
}
