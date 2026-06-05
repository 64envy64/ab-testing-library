'use client'

/**
 * React adapter entry (`ab-testing-library/react`).
 *
 * Provider + hooks built on `useSyncExternalStore`: render-pure with memoized,
 * referentially-stable snapshots; SSR-safe `getServerSnapshot`; exposure fired only
 * after commit. The core SDK is framework-agnostic — this adapter is the only place
 * that touches React. The `"use client"` directive (first line; re-emitted onto the
 * built bundle by tsup) marks the entry as a client component for RSC / Next.js.
 */
export { AbTestingProvider, type AbTestingProviderProps } from './AbTestingProvider'
export { useExperiment } from './useExperiment'
export { useFeatureFlag } from './useFeatureFlag'

// Convenience re-exports of the types the hooks return.
export type { AbClient, AssignmentResult, FeatureFlagResult, EvaluateOptions } from '../core/types'
