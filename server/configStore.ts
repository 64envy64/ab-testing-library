/**
 * In-memory config store for the control plane. Full-replace only with a monotonic
 * version (no patch/delta). Shaped like a real control plane even though it is not
 * backed by a database.
 */
import type { RemoteConfig } from '../src/core/types'

export interface ConfigSnapshot {
  version: number
  config: RemoteConfig
}

export class ConfigStore {
  private version: number
  private config: RemoteConfig

  constructor(initialConfig: RemoteConfig, initialVersion = 1) {
    this.config = initialConfig
    this.version = initialVersion
  }

  snapshot(): ConfigSnapshot {
    return { version: this.version, config: this.config }
  }

  get currentVersion(): number {
    return this.version
  }

  /** Replace the full config, incrementing the monotonic version. */
  replace(config: RemoteConfig): ConfigSnapshot {
    this.version += 1
    this.config = config
    return this.snapshot()
  }
}
