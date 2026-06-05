/**
 * Deterministic hashing and bucketing primitives (docs/BEHAVIOR_CONTRACT.md
 * "Hashing Contract").
 *
 * MurmurHash3 x86 32-bit: synchronous, fast, and portable — it can be
 * re-implemented byte-for-byte on a backend, which is why we avoid async
 * `SubtleCrypto` and weak `String.hashCode`-style hashes. Correct 32-bit
 * arithmetic relies on `Math.imul` and unsigned coercion (`>>> 0`).
 *
 * `HASH_VERSION` is part of assignment provenance: changing the algorithm is an
 * explicit re-randomization event, so a stored assignment computed under an old
 * version is detected as stale and recomputed. Never change the algorithm
 * without bumping this constant.
 */
import type { VariantConfig } from './types'

export const HASH_VERSION = 'murmur3_x86_32.v1'

const textEncoder = new TextEncoder()

const C1 = 0xcc9e2d51
const C2 = 0x1b873593

/** MurmurHash3 x86 32-bit. Returns an unsigned 32-bit integer. */
export function murmur3_32(input: string, seed = 0): number {
  const bytes = textEncoder.encode(input)
  const len = bytes.length
  let h = seed >>> 0
  const nblocks = len - (len % 4)

  let i = 0
  for (; i < nblocks; i += 4) {
    let k =
      (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0
    k = Math.imul(k, C1) >>> 0
    k = ((k << 15) | (k >>> 17)) >>> 0
    k = Math.imul(k, C2) >>> 0
    h ^= k
    h = ((h << 13) | (h >>> 19)) >>> 0
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0
  }

  // Tail (replicates the classic switch fallthrough with explicit conditions).
  let k1 = 0
  const remainder = len % 4
  if (remainder === 3) k1 ^= bytes[i + 2]! << 16
  if (remainder >= 2) k1 ^= bytes[i + 1]! << 8
  if (remainder >= 1) {
    k1 ^= bytes[i]!
    k1 = Math.imul(k1, C1) >>> 0
    k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0
    k1 = Math.imul(k1, C2) >>> 0
    h ^= k1
  }

  // Finalization mix.
  h ^= len
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16

  return h >>> 0
}

/** Maps an unsigned 32-bit hash to a value in [0, 1). */
export function hashToUnitInterval(hash: number): number {
  return (hash >>> 0) / 0x1_0000_0000 // / 2^32
}

/**
 * Deterministic bucket value in [0, 1) for a `(seed, bucketingId)` pair.
 * Hash input is `` `${seed}:${bucketingId}` `` per the hashing contract — the
 * experiment `seed` provides the per-experiment salt, keeping experiments
 * statistically independent and re-randomizable.
 */
export function getBucketValue(seed: string, bucketingId: string): number {
  return hashToUnitInterval(murmur3_32(`${seed}:${bucketingId}`))
}

/**
 * Pure weighted selection: given a bucket value in [0, 1) and a set of variants,
 * returns the selected variant key.
 *
 * Variants are sorted by key (code-unit order — NOT locale-aware, for cross-platform
 * determinism) before cumulative weighting, so JSON ordering cannot reshuffle
 * assignments. Zero-weight variants are never selected. Returns `null` when no
 * variant is selectable (empty list or total weight 0).
 *
 * This is a building block; the sticky/provenance assignment pipeline lives in `assignment.ts`.
 */
export function selectVariantByBucket(
  bucket: number,
  variants: readonly VariantConfig[],
): string | null {
  const eligible = variants
    .filter((variant) => variant.weight > 0)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const total = eligible.reduce((sum, variant) => sum + variant.weight, 0)
  if (eligible.length === 0 || total <= 0) return null

  const target = bucket * total
  let cumulative = 0
  for (const variant of eligible) {
    cumulative += variant.weight
    if (target < cumulative) return variant.key
  }
  // Floating-point safety: bucket ~1 can land exactly on `total`.
  return eligible[eligible.length - 1]!.key
}
