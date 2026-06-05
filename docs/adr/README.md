# Architecture Decision Records

Short records of the decisions that shaped this SDK. The broader scope ledger
(Implemented / Simplified / Reserved) lives in [`../DECISIONS.md`](../DECISIONS.md);
the testable runtime contract in [`../BEHAVIOR_CONTRACT.md`](../BEHAVIOR_CONTRACT.md).

| ADR | Decision |
| --- | --- |
| [0001](./0001-deterministic-hashing.md) | MurmurHash3 x86-32, synchronous & versioned |
| [0002](./0002-fail-open-error-policy.md) | Fail open; only the sync contract throws |
| [0003](./0003-sticky-provenance.md) | Sticky assignment via persisted provenance |
| [0004](./0004-react-usesyncexternalstore.md) | React via `useSyncExternalStore` + pure peek |
| [0005](./0005-full-replace-remote-config.md) | Remote config is full-replace only |
| [0006](./0006-packaging-core-react-split.md) | Core / React split, zero runtime deps |
