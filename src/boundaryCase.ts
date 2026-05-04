/**
 * Boundary-case witness generation for NOT EXISTS / MINUS.
 *
 * The transform layer emits a runtime-dispatched call gated on a
 * public `boundary_cases[i]: Field` input per `NonExistenceConstraint`:
 *
 *   0 = Lower  (absent_hash < smallest real leaf -- bracketed against the low sentinel)
 *   1 = Middle (interior -- bracketed against two adjacent real leaves)
 *   2 = Upper  (absent_hash > largest real leaf  -- bracketed against the high sentinel)
 *
 * The sorted Merkle commitment carries permanent low / high sentinels
 * (see `noir/lib/utils/src/lib.nr::merkle`); the prover-side witness
 * generator picks the matching tag at proof time by comparing the live
 * `absent_hash` against the dataset's sorted real-leaf hashes.
 *
 * See `spec/exists.md` Sec.3.3 for the soundness argument.
 */

/** Field-tag matching the dispatch arms in the generated `checkBinding`. */
export const BOUNDARY_CASE_LOWER = 0n;
export const BOUNDARY_CASE_MIDDLE = 1n;
export const BOUNDARY_CASE_UPPER = 2n;

export type BoundaryCaseTag =
  | typeof BOUNDARY_CASE_LOWER
  | typeof BOUNDARY_CASE_MIDDLE
  | typeof BOUNDARY_CASE_UPPER;

/**
 * Compute the boundary-case tag for a given `absent_hash` against a
 * sorted list of real leaf hashes. The sorted list must be in
 * ascending Field-element order (the same ordering the signer's
 * `merkle()` uses; see `noir/lib/utils/src/lib.nr`).
 *
 * - Returns `BOUNDARY_CASE_LOWER` if `absent_hash` strictly precedes
 *   every real leaf.
 * - Returns `BOUNDARY_CASE_UPPER` if `absent_hash` strictly exceeds
 *   every real leaf.
 * - Returns `BOUNDARY_CASE_MIDDLE` otherwise.
 *
 * Throws if `absent_hash` collides with any real leaf -- this would
 * indicate either a hash collision (a publishable cryptographic
 * finding) or a logic error in the caller (the absent hash is
 * actually present in the dataset, so `NOT EXISTS` doesn't apply).
 */
export function computeBoundaryCase(
  absentHash: bigint,
  sortedRealLeafHashes: readonly bigint[],
): BoundaryCaseTag {
  if (sortedRealLeafHashes.length === 0) {
    // Edge case: no real leaves means every absent_hash is bracketed
    // by the two sentinels (Lower and Upper produce the same dispatch
    // shape under N=0; the choice of tag here is arbitrary). We pick
    // Lower for determinism.
    return BOUNDARY_CASE_LOWER;
  }
  const smallest = sortedRealLeafHashes[0]!;
  const largest = sortedRealLeafHashes[sortedRealLeafHashes.length - 1]!;
  if (absentHash < smallest) return BOUNDARY_CASE_LOWER;
  if (absentHash > largest) return BOUNDARY_CASE_UPPER;
  // Reject collisions explicitly -- silently picking `Middle` and
  // letting `verify_non_membership_no_inclusion`'s strict-`<` check
  // fail at proof time would still be sound, but a clear error here
  // is friendlier to the caller and surfaces real bugs faster.
  for (const h of sortedRealLeafHashes) {
    if (h === absentHash) {
      throw new Error(
        `absent_hash ${absentHash} collides with a real leaf -- ` +
          `the would-be "absent" triple is present in the signed dataset. ` +
          `NOT EXISTS does not apply; the row should be excluded by the FILTER.`,
      );
    }
  }
  return BOUNDARY_CASE_MIDDLE;
}

/**
 * Pick the bracketing leaf hashes for an interior-case (Middle) absent
 * hash. Returns the immediate left / right neighbour indices in the
 * sorted real-leaf list. The caller maps these to the input-order
 * triples via the signed-data `paths` / `directions` arrays.
 *
 * Only valid for `BOUNDARY_CASE_MIDDLE`; throws for boundary cases.
 */
export function findMiddleBracketIndices(
  absentHash: bigint,
  sortedRealLeafHashes: readonly bigint[],
): { leftSortedIdx: number; rightSortedIdx: number } {
  if (sortedRealLeafHashes.length === 0) {
    throw new Error('Middle bracket requires at least one real leaf');
  }
  // Linear scan -- the dataset is small (bounded by `MERKLE_DEPTH`'s
  // `2^(M-1)` capacity, e.g. 1024 for the default depth 11). Binary
  // search would shave logs but adds complexity for marginal gain at
  // this scale.
  for (let i = 0; i < sortedRealLeafHashes.length - 1; i++) {
    const left = sortedRealLeafHashes[i]!;
    const right = sortedRealLeafHashes[i + 1]!;
    if (left < absentHash && absentHash < right) {
      return { leftSortedIdx: i, rightSortedIdx: i + 1 };
    }
  }
  throw new Error(
    `findMiddleBracketIndices: absent_hash ${absentHash} is not strictly ` +
      `between any two adjacent sorted real leaves (likely a Lower / Upper ` +
      `boundary case -- use the corresponding sentinel primitive instead)`,
  );
}
