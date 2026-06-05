# ADR 0003: Sticky assignment via persisted provenance

- Status: Accepted
- Date: 2026-06-05

## Context

A pure deterministic hash is *not* sticky when the split changes: moving 50/50 → 80/20
shifts bucket boundaries and re-buckets some users. Real experiments must keep users on
their assigned variant when weights change, yet still re-randomize when intended.

## Decision

Persist an assignment record that stores the **provenance** of the inputs it was computed
from: `bucketingId`, `hashVersion`, `seed` (plus `variantKey`, `assignedAt`, `assignedBy`).
On every evaluation, compare the current inputs to the stored provenance:

- all match and the variant still exists → `STICKY` (reuse, no recompute);
- variant removed → recompute under the *stored* `bucketingId` (`REASSIGNED` / `FALLBACK`);
- `seed` or `hashVersion` changed → recompute (`COMPUTED`, intentional re-randomization);
- experiment disabled → control, keep the record; removed → clear it (only once ready).

## Consequences

- Weight changes never churn assigned users; re-randomization is deliberate (rotate `seed`
  or bump `HASH_VERSION`). The whole "sticky matrix" reduces to one provenance invariant.
- Recompute uses the stored `bucketingId`, so `anon → known` identity stitching preserves
  existing assignments while new experiments use the known id.
- `runtime reason` is computed per evaluation and never persisted (it would go stale); the
  record stores only how it was *first* assigned (`assignedBy`).
