# ADR 0005: Remote config is full-replace only

- Status: Accepted
- Date: 2026-06-05

## Context

The SDK consumes live config over WebSocket. A patch/delta protocol (with gap detection,
delta replay, ordering) is powerful but heavy and error-prone for v1.

## Decision

Support **full replace only**: `{ type: "config.replace", version, config }`. The client
applies a message only when `version > lastAppliedVersion` (monotonic, server-owned);
stale/replayed messages are ignored and reported as `AB_E_REMOTE_STALE`. On (re)connect
the server simply sends the current full snapshot. No patch, gap detection, delta replay,
heartbeat, or vector clocks.

## Consequences

- **More correct, not just simpler.** Experiment removal is unambiguous (absent ⇒ removed),
  and "resync on reconnect" is just the normal connect snapshot — no special path.
- A returning client whose cached version equals the server's current version still
  confirms sync on the connect snapshot (marks ready without re-applying).
- Reconnect uses exponential backoff + jitter; heartbeat / optimistic concurrency beyond a
  simple version check are reserved (the demo backend does add an optional `409`).
- `version` is validated as a non-negative safe integer before it touches state.
