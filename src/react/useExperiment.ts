import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import type { AssignmentResult, EvaluateOptions } from '../core/types'
import { assignmentResultsEqual, useAbClient } from './store'

/**
 * Subscribe a component to an experiment's assignment.
 *
 * Render is pure: it reads a memoized snapshot via the client's side-effect-free
 * `peekAssignment` (stable reference unless the assignment actually changes, so an
 * unrelated experiment changing does not re-render this component). Exposure is fired
 * only after commit, in an effect — never during render. `getServerSnapshot` always
 * returns a safe default, keeping SSR/hydration crash-free.
 */
export function useExperiment(experimentKey: string, options?: EvaluateOptions): AssignmentResult {
  const client = useAbClient()
  const track = options?.track

  const snapshotRef = useRef<AssignmentResult | null>(null)
  const serverRef = useRef<AssignmentResult | null>(null)

  const subscribe = useCallback((onStoreChange: () => void) => client.subscribe(onStoreChange), [client])

  const getSnapshot = useCallback((): AssignmentResult => {
    const next = client.peekAssignment(experimentKey)
    const cached = snapshotRef.current
    if (cached !== null && assignmentResultsEqual(cached, next)) return cached
    snapshotRef.current = next
    return next
  }, [client, experimentKey])

  const getServerSnapshot = useCallback((): AssignmentResult => {
    if (serverRef.current === null || serverRef.current.experimentKey !== experimentKey) {
      serverRef.current = client.defaultAssignment(experimentKey)
    }
    return serverRef.current
  }, [client, experimentKey])

  const assignment = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  useEffect(() => {
    if (track === false) return
    // DEFAULT_FALLBACK means uninitialized — peek only, do not call the imperative API.
    if (assignment.reason === 'DEFAULT_FALLBACK') return
    try {
      // Establishes the sticky assignment and fires a deduped exposure (StrictMode's
      // double-invoked effect is absorbed by the in-memory dedupe).
      client.getAssignment(experimentKey, { track: true })
    } catch {
      /* client may have been destroyed between render and commit; exposure is best-effort */
    }
  }, [client, experimentKey, assignment, track])

  return assignment
}
