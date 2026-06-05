# ADR 0001: MurmurHash3 x86-32, synchronous & versioned

- Status: Accepted
- Date: 2026-06-05

## Context

Variant assignment must be deterministic, uniformly distributed, and ideally
re-implementable on a backend so client and server agree. `getVariant` is synchronous and
hot, so the hash must be sync and fast. `Math.random` (non-deterministic), `SubtleCrypto`
(async), and Java-style `String.hashCode` (poor distribution) are all unsuitable.

## Decision

Use **MurmurHash3 x86 32-bit** with correct 32-bit arithmetic (`Math.imul`, unsigned
`>>> 0`). Bucket input is `` `${seed}:${bucketingId}` ``, mapped to `[0, 1)` via
`hash / 2^32`, then to a variant over cumulative ranges of **key-sorted** variants.
Expose the algorithm behind a `HASH_VERSION` constant.

## Consequences

- Correctness is proven (mmh3 vectors + golden snapshots + a 100k-id distribution test),
  not assumed.
- Key-sorted ranges mean reordering variants in config never reshuffles users.
- A per-experiment `seed` (decoupled from the public `key`) enables re-randomization
  without renaming, and keeps experiments statistically independent.
- Changing the algorithm re-randomizes everyone, so `HASH_VERSION` makes it a deliberate,
  auditable event — golden tests fail loudly if it changes by accident.
- Portable: the same bucket can be recomputed on a backend (future server-side store).
