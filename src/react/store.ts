import { createContext, useContext } from 'react'

import type { AbClient, AssignmentResult, FeatureFlagResult } from '../core/types'

/** Context holds the host-created client (factory-first; the app owns its lifecycle). */
export const AbContext = createContext<AbClient | null>(null)

/**
 * Read the client from context. A missing provider is an integration-contract
 * violation (unlike pre-init reads, which return a safe fallback), so this throws a
 * clear, actionable error.
 */
export function useAbClient(): AbClient {
  const client = useContext(AbContext)
  if (client === null) {
    throw new Error(
      '[ab-testing] useExperiment/useFeatureFlag must be used within an <AbTestingProvider>. ' +
        'Wrap your tree and pass a client created with createAbClient().',
    )
  }
  return client
}

export function assignmentResultsEqual(a: AssignmentResult, b: AssignmentResult): boolean {
  return (
    a.experimentKey === b.experimentKey &&
    a.variant === b.variant &&
    a.reason === b.reason &&
    a.source === b.source &&
    a.isReady === b.isReady &&
    a.trackable === b.trackable
  )
}

export function featureFlagResultsEqual(a: FeatureFlagResult, b: FeatureFlagResult): boolean {
  return a.enabled === b.enabled && assignmentResultsEqual(a.assignment, b.assignment)
}
