/**
 * Minimal internal change-notifier and time helper.
 *
 * `Emitter` is a payload-less "something changed" signal. The public `subscribe`
 * API and the React `useSyncExternalStore` store are built on top of it.
 * Listeners are isolated: a throwing listener never breaks the others or the
 * host app.
 */
export class Emitter {
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        /* a listener must never break the emitter or the host app */
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}

/** Current time as an ISO-8601 string (used for assignedAt / event timestamps). */
export function nowIso(): string {
  return new Date().toISOString()
}
