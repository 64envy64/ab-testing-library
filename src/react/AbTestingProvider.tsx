import type { ReactNode } from 'react'

import type { AbClient } from '../core/types'
import { AbContext } from './store'

export interface AbTestingProviderProps {
  /** A stable client created with `createAbClient()`. The app owns its lifecycle. */
  client: AbClient
  children: ReactNode
}

/**
 * Provides the A/B client to the tree. It does NOT create or destroy the client
 * (factory-first: the host app controls lifecycle), so the context value is exactly
 * the stable `client` reference and never churns the tree.
 */
export function AbTestingProvider({ client, children }: AbTestingProviderProps): ReactNode {
  return <AbContext.Provider value={client}>{children}</AbContext.Provider>
}
