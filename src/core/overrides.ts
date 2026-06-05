/**
 * Read-time override layers (QA forced overrides + admin config overrides).
 *
 * Both are in-memory and per-tab in v1: they are debugging/QA tools layered on
 * top of the base/remote config WITHOUT mutating it, and they are not persisted or
 * cross-tab synced. Forced overrides are checked before the assignment pipeline;
 * admin overrides reshape the effective config that the pipeline evaluates against.
 */
import type {
  AdminOverrideInput,
  ExperimentConfig,
  FeatureFlagConfig,
  RemoteConfig,
} from './types'

export class OverrideLayer {
  private readonly forced = new Map<string, string>()
  private readonly adminExperiments = new Map<string, Partial<ExperimentConfig>>()
  private readonly adminFlags = new Map<string, Partial<FeatureFlagConfig>>()

  // ── forced (QA) ──

  setForced(experimentKey: string, variant: string): void {
    this.forced.set(experimentKey, variant)
  }

  clearForced(experimentKey?: string): void {
    if (experimentKey === undefined) this.forced.clear()
    else this.forced.delete(experimentKey)
  }

  getForced(experimentKey: string): string | undefined {
    return this.forced.get(experimentKey)
  }

  forcedSnapshot(): Record<string, string> {
    return Object.fromEntries(this.forced)
  }

  // ── admin (config patch layer) ──

  setAdmin(input: AdminOverrideInput): void {
    if (input.experiments) {
      for (const [key, partial] of Object.entries(input.experiments)) this.adminExperiments.set(key, partial)
    }
    if (input.flags) {
      for (const [key, partial] of Object.entries(input.flags)) this.adminFlags.set(key, partial)
    }
  }

  clearAdmin(key?: string): void {
    if (key === undefined) {
      this.adminExperiments.clear()
      this.adminFlags.clear()
    } else {
      this.adminExperiments.delete(key)
      this.adminFlags.delete(key)
    }
  }

  clearAll(): void {
    this.forced.clear()
    this.adminExperiments.clear()
    this.adminFlags.clear()
  }

  adminKeys(): string[] {
    return [...new Set([...this.adminExperiments.keys(), ...this.adminFlags.keys()])]
  }

  /**
   * Merge admin overrides on top of a base config. Overrides PATCH existing
   * experiments/flags (shallow per entry); overrides for unknown keys are ignored
   * so the effective config never becomes incomplete. Pure — does not mutate input.
   */
  applyAdmin(base: RemoteConfig): RemoteConfig {
    if (this.adminExperiments.size === 0 && this.adminFlags.size === 0) return base

    const experiments: Record<string, ExperimentConfig> = { ...base.experiments }
    for (const [key, partial] of this.adminExperiments) {
      const existing = experiments[key]
      if (existing !== undefined) experiments[key] = { ...existing, ...partial }
    }

    const flags: Record<string, FeatureFlagConfig> = { ...base.flags }
    for (const [key, partial] of this.adminFlags) {
      const existing = flags[key]
      if (existing !== undefined) flags[key] = { ...existing, ...partial }
    }

    return { experiments, flags }
  }
}
