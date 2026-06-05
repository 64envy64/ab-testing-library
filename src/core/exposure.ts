/**
 * In-memory, per-session exposure de-duplication and firing
 * (docs/BEHAVIOR_CONTRACT.md "Exposure Tracking").
 *
 * The dedupe key is `(bucketingId, experimentKey, variant)` and is NOT persisted —
 * analytics should receive one exposure per session per variant; a variant flip or
 * a new bucketing id fires a fresh exposure. The `emit` callback is wrapped by the
 * caller so it never throws into the host app, and dedupe is recorded before emit
 * (the SDK fires once; delivery reliability is the sink's job).
 */
import type { AssignmentResult, ExposureEvent } from './types'

const SEP = '\u001f'

export class ExposureTracker {
  private readonly seen = new Set<string>()

  constructor(
    private readonly emit: (event: ExposureEvent) => void,
    private readonly now: () => string,
  ) {}

  /** Fire an exposure for an eligible result, once per (bucketingId, key, variant). */
  track(result: AssignmentResult, bucketingId: string, configVersion: number | undefined): void {
    if (!result.trackable) return

    const dedupeKey = `${bucketingId}${SEP}${result.experimentKey}${SEP}${result.variant}`
    if (this.seen.has(dedupeKey)) return
    this.seen.add(dedupeKey)

    const event: ExposureEvent = {
      experimentKey: result.experimentKey,
      variant: result.variant,
      reason: result.reason,
      source: result.source,
      bucketingId,
      timestamp: this.now(),
      ...(configVersion !== undefined ? { configVersion } : {}),
    }
    this.emit(event)
  }

  reset(): void {
    this.seen.clear()
  }
}
