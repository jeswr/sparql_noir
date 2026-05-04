use dep::types::{IndexedRoot, Root, SentinelLeaf, TermWitness, Triple};
use dep::consts;

/// Wrap a quartet of term hashes into the `[TermWitness; 4]` shape that
/// `Triple.terms` expects, with zero-padded byte witnesses
/// (`bytes: [0; STRING_LEN_MAX]`, `length: 0`). Round-1 contract
/// (`spec/encoding.md` sec.6.3): the byte witness is advisory at the
/// Triple level, so a zero placeholder is sound until a string operator
/// binds it locally. Used by the in-crate test harnesses below; the
/// transform-emitted prover code populates `bytes` / `length` from the
/// source quad's lexical form via `prove.ts::termToWitness`.
pub fn term_hashes_to_witnesses(hashes: [Field; 4]) -> [TermWitness; 4] {
    let zero_bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    [
        TermWitness { hash: hashes[0], bytes: zero_bytes, length: 0 },
        TermWitness { hash: hashes[1], bytes: zero_bytes, length: 0 },
        TermWitness { hash: hashes[2], bytes: zero_bytes, length: 0 },
        TermWitness { hash: hashes[3], bytes: zero_bytes, length: 0 },
    ]
}

// Round-4 prefix-tree commitment scaffolding. See
// `spec/prefix-tree-commitment.md`. The module re-uses
// `verify_leaf_inclusion`, `verify_low_sentinel_inclusion`,
// `verify_high_sentinel_inclusion`, and `reconstruct_index` from this
// crate -- prefix-tree primitives are layered on top of the shared
// Merkle-walk machinery, not parallel reimplementations.
pub mod prefix3;

pub struct MerkleInfo<let M: u32, let N: u32> {
    pub triples: [[Field; 4]; N],
    pub root: Field,
    pub root_u8: [u8; 32],
    pub paths: [[Field; M]; N],
    pub direction: [[u8; M - 1]; N],
    /// Inclusion path for the **low sentinel** leaf, which `merkle()`
    /// inserts at sorted index `0` with hash `consts::LOW_SENTINEL_HASH`.
    /// `low_sentinel_path[0] == consts::LOW_SENTINEL_HASH`. Used by
    /// `verify_low_sentinel_inclusion` /
    /// `verify_non_membership_low_sentinel_*` to witness absent hashes
    /// strictly less than the smallest real leaf. See `spec/exists.md`
    /// Sec.3.3.
    pub low_sentinel_path: [Field; M],
    pub low_sentinel_directions: [u8; M - 1],
    /// Inclusion path for the **high sentinel** leaf, at sorted index
    /// `N + 1` with hash `consts::HIGH_SENTINEL_HASH`.
    /// `high_sentinel_path[0] == consts::HIGH_SENTINEL_HASH`. Used by
    /// `verify_high_sentinel_inclusion` /
    /// `verify_non_membership_high_sentinel_*` to witness absent hashes
    /// strictly greater than the largest real leaf.
    pub high_sentinel_path: [Field; M],
    pub high_sentinel_directions: [u8; M - 1],
}

pub fn verify_signatures<let N: u32, let M: u32>(public_key: [consts::signature::PubKey; N], root: [IndexedRoot; M]) {
    for i in 0..M {
        verify_signature(public_key[root[i].index], root[i].root)
    }
}

pub fn verify_signature(public_key: consts::signature::PubKey, root: Root) {
    assert(
        consts::signature::verify_signature(public_key, root.signature, root.value),
        "Signature verification failed",
    );
}

/// Walk the Merkle path from a leaf hash up to the claimed root,
/// asserting each direction bit is Boolean. Shared by `verify_inclusion`
/// (real triple leaves) and `verify_low_sentinel_inclusion` /
/// `verify_high_sentinel_inclusion` (synthetic sentinel leaves whose
/// hash is not derived from a triple's terms).
pub fn verify_leaf_inclusion(
    leaf_hash: Field,
    path: [Field; consts::MERKLE_DEPTH],
    directions: [u8; consts::MERKLE_DEPTH - 1],
    root_value: Field,
) {
    assert_eq(path[0], leaf_hash, "Path leaf does not match the claimed leaf hash");
    let mut current = path[0];
    for i in 1..consts::MERKLE_DEPTH {
        // Constrain `directions[i - 1]` to be a Boolean (0 or 1). Any
        // non-Boolean value would let a prover satisfy inclusion under
        // "anything non-zero = right" semantics while making the
        // index reconstruction in `verify_non_membership_no_inclusion`
        // omit / mis-count the bit -- breaking the adjacency proof's
        // soundness. Roborev finding 2026-05-03 (high).
        let dir = directions[i - 1];
        assert((dir == 0) | (dir == 1), "Merkle direction bit must be 0 or 1");
        current = consts::hash2(
            if dir == 0 { [current, path[i]] } else { [path[i], current] }
        );
    }
    assert_eq(current, root_value, "Path does not lead to the correct root");
}

pub fn verify_inclusion(triple: Triple, root_value: Field) {
    // Real triple leaves: the leaf hash is `hash4(terms)`. The path /
    // direction walk is shared with sentinel-leaf inclusion via
    // `verify_leaf_inclusion`.
    //
    // The Merkle commitment is over the term-hash quartet, not over the
    // bounded byte witness -- see `spec/encoding.md` sec.6.3. The
    // `bytes` / `length` fields of each `TermWitness` are advisory at
    // the Triple level; round-2 string operators bind them locally at
    // use-sites.
    let term_hashes: [Field; 4] = [
        triple.terms[0].hash,
        triple.terms[1].hash,
        triple.terms[2].hash,
        triple.terms[3].hash,
    ];
    verify_leaf_inclusion(
        consts::hash4(term_hashes),
        triple.path,
        triple.directions,
        root_value,
    );
}

/// Verify that `low` is the low-sentinel leaf of the sorted Merkle
/// commitment rooted at `root_value`.
///
/// Checks `low.path[0] == consts::LOW_SENTINEL_HASH`, walks the path
/// up to `root_value` (with Boolean direction bits), and asserts the
/// reconstructed sorted index is `0` (every direction bit is `0`,
/// since the low sentinel sits at the leftmost leaf).
///
/// The index-is-zero assertion is what makes the sentinel a *sentinel*
/// rather than just "any leaf with hash 0": a malicious prover could
/// otherwise supply a low-sentinel-shaped path landing at some interior
/// position, which would break the boundary-bracket adjacency check in
/// `verify_non_membership_low_sentinel_*`.
pub fn verify_low_sentinel_inclusion(low: SentinelLeaf, root_value: Field) {
    verify_leaf_inclusion(
        consts::LOW_SENTINEL_HASH,
        low.path,
        low.directions,
        root_value,
    );
    // Reconstruct the index from `directions` and assert it equals 0.
    // (All direction bits must be 0 -- the low sentinel is the
    // leftmost leaf at every level of the tree.)
    for j in 0..(consts::MERKLE_DEPTH - 1) {
        assert_eq(
            low.directions[j],
            0,
            "low sentinel: direction bit must be 0 (sentinel sits at sorted index 0)",
        );
    }
}

/// Verify that `high` is the high-sentinel leaf of the sorted Merkle
/// commitment rooted at `root_value`.
///
/// Checks `high.path[0] == consts::HIGH_SENTINEL_HASH` and walks the
/// path up to `root_value` (with Boolean direction bits). Unlike the
/// low sentinel, the high sentinel's sorted index is `N + 1` --
/// dataset-dependent -- so we do **not** assert a fixed value of the
/// reconstructed index here. Adjacency to the bracketing real leaf is
/// asserted in `verify_non_membership_high_sentinel_*` via
/// `high_idx == left_idx + 1`, which is sufficient (a prover who
/// supplies a "high sentinel" at some interior position must also
/// supply a left whose index is `high_idx - 1` -- the strict-`<`
/// ordering against `HIGH_SENTINEL_HASH = p - 1` means no real leaf
/// can equal that hash, so the right-of-`left` slot is forced to be
/// the genuine sentinel by the sorted commitment binding).
pub fn verify_high_sentinel_inclusion(high: SentinelLeaf, root_value: Field) {
    verify_leaf_inclusion(
        consts::HIGH_SENTINEL_HASH,
        high.path,
        high.directions,
        root_value,
    );
}

pub fn encode_string<let N: u32>(string: str<N>) -> Field {
    Field::from_le_bytes(consts::hash_string(string.as_bytes()))
}

/// Build a Merkle tree over `triples`, sorted ascending by
/// `consts::hash4(triple)`, with **two synthetic sentinel leaves**
/// always inserted at sorted positions `0` and `N + 1`. The signed
/// root commits to the sorted multiset (with sentinels), which is the
/// load-bearing pre-condition for the non-membership / NOT EXISTS
/// primitive (`spec/exists.md` Sec.3.3).
///
/// **Bag semantics.** Duplicate triples are kept (no canonicalisation):
/// they appear as adjacent equal-hash leaves in the sorted tree. The
/// non-membership primitive uses **strict** `<` ordering against the
/// neighbour leaves, so duplicates do not affect the absence proof's
/// soundness -- the absent hash is, by definition, distinct from every
/// real leaf, including duplicates.
///
/// **Sentinels are mandatory.** Round-3-main-event originally shipped
/// "no implicit sentinels" with the (incorrect) claim that
/// boundary-falling absent hashes were "vanishingly rare". Copilot's
/// review of `sparql_noir#42` (2026-05-03) showed the order-statistic
/// argument actually holds: for `N` uniformly-distributed leaves and a
/// uniform `absent_hash`, `P(absent not in [X_(1), X_(N)]) = 2/(N+1)` --
/// ~18 % at N=10, ~2 % at N=100 -- so a valid `NOT EXISTS` query gets
/// rejected far more often than acceptable. This implementation
/// inserts two sentinel leaves with hashes
/// `consts::LOW_SENTINEL_HASH` (= `0`) and
/// `consts::HIGH_SENTINEL_HASH` (= `0 - 1` = the BN254 prime minus
/// one) so every absent hash is bracketable. The sentinels' hashes are
/// fixed by ABI, not derived from any triple, and bypass `hash4`
/// entirely; the `verify_low_sentinel_inclusion` /
/// `verify_high_sentinel_inclusion` primitives skip the
/// `hash4(terms) == path[0]` step.
///
/// **BREAKING -- root rotation.** Inserting sentinels changes the
/// committed Merkle root for every dataset; signatures and inclusion
/// paths produced by the pre-sentinel `merkle()` (every release prior
/// to the round-3 follow-up) are no longer valid against this
/// circuit. Datasets must be re-signed via `src/scripts/sign.ts` (the
/// public `sign()` API now calls the sentinel-aware `merkle()`).
/// Stored signatures need to be regenerated at the same time as
/// upgrading the prover/verifier sub-repo; mixing pre- and
/// post-sentinel artefacts will fail the inclusion check. There is no
/// in-circuit migration path -- this is a one-time corpus rotation.
pub fn merkle<let M: u32, let N: u32>(triples: [[Field; 4]; N]) -> MerkleInfo<M, N> {
    // Capacity bound. Level-0 of the tree stores `N + 2` populated
    // leaves (sentinels at indices `0` and `N + 1` plus the `N` real
    // leaves at `1..=N`). Two constraints apply:
    //
    // 1. The fixed `[Field; 1024]` slab per level limits writes to
    //    indices `< 1024`, so `N + 2 <= 1024`.
    // 2. The Merkle tree's logical level-0 capacity for depth `M` is
    //    `2^(M - 1)`. For `M < 11` (e.g. shallower trees configured
    //    via `setup.ts --depth 9`), the slab is larger than the
    //    logical capacity -- writes beyond `2^(M - 1)` would land in
    //    the slab but never get hashed into the root, producing an
    //    incomplete commitment. Roborev finding 2026-05-03 (medium).
    //
    // Both bounds are checked at circuit-compile time so a too-large
    // `N` fails before any silent miscommitment can happen.
    std::static_assert(
        N + 2 <= 1024,
        "merkle: N + 2 (real leaves + sentinels) exceeds the 1024-slot tree-level capacity",
    );
    // Slab depth bound. The slab is dimensioned `[[Field; 1024]; M]`
    // per level, but level-`i`'s sibling lookup `tree[i - 1][index ^
    // 1]` for index up to `2^(M - 1) - 1` requires the level array
    // to fit `2^(M - 1)` slots. Beyond `M = 11` (so `2^(M - 1) =
    // 1024`), the slab can no longer hold the level. Reject those
    // depths here -- the upstream `setup.ts --depth` defaults
    // already use 11; deeper trees need the slab dimension lifted.
    // Roborev finding 2026-05-03 (medium).
    std::static_assert(
        M <= 11,
        "merkle: M > 11 exceeds the fixed 1024-slot per-level slab",
    );
    // Compute `2^(M - 1)` as a `u32` using a small loop so the
    // shift's type doesn't fight the `static_assert` comparison.
    let mut logical_capacity: u32 = 1;
    for _ in 0..(M - 1) {
        logical_capacity *= 2;
    }
    std::static_assert(
        N + 2 <= logical_capacity,
        "merkle: N + 2 exceeds the logical level-0 capacity 2^(M - 1) of the tree",
    );

    let mut tree = [[0; 1024]; M];
    let mut paths = [[0; M]; N];
    let mut direction = [[0; M - 1]; N];

    // Compute leaf hashes and an associated permutation that sorts them
    // ascending by hash. The sort is implemented as a simple insertion
    // sort over `N`: this is `O(N^2)` but `N` is the number of triples
    // in a single signed dataset, which is bounded by the deployment's
    // protocol design (typically tens to a few thousand) -- well within
    // tractable. The sort is stable: equal-hash leaves keep their
    // original input order, so the canonical root is uniquely
    // determined by the input set.
    let mut leaf_hashes: [Field; N] = [0; N];
    for i in 0..N {
        leaf_hashes[i] = consts::hash4(triples[i]);
    }

    // `sorted_idx[k]` = index in the input array of the k-th smallest
    // leaf. We don't reorder `triples` itself -- the `MerkleInfo.triples`
    // / `paths` / `direction` arrays in the returned struct stay
    // input-order so downstream code (which references positional
    // metadata) is unaffected. The tree itself is built over the
    // sorted leaves, with sentinels at positions 0 and N+1.
    let mut sorted_idx: [u32; N] = [0; N];
    for k in 0..N {
        sorted_idx[k] = k;
    }
    // Insertion sort by leaf_hashes[sorted_idx[k]].
    for i in 1..N {
        let mut j = i;
        for _ in 0..N {
            if j > 0 {
                let a = leaf_hashes[sorted_idx[j - 1]];
                let b = leaf_hashes[sorted_idx[j]];
                if a.lt(b) {
                    // already in order, stop
                    j = 0;
                } else if a == b {
                    // tie -- keep input order (sorted_idx[j-1] < sorted_idx[j]
                    // when they were equal at construction time, since we
                    // initialised sequentially and only swap on strict gt)
                    j = 0;
                } else {
                    // swap
                    let tmp = sorted_idx[j - 1];
                    sorted_idx[j - 1] = sorted_idx[j];
                    sorted_idx[j] = tmp;
                    j -= 1;
                }
            }
        }
    }

    // `inv_idx[input_pos]` = the sorted position (within the
    // sentinel-bracketed tree, so shifted by +1) the input-pos-th leaf
    // ended up at. Used to compute Merkle paths for each leaf in input
    // order without reshuffling the input arrays.
    let mut inv_idx: [u32; N] = [0; N];
    for k in 0..N {
        inv_idx[sorted_idx[k]] = k + 1;
    }

    // Lay out the tree's level-0:
    // - `tree[0][0] = LOW_SENTINEL_HASH`,
    // - `tree[0][1..=N] = sorted real leaves`,
    // - `tree[0][N + 1] = HIGH_SENTINEL_HASH`,
    // - everything else stays zero (the existing zero-padding).
    tree[0][0] = consts::LOW_SENTINEL_HASH;
    for k in 0..N {
        tree[0][k + 1] = leaf_hashes[sorted_idx[k]];
    }
    tree[0][N + 1] = consts::HIGH_SENTINEL_HASH;

    for i in 1..M {
        let mut max: u32 = 1;

        for _ in 0..(M - 1 - i) {
            max *= 2;
        }

        for j in 0..max {
            tree[i][j] = consts::hash2([tree[i - 1][j * 2], tree[i - 1][j * 2 + 1]]);
        }
    }

    // Generate paths for each input triple, using its sorted-tree
    // position (already shifted by +1 to account for the low sentinel
    // at index 0). `paths[i][0]` is still the leaf's own hash.
    for i in 0..N {
        let mut index = inv_idx[i];

        paths[i][0] = tree[0][index];

        for j in 1..M {
            paths[i][j] = tree[j - 1][index ^ 1]; // XOR to get the sibling node
            direction[i][j - 1] = if index % 2 == 0 { 0 } else { 1 }; // 0 for left, 1 for right
            index /= 2; // Move up the tree
        }
    }

    // Generate the low-sentinel inclusion path. Sorted index is 0
    // (every direction bit is 0).
    let mut low_sentinel_path: [Field; M] = [0; M];
    let mut low_sentinel_directions: [u8; M - 1] = [0; M - 1];
    {
        let mut index: u32 = 0;
        low_sentinel_path[0] = tree[0][index];
        for j in 1..M {
            low_sentinel_path[j] = tree[j - 1][index ^ 1];
            low_sentinel_directions[j - 1] = if index % 2 == 0 { 0 } else { 1 };
            index /= 2;
        }
    }

    // Generate the high-sentinel inclusion path. Sorted index is N + 1.
    let mut high_sentinel_path: [Field; M] = [0; M];
    let mut high_sentinel_directions: [u8; M - 1] = [0; M - 1];
    {
        let mut index: u32 = N + 1;
        high_sentinel_path[0] = tree[0][index];
        for j in 1..M {
            high_sentinel_path[j] = tree[j - 1][index ^ 1];
            high_sentinel_directions[j - 1] = if index % 2 == 0 { 0 } else { 1 };
            index /= 2;
        }
    }

    let root = tree[M - 1][0];
    let root_u8: [u8; 32] = root.to_le_bytes();

    MerkleInfo {
        triples,
        root,
        root_u8,
        paths,
        direction,
        low_sentinel_path,
        low_sentinel_directions,
        high_sentinel_path,
        high_sentinel_directions,
    }
}

#[test]
fn test_merkle_sorted_root() {
    // Three triples, supplied in arbitrary order. The sorted-root
    // canonicalisation means the same set of triples in any input
    // permutation must yield the same root. We verify two permutations
    // produce equal roots.
    let triples_a = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let triples_b = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]];
    let merkle_a = merkle::<11, 3>(triples_a);
    let merkle_b = merkle::<11, 3>(triples_b);
    assert_eq(merkle_a.root, merkle_b.root, "Sorted-commitment root must be permutation-invariant");
}

#[test]
fn test_merkle_paths_lead_to_sorted_root() {
    // Each input triple's path must lead to the sorted root. Validates
    // that paths/inv_idx stay consistent after sorting (now with the
    // sentinels at sorted indices 0 and N+1).
    let triples = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let info = merkle::<11, 3>(triples);
    for i in 0..3 {
        let mut current = info.paths[i][0];
        // Reconstruct manually using the directions vector.
        for j in 1..11 {
            current = if info.direction[i][j - 1] == 0 {
                consts::hash2([current, info.paths[i][j]])
            } else {
                consts::hash2([info.paths[i][j], current])
            };
        }
        assert_eq(current, info.root, "Triple's path must lead to the sorted root");
        assert_eq(consts::hash4(info.triples[i]), info.paths[i][0], "Path leaf must be hash4 of triple");
    }
}

#[test]
fn test_sentinel_paths_lead_to_root() {
    // The two sentinel paths emitted by `merkle()` must verify against
    // the sorted root, and their leaf hashes must equal the ABI sentinel
    // constants.
    let triples = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let info = merkle::<11, 3>(triples);
    assert_eq(
        info.low_sentinel_path[0],
        consts::LOW_SENTINEL_HASH,
        "low sentinel path[0] must equal LOW_SENTINEL_HASH",
    );
    assert_eq(
        info.high_sentinel_path[0],
        consts::HIGH_SENTINEL_HASH,
        "high sentinel path[0] must equal HIGH_SENTINEL_HASH",
    );

    let low_leaf = SentinelLeaf {
        path: info.low_sentinel_path,
        directions: info.low_sentinel_directions,
    };
    verify_low_sentinel_inclusion(low_leaf, info.root);

    let high_leaf = SentinelLeaf {
        path: info.high_sentinel_path,
        directions: info.high_sentinel_directions,
    };
    verify_high_sentinel_inclusion(high_leaf, info.root);
}

#[test]
fn test_non_membership_low_boundary() {
    // Property test: an `absent_hash` falling **below the smallest
    // real leaf** must be witnessable via the low sentinel. This is
    // the lower-boundary case Copilot flagged on `sparql_noir#42` --
    // before sentinels, `verify_non_membership_no_inclusion` had no
    // way to bracket it.
    //
    // We pick three real triples and identify the input-triple whose
    // sorted position is 1 (immediately after the low sentinel, i.e.
    // the smallest real leaf). The absent hash is `1` -- strictly
    // between `LOW_SENTINEL_HASH = 0` and any non-zero real
    // `hash4(triple)`.
    let triples = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let info = merkle::<11, 3>(triples);

    let low_leaf = SentinelLeaf {
        path: info.low_sentinel_path,
        directions: info.low_sentinel_directions,
    };

    // Find which input triple ended up at sorted index 1 (smallest
    // real leaf) -- its directions reconstruct to 1.
    let mut smallest_idx: u32 = 0;
    let mut found: bool = false;
    for i in 0..3 {
        let mut idx: u64 = 0;
        let mut bit: u64 = 1;
        // Inner-leaf direction has `MERKLE_DEPTH - 1` siblings (the leaf
        // sits below the bottom internal level). Iterate by the constant
        // so the test stays correct if `MERKLE_DEPTH` is retuned.
        for j in 0..(consts::MERKLE_DEPTH - 1) {
            if info.direction[i][j] == 1 {
                idx += bit;
            }
            bit *= 2;
        }
        if idx == 1 {
            smallest_idx = i as u32;
            found = true;
        }
    }
    assert(found, "test fixture: no input triple at sorted index 1");

    let smallest = Triple {
        terms: term_hashes_to_witnesses(info.triples[smallest_idx]),
        path: info.paths[smallest_idx],
        directions: info.direction[smallest_idx],
    };

    let absent_hash: Field = 1;
    // Sanity: absent_hash must strictly precede the smallest real leaf.
    assert(absent_hash.lt(smallest.path[0]), "test fixture: absent hash >= smallest real leaf");

    verify_non_membership_low_sentinel(low_leaf, smallest, absent_hash, info.root);
}

#[test]
fn test_non_membership_high_boundary() {
    // Property test: an `absent_hash` falling **above the largest real
    // leaf** must be witnessable via the high sentinel.
    //
    // The absent hash is `HIGH_SENTINEL_HASH - 1 = -2` (= p - 2).
    // Strictly greater than any real `hash4(triple)` under
    // Pedersen-hash collision-resistance, and strictly less than
    // `HIGH_SENTINEL_HASH`.
    let triples = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let info = merkle::<11, 3>(triples);

    let high_leaf = SentinelLeaf {
        path: info.high_sentinel_path,
        directions: info.high_sentinel_directions,
    };

    // Find which input triple ended up at sorted index 3 (largest
    // real leaf -- the last before the high sentinel).
    let mut largest_idx: u32 = 0;
    let mut found: bool = false;
    for i in 0..3 {
        let mut idx: u64 = 0;
        let mut bit: u64 = 1;
        // Same MERKLE_DEPTH-driven loop bound as the low-boundary test above.
        for j in 0..(consts::MERKLE_DEPTH - 1) {
            if info.direction[i][j] == 1 {
                idx += bit;
            }
            bit *= 2;
        }
        if idx == 3 {
            largest_idx = i as u32;
            found = true;
        }
    }
    assert(found, "test fixture: no input triple at sorted index 3");

    let largest = Triple {
        terms: term_hashes_to_witnesses(info.triples[largest_idx]),
        path: info.paths[largest_idx],
        directions: info.direction[largest_idx],
    };

    let absent_hash: Field = consts::HIGH_SENTINEL_HASH - 1;
    // Sanity: absent_hash must strictly exceed the largest real leaf.
    assert(largest.path[0].lt(absent_hash), "test fixture: largest real leaf >= absent hash");

    verify_non_membership_high_sentinel(largest, high_leaf, absent_hash, info.root);
}

/// Reconstruct the little-endian index encoded by a Merkle directions
/// vector and assert each direction bit is Boolean. Shared by all four
/// `verify_non_membership_*` variants.
///
/// Direction bits are constrained to Booleans by `verify_inclusion`
/// (which always runs over the leaves before the ordering / adjacency
/// check from the transform-emitted body, or as part of the composite
/// `verify_non_membership` wrapper). Re-asserting here is defence in
/// depth -- the `_no_inclusion` variants are exposed publicly and a
/// future caller that bypasses `verify_inclusion` would otherwise be
/// exposed to the high-severity Roborev 2026-05-03 finding.
pub fn reconstruct_index(directions: [u8; consts::MERKLE_DEPTH - 1]) -> u64 {
    let mut idx: u64 = 0;
    let mut bit: u64 = 1;
    for j in 0..(consts::MERKLE_DEPTH - 1) {
        let d = directions[j];
        assert((d == 0) | (d == 1), "non-membership: direction bit must be 0 or 1");
        if d == 1 {
            idx += bit;
        }
        bit *= 2;
    }
    idx
}

/// Non-membership proof against the sorted Merkle commitment, **interior
/// case** -- `absent_hash` strictly between two adjacent real leaves.
/// For the boundary cases (`absent_hash` below the smallest real leaf or
/// above the largest), use `verify_non_membership_low_sentinel` /
/// `verify_non_membership_high_sentinel` -- those bracket against the
/// permanent sentinel leaves that `merkle()` injects at sorted indices
/// `0` and `N + 1`.
///
/// Given two adjacent leaves in the sorted tree (`left` at sorted index
/// `i`, `right` at sorted index `i + 1`) and an `absent_hash` that the
/// caller claims is not in the tree, this primitive verifies:
///
/// 1. Both `left` and `right` are valid leaves of the same Merkle tree
///    (their inclusion paths lead to `root_value`).
/// 2. `left.path[0] < absent_hash < right.path[0]` -- strict ordering.
/// 3. `right`'s sorted index equals `left`'s sorted index plus one
///    (adjacency), recovered from the `directions` arrays.
///
/// **Soundness.** Since the signer's `merkle()` builds the tree over
/// sorted leaves, a malicious prover cannot construct an inclusion
/// proof for a leaf at sorted index `j` whose value differs from
/// `tree[0][j]` (Merkle binding under hash collision-resistance). So
/// the only valid `(left, right)` pairs at consecutive indices are
/// genuinely consecutive leaves in the sorted tree. If
/// `left.hash < absent_hash < right.hash` and `(left, right)` are
/// genuinely consecutive in the sorted tree, then `absent_hash` cannot
/// equal any `tree[0][k]` -- otherwise that `k` would be wedged between
/// the two consecutive sorted indices, contradicting consecutiveness.
///
/// **Bag-semantics note.** Equal-hash duplicates are permitted in the
/// tree (see `merkle` doc-comment). Strict `<` against the absent hash
/// is correct: duplicates have hash equal to one of the real triples,
/// and strict `<` means `absent_hash` is provably distinct from every
/// real triple's hash, regardless of multiplicity.
pub fn verify_non_membership(
    left: Triple,
    right: Triple,
    absent_hash: Field,
    root_value: Field,
) {
    // Both leaves are committed.
    verify_inclusion(left, root_value);
    verify_inclusion(right, root_value);

    verify_non_membership_no_inclusion(left, right, absent_hash);
}

/// The ordering / adjacency half of `verify_non_membership`. Use this
/// when the bracketing leaves are already passed through
/// `verify_inclusion` elsewhere (e.g. they live in `bgp` and the
/// generated `main.nr` walks `bgp` for inclusion). The transform-layer
/// lowering for `NOT EXISTS` and `MINUS` uses this variant -- it places
/// the bracketing leaves at dedicated `bgp[k]` slots and emits the
/// ordering / adjacency check inside `sparql.nr::checkBinding`.
pub fn verify_non_membership_no_inclusion(
    left: Triple,
    right: Triple,
    absent_hash: Field,
) {
    // Ordering: left < absent < right (strict).
    assert(left.path[0].lt(absent_hash), "non-membership: left leaf hash >= absent hash");
    assert(absent_hash.lt(right.path[0]), "non-membership: absent hash >= right leaf hash");

    // Adjacency: right's sorted index = left's sorted index + 1.
    let left_idx = reconstruct_index(left.directions);
    let right_idx = reconstruct_index(right.directions);
    assert_eq(
        right_idx,
        left_idx + 1,
        "non-membership: right leaf is not adjacent to left leaf",
    );
}

/// Non-membership proof against the sorted Merkle commitment, **lower
/// boundary case** -- `absent_hash` strictly less than every real leaf
/// in the dataset (so it would sort *before* the smallest real leaf).
///
/// Brackets `absent_hash` against the permanent low sentinel
/// (`tree[0][0] = consts::LOW_SENTINEL_HASH`) on the left and the
/// smallest real leaf on the right. Verifies:
///
/// 1. The low sentinel is a valid leaf of the same Merkle tree, and
///    sits at sorted index `0` (every direction bit is `0`).
/// 2. `right` is a valid leaf of the same tree.
/// 3. `LOW_SENTINEL_HASH < absent_hash < right.path[0]` -- strict
///    ordering. Since `LOW_SENTINEL_HASH = 0`, the left-hand strict
///    inequality reduces to `absent_hash != 0`. This is a preimage
///    event (a specific output value), not a collision, so it is
///    bounded by Pedersen-hash preimage-resistance: the probability of
///    any specific `consts::hash4(triple)` equalling `0` is `<= 1/p`
///    under the random-oracle model (BN254 has `p ~= 2^254`, so `2^-254`
///    -- negligible). A real-world preimage would itself be a
///    publishable cryptographic finding; rotate the sentinel constants.
/// 4. `right`'s reconstructed sorted index is `1` (adjacency to the
///    sentinel at index 0).
///
/// **Sentinels are mandatory** (see `merkle()` doc-comment and
/// `spec/exists.md` Sec.3.3). Without them, an `absent_hash` falling
/// below every real leaf would be unwitnessable, which Copilot's
/// review of `sparql_noir#42` showed rejects valid `NOT EXISTS`
/// queries with probability `1/(N+1)` per boundary.
pub fn verify_non_membership_low_sentinel(
    low: SentinelLeaf,
    right: Triple,
    absent_hash: Field,
    root_value: Field,
) {
    verify_low_sentinel_inclusion(low, root_value);
    verify_inclusion(right, root_value);

    verify_non_membership_low_sentinel_no_inclusion(low, right, absent_hash);
}

/// The ordering / adjacency half of
/// `verify_non_membership_low_sentinel`. Used when both the sentinel and
/// the right-bracketing real leaf have been inclusion-checked elsewhere.
pub fn verify_non_membership_low_sentinel_no_inclusion(
    low: SentinelLeaf,
    right: Triple,
    absent_hash: Field,
) {
    // Ordering: LOW_SENTINEL_HASH < absent < right (strict). The
    // left-side strict comparison ensures the absent hash is not the
    // sentinel itself. A real triple having `hash4(...) == 0` is a
    // preimage event (not a collision); under Pedersen-hash preimage-
    // resistance the probability is `<= 1/p ~= 2^-254`, so this is
    // negligible rather than impossible.
    assert_eq(low.path[0], consts::LOW_SENTINEL_HASH, "non-membership: low sentinel hash mismatch");
    assert(consts::LOW_SENTINEL_HASH.lt(absent_hash), "non-membership: absent hash <= low sentinel");
    assert(absent_hash.lt(right.path[0]), "non-membership: absent hash >= right leaf hash");

    // Adjacency: right's sorted index = 1 (every low-sentinel
    // direction bit must be 0; right's directions encode the index
    // `1`, i.e. the lowest bit set, all higher bits 0).
    for j in 0..(consts::MERKLE_DEPTH - 1) {
        let d = low.directions[j];
        assert((d == 0) | (d == 1), "non-membership: low direction bit must be 0 or 1");
        assert_eq(d, 0, "non-membership: low sentinel must sit at sorted index 0");
    }
    let right_idx = reconstruct_index(right.directions);
    assert_eq(
        right_idx,
        1,
        "non-membership: right leaf is not adjacent to the low sentinel (sorted index 1)",
    );
}

/// Non-membership proof against the sorted Merkle commitment, **upper
/// boundary case** -- `absent_hash` strictly greater than every real
/// leaf in the dataset (so it would sort *after* the largest real
/// leaf).
///
/// Brackets `absent_hash` against the largest real leaf on the left
/// and the permanent high sentinel
/// (`tree[0][N + 1] = consts::HIGH_SENTINEL_HASH`) on the right.
/// Verifies:
///
/// 1. `left` is a valid leaf of the Merkle tree.
/// 2. The high sentinel is a valid leaf of the same tree (its
///    inclusion path leads to `root_value`).
/// 3. `left.path[0] < absent_hash < HIGH_SENTINEL_HASH` -- strict
///    ordering. Since `HIGH_SENTINEL_HASH = p - 1`, the right-hand
///    strict inequality reduces to `absent_hash != p - 1`. This is a
///    preimage event (a specific output value), not a collision, so
///    it is bounded by Pedersen-hash preimage-resistance: the
///    probability of any specific `consts::hash4(triple)` equalling
///    `p - 1` is `<= 1/p` under the random-oracle model
///    (BN254 has `p ~= 2^254`, so `2^-254` -- negligible).
/// 4. The high sentinel's reconstructed sorted index equals
///    `left_idx + 1` (adjacency).
///
/// Unlike the low sentinel, we don't pin the high sentinel's index to
/// a fixed value (`N + 1` is dataset-dependent and `N` isn't a
/// circuit-time constant); the relative `high_idx == left_idx + 1`
/// adjacency is sufficient because the sorted commitment binds
/// `tree[0][left_idx + 1]` to `HIGH_SENTINEL_HASH` only when
/// `left_idx + 1 == N + 1` (no real leaf can equal `p - 1` under
/// Pedersen-hash collision-resistance).
pub fn verify_non_membership_high_sentinel(
    left: Triple,
    high: SentinelLeaf,
    absent_hash: Field,
    root_value: Field,
) {
    verify_inclusion(left, root_value);
    verify_high_sentinel_inclusion(high, root_value);

    verify_non_membership_high_sentinel_no_inclusion(left, high, absent_hash);
}

/// The ordering / adjacency half of
/// `verify_non_membership_high_sentinel`. Used when both the
/// left-bracketing real leaf and the high sentinel have been
/// inclusion-checked elsewhere.
pub fn verify_non_membership_high_sentinel_no_inclusion(
    left: Triple,
    high: SentinelLeaf,
    absent_hash: Field,
) {
    // Ordering: left < absent < HIGH_SENTINEL_HASH (strict).
    assert_eq(high.path[0], consts::HIGH_SENTINEL_HASH, "non-membership: high sentinel hash mismatch");
    assert(left.path[0].lt(absent_hash), "non-membership: left leaf hash >= absent hash");
    assert(absent_hash.lt(consts::HIGH_SENTINEL_HASH), "non-membership: absent hash >= high sentinel");

    // Adjacency: high sentinel's sorted index = left's sorted index + 1.
    let left_idx = reconstruct_index(left.directions);
    let high_idx = reconstruct_index(high.directions);
    assert_eq(
        high_idx,
        left_idx + 1,
        "non-membership: high sentinel is not adjacent to the left leaf",
    );
}

/// Simulate the `checkBinding` runtime dispatch the transform layer
/// emits for each `NonExistenceConstraint`. The transform output (see
/// `transform/src/emit.rs`) wraps the three `_no_inclusion` primitives
/// in an `if boundary_cases[i] == X` chain; this helper mirrors that
/// shape so the integration test below can exercise the dispatch
/// without re-running the full transform pipeline.
///
/// Used by the `transform_dispatch_*` tests below to validate that the
/// dispatch-shape Noir code emitted by the transform compiles +
/// constrains correctly for each of the three boundary cases.
fn dispatch_non_membership(
    low_sentinel: SentinelLeaf,
    high_sentinel: SentinelLeaf,
    bgp_left: Triple,
    bgp_right: Triple,
    absent_hash: Field,
    boundary_case: Field,
) {
    if boundary_case == 0 {
        verify_non_membership_low_sentinel_no_inclusion(low_sentinel, bgp_right, absent_hash);
    } else if boundary_case == 1 {
        verify_non_membership_no_inclusion(bgp_left, bgp_right, absent_hash);
    } else if boundary_case == 2 {
        verify_non_membership_high_sentinel_no_inclusion(bgp_left, high_sentinel, absent_hash);
    } else {
        assert(false, "non-membership: boundary_case must be 0 (Lower), 1 (Middle), or 2 (Upper)");
    }
}

#[test]
fn test_transform_dispatch_lower_boundary() {
    // End-to-end transform-shape test: `absent_hash` falls below the
    // smallest real leaf, so the dispatch must select the Lower arm
    // (boundary_case = 0). The right bracket is the smallest real
    // leaf; the left bracket BGP slot is a *dummy* (any inclusion-
    // valid leaf -- here the same smallest real leaf, since its
    // directions still reconstruct correctly via inclusion). The
    // dispatch's Lower arm ignores the left BGP slot and uses
    // `low_sentinel` instead.
    let triples = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let info = merkle::<11, 3>(triples);

    // Find the smallest real leaf (sorted index 1).
    let mut smallest_idx: u32 = 0;
    for i in 0..3 {
        let mut idx: u64 = 0;
        let mut bit: u64 = 1;
        for j in 0..10 {
            if info.direction[i][j] == 1 {
                idx += bit;
            }
            bit *= 2;
        }
        if idx == 1 {
            smallest_idx = i as u32;
        }
    }

    let smallest = Triple {
        terms: term_hashes_to_witnesses(info.triples[smallest_idx]),
        path: info.paths[smallest_idx],
        directions: info.direction[smallest_idx],
    };
    let low_leaf = SentinelLeaf {
        path: info.low_sentinel_path,
        directions: info.low_sentinel_directions,
    };
    let high_leaf = SentinelLeaf {
        path: info.high_sentinel_path,
        directions: info.high_sentinel_directions,
    };

    // `absent_hash = 1` is strictly less than any non-zero real leaf
    // (Pedersen-hash collision-resistance ensures real leaves don't
    // collide with `1` either).
    let absent_hash: Field = 1;

    // Dispatch with boundary_case = 0 (Lower). The dummy left bracket
    // is `smallest` -- it's still a valid included leaf, but the
    // Lower arm never reads its hash.
    dispatch_non_membership(low_leaf, high_leaf, smallest, smallest, absent_hash, 0);
}

#[test]
fn test_transform_dispatch_middle_interior() {
    // End-to-end transform-shape test: `absent_hash` between two
    // adjacent real leaves -- the Middle case. Dispatch with
    // `boundary_case = 1` should fire the interior primitive.
    //
    // We construct three triples with carefully spaced hashes so
    // there's a gap between sorted index 1 and sorted index 2 that we
    // can witness an absent hash in.
    let triples = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let info = merkle::<11, 3>(triples);

    // Find sorted indices 1 and 2 (smallest two real leaves).
    let mut idx1: u32 = 0;
    let mut idx2: u32 = 0;
    for i in 0..3 {
        let mut idx: u64 = 0;
        let mut bit: u64 = 1;
        for j in 0..10 {
            if info.direction[i][j] == 1 {
                idx += bit;
            }
            bit *= 2;
        }
        if idx == 1 {
            idx1 = i as u32;
        } else if idx == 2 {
            idx2 = i as u32;
        }
    }

    let left = Triple {
        terms: term_hashes_to_witnesses(info.triples[idx1]),
        path: info.paths[idx1],
        directions: info.direction[idx1],
    };
    let right = Triple {
        terms: term_hashes_to_witnesses(info.triples[idx2]),
        path: info.paths[idx2],
        directions: info.direction[idx2],
    };
    let low_leaf = SentinelLeaf {
        path: info.low_sentinel_path,
        directions: info.low_sentinel_directions,
    };
    let high_leaf = SentinelLeaf {
        path: info.high_sentinel_path,
        directions: info.high_sentinel_directions,
    };

    // Pick `absent_hash` strictly between left and right hashes.
    // Both are concrete `consts::hash4(triples[*])` values; their
    // arithmetic mean isn't generally between them as Field elements,
    // but `left.path[0] + 1` is provably distinct from both real
    // hashes (Pedersen-hash collision-resistance) and provably
    // greater than `left.path[0]` if right.path[0] > left.path[0] + 1.
    let absent_hash: Field = left.path[0] + 1;
    assert(left.path[0].lt(absent_hash), "fixture: left < absent");
    assert(absent_hash.lt(right.path[0]), "fixture: absent < right");

    dispatch_non_membership(low_leaf, high_leaf, left, right, absent_hash, 1);
}

#[test]
fn test_transform_dispatch_upper_boundary() {
    // End-to-end transform-shape test: `absent_hash` above the
    // largest real leaf -- the Upper case. Dispatch with
    // `boundary_case = 2` should fire the high-sentinel primitive.
    let triples = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let info = merkle::<11, 3>(triples);

    // Find the largest real leaf (sorted index 3 = N).
    let mut largest_idx: u32 = 0;
    for i in 0..3 {
        let mut idx: u64 = 0;
        let mut bit: u64 = 1;
        for j in 0..10 {
            if info.direction[i][j] == 1 {
                idx += bit;
            }
            bit *= 2;
        }
        if idx == 3 {
            largest_idx = i as u32;
        }
    }

    let largest = Triple {
        terms: term_hashes_to_witnesses(info.triples[largest_idx]),
        path: info.paths[largest_idx],
        directions: info.direction[largest_idx],
    };
    let low_leaf = SentinelLeaf {
        path: info.low_sentinel_path,
        directions: info.low_sentinel_directions,
    };
    let high_leaf = SentinelLeaf {
        path: info.high_sentinel_path,
        directions: info.high_sentinel_directions,
    };

    let absent_hash: Field = consts::HIGH_SENTINEL_HASH - 1;
    assert(largest.path[0].lt(absent_hash), "fixture: largest < absent");
    assert(absent_hash.lt(consts::HIGH_SENTINEL_HASH), "fixture: absent < HIGH_SENTINEL_HASH");

    // Dispatch with boundary_case = 2 (Upper). The dummy right
    // bracket is `largest` -- the Upper arm reads `high_sentinel`
    // for the right bracket and ignores the BGP right slot.
    dispatch_non_membership(low_leaf, high_leaf, largest, largest, absent_hash, 2);
}

#[test(should_fail_with = "non-membership: boundary_case must be 0")]
fn test_transform_dispatch_invalid_boundary_case_rejected() {
    // Soundness check: a malicious prover supplying a `boundary_case`
    // outside `{0, 1, 2}` must be rejected outright. The `else` arm
    // of the dispatch chain is `assert(false, ...)` so any out-of-
    // range tag fails the proof.
    let triples = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let info = merkle::<11, 3>(triples);

    let mut idx1: u32 = 0;
    for i in 0..3 {
        let mut idx: u64 = 0;
        let mut bit: u64 = 1;
        for j in 0..10 {
            if info.direction[i][j] == 1 {
                idx += bit;
            }
            bit *= 2;
        }
        if idx == 1 {
            idx1 = i as u32;
        }
    }
    let leaf = Triple {
        terms: term_hashes_to_witnesses(info.triples[idx1]),
        path: info.paths[idx1],
        directions: info.direction[idx1],
    };
    let low_leaf = SentinelLeaf {
        path: info.low_sentinel_path,
        directions: info.low_sentinel_directions,
    };
    let high_leaf = SentinelLeaf {
        path: info.high_sentinel_path,
        directions: info.high_sentinel_directions,
    };

    // `boundary_case = 7` is out of range; the dispatch's `else` arm
    // fires and asserts false.
    dispatch_non_membership(low_leaf, high_leaf, leaf, leaf, 1, 7);
}

/// Boolean-returning variant of `verify_non_membership_no_inclusion`.
/// Returns `true` iff the ordering and adjacency constraints hold.
///
/// **Why a boolean variant exists.** The asserting variant is convenient
/// when non-membership must hold unconditionally (NOT EXISTS / MINUS).
/// The round-3-follow-up tiered partial OPTIONAL collapse (`spec/exists.md`
/// section 4.1) lowers the OPTIONAL's two arms to
/// `assert(matched | unmatched)` -- both arms must be Field-valued
/// booleans inside a single assertion. The asserting variant cannot
/// appear inside an `|` because it has no return value.
///
/// Soundness is identical to `verify_non_membership_no_inclusion`: every
/// constituent check becomes a bit `&`-folded into `ok`, so the returned
/// `true` is equivalent to the asserting variant having succeeded. The
/// Boolean direction-bit invariants stay enforced (defence-in-depth
/// against the high-severity 2026-05-03 finding).
pub fn verify_non_membership_no_inclusion_check(
    left: Triple,
    right: Triple,
    absent_hash: Field,
) -> bool {
    let mut ok: bool = true;
    ok &= left.path[0].lt(absent_hash);
    ok &= absent_hash.lt(right.path[0]);

    let mut left_idx: u64 = 0;
    let mut right_idx: u64 = 0;
    let mut bit: u64 = 1;
    for j in 0..(consts::MERKLE_DEPTH - 1) {
        let l = left.directions[j];
        let r = right.directions[j];
        ok &= (l == 0) | (l == 1);
        ok &= (r == 0) | (r == 1);
        if l == 1 {
            left_idx += bit;
        }
        if r == 1 {
            right_idx += bit;
        }
        bit *= 2;
    }
    ok & (right_idx == left_idx + 1)
}

// =============================================================================
// Bounded byte-array witness -- round-1 plumbing tests
// =============================================================================
// These tests live alongside the inclusion / non-membership tests because
// they exercise the same `Triple` shape under the new
// `terms: [TermWitness; 4]` layout. Round 2 will add string-operator
// tests in `noir/lib/xpath`; round 1 only demonstrates that the BGP
// path still works and the `bytes` field is reachable.

/// Helper: build a `Triple` whose hashes match the sorted-tree leaf at
/// position `i` and whose byte witnesses are the supplied `bytes` /
/// `length` values. Round-1 contract (see `spec/encoding.md` sec.6.3): the
/// byte witness is advisory -- `verify_inclusion` only binds the `hash`
/// field to the Merkle root.
fn make_triple_with_bytes(
    info: MerkleInfo<11, 3>,
    i: u32,
    bytes: [[u8; consts::STRING_LEN_MAX]; 4],
    length: [u32; 4],
) -> Triple {
    let raw = info.triples[i];
    let mut path: [Field; 11] = [0; 11];
    for j in 0..11 {
        path[j] = info.paths[i][j];
    }
    let mut directions: [u8; 10] = [0; 10];
    for j in 0..10 {
        directions[j] = info.direction[i][j];
    }
    let terms: [TermWitness; 4] = [
        TermWitness { hash: raw[0], bytes: bytes[0], length: length[0] },
        TermWitness { hash: raw[1], bytes: bytes[1], length: length[1] },
        TermWitness { hash: raw[2], bytes: bytes[2], length: length[2] },
        TermWitness { hash: raw[3], bytes: bytes[3], length: length[3] },
    ];
    Triple { terms, path, directions }
}

/// BGP path regression: a `Triple` constructed with the new
/// `[TermWitness; 4]` shape still passes `verify_inclusion` against the
/// sorted-tree root, regardless of what its `bytes` / `length`
/// witnesses are. Demonstrates the round-1 contract that the byte
/// witness is advisory at the Triple level.
#[test]
fn term_witness_bgp_path_unaffected() {
    let triples = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let info = merkle::<11, 3>(triples);

    let zero_bytes: [[u8; consts::STRING_LEN_MAX]; 4] = [[0; consts::STRING_LEN_MAX]; 4];
    let zero_lengths: [u32; 4] = [0; 4];
    for i in 0..3 {
        let t = make_triple_with_bytes(info, i, zero_bytes, zero_lengths);
        verify_inclusion(t, info.root);
    }
}

/// `bytes` and `length` witnesses are observable from inside the
/// circuit body -- round-2 string operators read them. This test
/// verifies the access pattern compiles and produces the supplied
/// values, which is all round-1 needs to demonstrate the wiring.
#[test]
fn term_witness_bytes_field_reachable() {
    let triples = [[8, 9, 10, 11], [0, 1, 2, 3], [4, 5, 6, 7]];
    let info = merkle::<11, 3>(triples);

    let mut sample: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    sample[0] = 0x68; // 'h'
    sample[1] = 0x69; // 'i'
    let bytes_array: [[u8; consts::STRING_LEN_MAX]; 4] = [sample, sample, sample, sample];
    let length_array: [u32; 4] = [2, 2, 2, 2];

    let t = make_triple_with_bytes(info, 0, bytes_array, length_array);
    // Inclusion still holds.
    verify_inclusion(t, info.root);
    // Bytes / length round-trip through the witness.
    assert_eq(t.terms[0].bytes[0], 0x68, "byte witness must round-trip 'h'");
    assert_eq(t.terms[0].bytes[1], 0x69, "byte witness must round-trip 'i'");
    assert_eq(t.terms[0].length, 2, "length witness must round-trip 2");
    // Byte index 2 is unconstrained padding (0 here, but a malicious
    // prover could supply anything -- `length` is the source of truth).
    assert_eq(t.terms[0].bytes[2], 0, "padding byte is what the prover supplied");
}

/// `consts::encode_string_bounded` is the round-2 string-operator
/// helper. Round-1 only checks that the helper compiles and produces
/// stable output for a given `(bytes, length)` pair -- the equality
/// constraint that ties this output to the term's lexical hash will be
/// emitted at use sites by the round-2 lowering (see
/// `spec/encoding.md` sec.6.3).
#[test]
fn encode_string_bounded_is_callable() {
    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    bytes[0] = 0x61; // 'a'
    bytes[1] = 0x62; // 'b'
    bytes[2] = 0x63; // 'c'
    let h1 = consts::encode_string_bounded(bytes, 3);
    let h2 = consts::encode_string_bounded(bytes, 3);
    // Determinism: same (bytes, length) yields the same Field.
    assert_eq(h1, h2, "encode_string_bounded must be deterministic");
}
/// **Soundness contract.** `encode_string_bounded(buf, len)` must agree
/// with `encode_string(s)` for the unique `s` whose UTF-8 encoding is
/// `buf[0..len]`. If this round-trip ever fails, every honest witness
/// for a round-2 string op (STRLEN / STRSTARTS / CONTAINS) will be
/// rejected by `bind_term_bytes_*` -- the binding compares bounded
/// against the credential layer's `encode_string` hash. Roborev review
/// 2026-05-04 (high) for the original mismatch.
#[test]
fn encode_string_bounded_round_trips_with_encode_string_short() {
    let mut buf: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    buf[0] = 0x61; // 'a'
    buf[1] = 0x62; // 'b'
    buf[2] = 0x63; // 'c'
    let bounded = consts::encode_string_bounded(buf, 3);
    let canonical = consts::encode_string("abc");
    assert_eq(
        bounded,
        canonical,
        "encode_string_bounded must round-trip with encode_string for short inputs",
    );
}

/// Empty-string round-trip. The original (broken) implementation
/// hashed `[0; STRING_LEN_MAX]` for `length = 0`, producing the wrong
/// hash and breaking `empty_string_lexical_hash()`. The fix uses the
/// variable-length hash primitive so length-0 hashes the empty
/// byte sequence -- matching `hash_string([])` (i.e. `sha256_var` of
/// 0 bytes).
#[test]
fn encode_string_bounded_round_trips_with_encode_string_empty() {
    let buf: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    let bounded = consts::encode_string_bounded(buf, 0);
    // SHA-256 of the empty byte sequence as a Field. We compute it via
    // `hash_string_var` directly (which matches `sha256_var(_, 0)`)
    // rather than `encode_string("")` because `str<0>` doesn't compose
    // cleanly. The intent: bounded over length-0 must NOT depend on
    // the padding bytes.
    let canonical = Field::from_le_bytes(consts::hash_string_var(buf, 0));
    assert_eq(
        bounded,
        canonical,
        "encode_string_bounded with length=0 must hash the empty byte sequence",
    );

    // Same length-0 with non-zero padding: the bounded hash MUST be
    // identical -- padding is unconstrained per the round-2 contract.
    let mut padded: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    padded[0] = 0xFF;
    padded[5] = 0x42;
    let bounded_padded = consts::encode_string_bounded(padded, 0);
    assert_eq(
        bounded_padded,
        canonical,
        "encode_string_bounded with length=0 must ignore padding bytes",
    );
}

/// Mid-length round-trip. Catches any off-by-one in the variable-length
/// hash domain -- e.g. hashing `bytes[0..length+1]` instead of `[0..length]`.
#[test]
fn encode_string_bounded_round_trips_with_encode_string_iri() {
    // "http://example.org/Bob" -- 22 bytes.
    let iri: [u8; 22] = [
        0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x65, 0x78, 0x61,
        0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x6f, 0x72, 0x67, 0x2f, 0x42,
        0x6f, 0x62,
    ];
    let mut buf: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    for i in 0..22 {
        buf[i] = iri[i];
    }
    // Add adversarial padding to verify it is not hashed.
    buf[22] = 0xFF;
    buf[40] = 0xAA;
    let bounded = consts::encode_string_bounded(buf, 22);
    let canonical = consts::encode_string("http://example.org/Bob");
    assert_eq(
        bounded,
        canonical,
        "encode_string_bounded must agree with encode_string for IRI-length inputs",
    );
}

// =============================================================================
// Round 2 -- bind_term_bytes + string operators
// =============================================================================
//
// Round 1 (PR #56) ships the bounded byte-array witness shape
// (`TermWitness { hash, bytes, length }`) but does NOT bind `bytes` /
// `length` to `hash` inside `verify_inclusion`. Per `spec/encoding.md`
// sec.6.3 the binding is caller-supplied at the use site of any string
// operator that reads `bytes`. Round 2 (this module) lands:
//
//   1. `bind_term_bytes`  -- the primitive equality assertion that ties
//      `encode_string_bounded(w.bytes, w.length)` to a caller-supplied
//      `expected_lexical_hash`.
//   2. `bind_term_bytes_iri`  -- convenience for NamedNode terms, where
//      the term-hash structurally decomposes to
//      `hash2([0, encode_string(iri)])` and the bytes are the IRI string
//      verbatim (no datatype / lang / special-encoding witness needed).
//   3. `bind_term_bytes_plain_string_literal`  -- convenience for plain
//      xsd:string literals (no language tag, no special encoding). The
//      term-hash structurally decomposes to a fixed shape, and the
//      datatype-IRI hash is a compile-time constant in
//      `XSD_STRING_DATATYPE_HASH` derived from the consts hash.
//   4. `string_starts_with`  -- byte-level prefix match for STRSTARTS.
//   5. `string_contains`  -- byte-level substring match with a
//      prover-supplied position witness for CONTAINS.
//
// `STRLEN` does not need a separate helper -- it just reads `w.length`
// after the binding. Per `feedback_zkp_no_proof_of_revealed_properties`
// the integer length is a verifier-side disclosed quantity; the circuit
// only proves the binding holds for the bytes the prover supplied.
//
// Round 2 deliberately scopes binding to NamedNode + plain-xsd:string
// literal terms. Language-tagged literals, typed numerics, and
// language-of-other-type terms are left to round 3 (they need
// additional structural witnesses for datatype / lang / special
// encoding hashes that are out of scope here). This is enough to wire
// STRLEN / STRSTARTS / CONTAINS for the W3C SPARQL 1.0 string-function
// fixtures, which use plain literals.

/// Pre-computed lexical hash of the empty string. Used as the
/// `language_tag` slot in the literal-decomposition equality for plain
/// xsd:string literals (no language tag).
///
/// **Implementation note.** Noir's `consts::encode_string("")` would be
/// the natural way to compute this, but `encode_string` takes a
/// `str<N>` whose `N` must be > 0 in practice (zero-length string types
/// don't compose cleanly with `as_bytes` / `hash_string`). We compute
/// the equivalent value -- `Field::from_le_bytes(hash_string([]))` --
/// inline using `encode_string_bounded` with `length = 0`. After the
/// PR-60 round-2 fix, `encode_string_bounded(buf, 0)` correctly
/// hashes the **empty** byte sequence (via `hash_string_var`) -- the
/// padding bytes in `zero_bytes` are not part of the hash domain.
pub fn empty_string_lexical_hash() -> Field {
    let zero_bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    consts::encode_string_bounded(zero_bytes, 0)
}

/// Pre-computed term-hash of the IRI `http://www.w3.org/2001/XMLSchema#string`.
/// Used as the datatype slot in the literal decomposition for plain
/// xsd:string literals.
///
/// We accept it as a parameter rather than computing inline so the
/// caller (transform-emitted Noir code) can lift the hash to a `global`
/// in the generated circuit and avoid recomputing the IRI hash on
/// every use site. Helper variant `bind_term_bytes_plain_string_literal`
/// computes it inline for tests; production lowering passes the
/// pre-computed value.
pub fn xsd_string_datatype_hash() -> Field {
    // hash2([0, encode_string("http://www.w3.org/2001/XMLSchema#string")])
    // The string is 39 bytes; we need a fixed-size buffer. Use
    // `encode_string_bounded` so the hash function used for term IRIs
    // matches the one for byte witnesses (both go through
    // `consts::hash_string`).
    let xsd_string: [u8; 39] = [
        0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x77, 0x77, 0x77, // "http://www"
        0x2e, 0x77, 0x33, 0x2e, 0x6f, 0x72, 0x67, 0x2f, 0x32, 0x30, // ".w3.org/20"
        0x30, 0x31, 0x2f, 0x58, 0x4d, 0x4c, 0x53, 0x63, 0x68, 0x65, // "01/XMLSche"
        0x6d, 0x61, 0x23, 0x73, 0x74, 0x72, 0x69, 0x6e, 0x67,       // "ma#string"
    ];
    let lex = consts::encode_string_bounded(xsd_string, 39);
    consts::hash2([0, lex])
}

/// Bind a term witness's `bytes` / `length` to a caller-supplied
/// expected lexical hash.
///
/// **What this asserts:** `consts::encode_string_bounded(w.bytes, w.length) == expected_lexical_hash`
/// and `w.length <= STRING_LEN_MAX` (the `as Field` cast prevents
/// overflow comparison surprises).
///
/// **What `expected_lexical_hash` should be:** the lexical-form hash
/// (under `consts::hash_string`) of the term's lexical value. For a
/// NamedNode / IRI this is the IRI string's hash; for a plain literal
/// it's the literal's value-string hash. The caller is responsible for
/// reconstructing this from `w.hash` plus structural metadata (see the
/// `bind_term_bytes_iri` / `bind_term_bytes_plain_string_literal`
/// convenience wrappers below).
///
/// **Why caller-supplied?** Round-1's `verify_inclusion` only binds
/// `w.hash` to the Merkle root. The bytes binding is paid only when a
/// query actually reads bytes -- typically a small fraction of terms.
pub fn bind_term_bytes(w: dep::types::TermWitness, expected_lexical_hash: Field) {
    let computed = consts::encode_string_bounded(w.bytes, w.length);
    assert(computed == expected_lexical_hash, "bind_term_bytes: byte witness does not match expected lexical hash");
    // Defence in depth: the bytes-only domain is `[0, STRING_LEN_MAX]`.
    // `w.length` is a u32 already so the upper bound is structural; we
    // re-assert as a Field comparison so a malicious prover supplying
    // `length > STRING_LEN_MAX` (via deserialisation lenience) would be
    // caught.
    assert((w.length as Field).lt((consts::STRING_LEN_MAX + 1) as Field), "bind_term_bytes: length exceeds STRING_LEN_MAX");
}

/// Convenience: bind `w` for a NamedNode (IRI) term.
///
/// For an IRI, `w.hash = hash2([0, encode_string(iri_string)])`. We
/// reconstruct that structurally: the lexical hash is
/// `encode_string_bounded(w.bytes, w.length)`, and the term hash is
/// `hash2([0, lexical_hash])`. Asserting `term_hash == w.hash` binds
/// the bytes via the term identity that `verify_inclusion` already
/// committed to the Merkle root.
pub fn bind_term_bytes_iri(w: dep::types::TermWitness) {
    let lexical_hash = consts::encode_string_bounded(w.bytes, w.length);
    let reconstructed = consts::hash2([0, lexical_hash]);
    assert(reconstructed == w.hash, "bind_term_bytes_iri: byte witness does not match the IRI's term hash");
    assert((w.length as Field).lt((consts::STRING_LEN_MAX + 1) as Field), "bind_term_bytes_iri: length exceeds STRING_LEN_MAX");
}

/// Convenience: bind `w` for a plain xsd:string literal (no language
/// tag, no special encoding).
///
/// For a plain xsd:string literal:
/// ```
/// w.hash = hash2([2, hash4([
///     encode_string(value),
///     encode_string(value),         // special_encoding == lexical_hash for non-special datatypes
///     encode_string(""),            // empty language tag
///     hash2([0, encode_string("http://www.w3.org/2001/XMLSchema#string")]),
/// ])])
/// ```
/// We reconstruct that, asserting `w.hash` matches. The `lang_hash`
/// (empty string) and `datatype_hash` (xsd:string) are passed in by
/// the caller so production lowering can lift them to `global`s and
/// avoid recomputing on every call.
pub fn bind_term_bytes_plain_string_literal(
    w: dep::types::TermWitness,
    empty_lang_hash: Field,
    xsd_string_dt_hash: Field,
) {
    let lexical_hash = consts::encode_string_bounded(w.bytes, w.length);
    // Plain xsd:string -> special_encoding == lexical_hash (per
    // spec/encoding.md Sec.3.4 fall-through: "Other -> Enc_s(lexical)").
    let value_encoding = consts::hash4([lexical_hash, lexical_hash, empty_lang_hash, xsd_string_dt_hash]);
    let reconstructed = consts::hash2([2, value_encoding]);
    assert(reconstructed == w.hash, "bind_term_bytes_plain_string_literal: byte witness does not match the literal's term hash");
    assert((w.length as Field).lt((consts::STRING_LEN_MAX + 1) as Field), "bind_term_bytes_plain_string_literal: length exceeds STRING_LEN_MAX");
}

/// STRSTARTS: returns true iff the bytes of the (already-bound) witness
/// `w` start with the given `prefix[0..prefix_len]`.
///
/// **Caller contract:** Call `bind_term_bytes_*` on `w` BEFORE this
/// helper so the prover can't supply arbitrary `bytes`. This helper
/// does not re-bind because the binding has a non-trivial cost
/// (one hash_string call) and a single bind covers all string ops on
/// the same term.
///
/// **Soundness:** the prefix length is a public input (the literal
/// "prefix" is folded into the circuit at compile time), so disclosing
/// it is design-by-contract per `feedback_zkp_no_proof_of_revealed_properties`.
/// The check is byte-equality on the first `prefix_len` positions: if
/// `prefix_len > w.length` the result is false (the string is shorter
/// than the prefix), otherwise we assert pairwise equality.
///
/// **Constraint cost:** `STRING_LEN_MAX` byte equalities (we walk every
/// position so the length dependency stays compile-time-constant).
/// Optimisation: skip the walk when `prefix_len > w.length` -- but the
/// circuit shape is identical either way.
pub fn string_starts_with<let P: u32>(
    w: dep::types::TermWitness,
    prefix: [u8; P],
    prefix_len: u32,
) -> bool {
    // Short-circuit length: if prefix is longer than the bound string,
    // STRSTARTS is false. We compute this as a Boolean and conjoin
    // with the byte-equality result.
    let length_ok = (prefix_len as Field).lt((w.length + 1) as Field);

    let mut all_match: bool = true;
    for i in 0..P {
        // Only the first `prefix_len` byte equalities are
        // load-bearing. For positions `i >= prefix_len` we accept any
        // byte (the prefix's tail bytes are unconstrained padding from
        // the caller -- typically zero, but we don't assume).
        if (i as u32) < prefix_len {
            if w.bytes[i] != prefix[i] {
                all_match = false;
            }
        }
    }
    length_ok & all_match
}

/// CONTAINS: returns true iff the bytes of the (already-bound) witness
/// `w` contain `needle[0..needle_len]` starting at byte offset
/// `position`.
///
/// **Witness contract:** the prover supplies `position` such that
/// `w.bytes[position..position + needle_len] == needle[0..needle_len]`.
/// The circuit verifies the equality and the bound
/// `position + needle_len <= w.length`. If the substring genuinely
/// doesn't occur, the prover cannot supply a satisfying `position` and
/// the proof fails to construct.
///
/// **Why witnessed position?** The alternative is enumerating every
/// candidate position in-circuit (`STRING_LEN_MAX - needle_len + 1`
/// positions, each with `needle_len` byte equalities). Witnessing
/// reduces the cost to a single `needle_len` comparison plus a
/// `position` range check. Standard ZK pattern (cf. `noir-circuit-patterns`).
///
/// **Soundness:** `position` is private; the only public output is the
/// Boolean result. A genuine non-occurrence cannot produce a witness
/// because no `position` satisfies the byte equality.
///
/// **Length disclosure:** `needle_len` is folded in at compile time
/// (the literal "needle" is a public part of the circuit), so it's
/// design-by-contract.
pub fn string_contains<let N: u32>(
    w: dep::types::TermWitness,
    needle: [u8; N],
    needle_len: u32,
    position: u32,
) -> bool {
    // Range: position + needle_len <= w.length. We use `<` against
    // `w.length + 1` to keep the comparison strict-greater on Fields.
    let position_ok = ((position + needle_len) as Field).lt((w.length + 1) as Field);

    let mut bytes_match: bool = true;
    for i in 0..N {
        // Compare `w.bytes[position + i]` against `needle[i]` for the
        // first `needle_len` positions. Use a guarded indexed access
        // because Noir array indexing must accept any in-range index;
        // we compute the index with `position + i` (a runtime value)
        // and clamp via the `i < needle_len` mask.
        if (i as u32) < needle_len {
            // `position + i` is bounded by `position_ok` if it holds,
            // and by `STRING_LEN_MAX` regardless because both `position`
            // and `i` are u32 with `i < N <= STRING_LEN_MAX`.
            let idx = (position + i as u32) % consts::STRING_LEN_MAX;
            if w.bytes[idx] != needle[i] {
                bytes_match = false;
            }
        }
    }
    position_ok & bytes_match
}

/// `bind_term_bytes` accepts a witness whose bytes hash to the
/// expected lexical hash.
#[test]
fn bind_term_bytes_accepts_correct_witness() {
    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    bytes[0] = 0x68; // 'h'
    bytes[1] = 0x65; // 'e'
    bytes[2] = 0x6c; // 'l'
    bytes[3] = 0x6c; // 'l'
    bytes[4] = 0x6f; // 'o'
    let length: u32 = 5;
    let lexical_hash = consts::encode_string_bounded(bytes, length);
    let w = dep::types::TermWitness { hash: lexical_hash, bytes, length };
    bind_term_bytes(w, lexical_hash);
}

/// Adversarial prover supplying mismatched bytes is rejected.
#[test(should_fail_with = "bind_term_bytes: byte witness does not match expected lexical hash")]
fn bind_term_bytes_rejects_mismatched_bytes() {
    let mut good_bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    good_bytes[0] = 0x68;
    good_bytes[1] = 0x69; // "hi"
    let good_hash = consts::encode_string_bounded(good_bytes, 2);

    let mut bad_bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    bad_bytes[0] = 0x6e; // 'n'
    bad_bytes[1] = 0x6f; // 'o'
    let bad_w = dep::types::TermWitness { hash: good_hash, bytes: bad_bytes, length: 2 };
    bind_term_bytes(bad_w, good_hash);
}

/// IRI binding round-trips when the witness reflects a real IRI.
#[test]
fn bind_term_bytes_iri_accepts_correct_witness() {
    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    // "http://example.org/Bob"
    let iri: [u8; 22] = [
        0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x65, 0x78, 0x61,
        0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x6f, 0x72, 0x67, 0x2f, 0x42,
        0x6f, 0x62,
    ];
    for i in 0..22 {
        bytes[i] = iri[i];
    }
    let length: u32 = 22;
    let lexical_hash = consts::encode_string_bounded(bytes, length);
    let term_hash = consts::hash2([0, lexical_hash]);
    let w = dep::types::TermWitness { hash: term_hash, bytes, length };
    bind_term_bytes_iri(w);
}

/// IRI binding under the **canonical** term-hash construction. Matches
/// the credential-layer encoding (`hash2([0, encode_string(iri)])`),
/// which is what the Merkle leaf hash actually commits to. Until the
/// `encode_string` / `encode_string_bounded` round-trip held, this
/// test would have failed for honest witnesses -- the regression that
/// roborev caught.
#[test]
fn bind_term_bytes_iri_matches_canonical_encode_string() {
    // Canonical: term-hash computed via `encode_string(<str>)`.
    let canonical_term_hash = consts::hash2(
        [0, consts::encode_string("http://example.org/Bob")],
    );

    // Witness: bytes carry the IRI's UTF-8, padded to STRING_LEN_MAX.
    let iri: [u8; 22] = [
        0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x65, 0x78, 0x61,
        0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x6f, 0x72, 0x67, 0x2f, 0x42,
        0x6f, 0x62,
    ];
    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    for i in 0..22 {
        bytes[i] = iri[i];
    }
    let w = dep::types::TermWitness {
        hash: canonical_term_hash,
        bytes,
        length: 22,
    };

    // The binding MUST accept this honest witness.
    bind_term_bytes_iri(w);
}

/// `string_starts_with("foobar", "foo")` is true; with the binding the
/// circuit cannot accept arbitrary bytes.
#[test]
fn string_starts_with_accepts_real_prefix() {
    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    let raw: [u8; 6] = [0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]; // "foobar"
    for i in 0..6 {
        bytes[i] = raw[i];
    }
    let length: u32 = 6;
    let lexical_hash = consts::encode_string_bounded(bytes, length);
    let term_hash = consts::hash2([0, lexical_hash]);
    let w = dep::types::TermWitness { hash: term_hash, bytes, length };
    bind_term_bytes_iri(w);

    let prefix: [u8; 3] = [0x66, 0x6f, 0x6f]; // "foo"
    assert(string_starts_with(w, prefix, 3), "STRSTARTS(\"foobar\", \"foo\") must be true");

    let bad: [u8; 3] = [0x62, 0x61, 0x72]; // "bar" -- not a prefix
    assert(!string_starts_with(w, bad, 3), "STRSTARTS(\"foobar\", \"bar\") must be false");
}

/// `string_contains("foobar", "oba")` with `position = 2` is true.
#[test]
fn string_contains_accepts_real_substring() {
    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    let raw: [u8; 6] = [0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]; // "foobar"
    for i in 0..6 {
        bytes[i] = raw[i];
    }
    let length: u32 = 6;
    let lexical_hash = consts::encode_string_bounded(bytes, length);
    let term_hash = consts::hash2([0, lexical_hash]);
    let w = dep::types::TermWitness { hash: term_hash, bytes, length };
    bind_term_bytes_iri(w);

    let needle: [u8; 3] = [0x6f, 0x62, 0x61]; // "oba"
    assert(string_contains(w, needle, 3, 2), "CONTAINS(\"foobar\", \"oba\", pos=2) must be true");
    // Wrong position: prover supplies pos=0 -> bytes don't match.
    assert(!string_contains(w, needle, 3, 0), "CONTAINS at wrong position must be false");
}

/// STRLEN: read `w.length` after binding.
#[test]
fn strlen_reads_length_after_binding() {
    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    bytes[0] = 0x66;
    bytes[1] = 0x6f;
    bytes[2] = 0x6f; // "foo"
    let length: u32 = 3;
    let lexical_hash = consts::encode_string_bounded(bytes, length);
    let term_hash = consts::hash2([0, lexical_hash]);
    let w = dep::types::TermWitness { hash: term_hash, bytes, length };
    bind_term_bytes_iri(w);
    // STRLEN(?x) is just `w.length` once the binding holds.
    assert_eq(w.length, 3, "STRLEN(\"foo\") must be 3");
}

/// Plain xsd:string literal binding: the prover cannot fudge the
/// bytes because the literal's full term hash structurally depends on
/// `encode_string_bounded(bytes, length)`.
#[test]
fn bind_term_bytes_plain_string_literal_round_trip() {
    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    bytes[0] = 0x68;
    bytes[1] = 0x69; // "hi"
    let length: u32 = 2;
    let lexical_hash = consts::encode_string_bounded(bytes, length);
    let empty_lang = empty_string_lexical_hash();
    let xsd_string_dt = xsd_string_datatype_hash();
    let value_encoding = consts::hash4([lexical_hash, lexical_hash, empty_lang, xsd_string_dt]);
    let term_hash = consts::hash2([2, value_encoding]);

    let w = dep::types::TermWitness { hash: term_hash, bytes, length };
    bind_term_bytes_plain_string_literal(w, empty_lang, xsd_string_dt);
}

/// Plain xsd:string literal binding under the **canonical** term-hash
/// construction. Matches what the credential layer signs: every
/// `encode_string(...)` call inside the term-hash is the canonical
/// (variable-length) hash of the lexical bytes. This is the test that
/// failed silently before the round-2 fix -- the Merkle leaf used
/// `encode_string(value)` on a `str<N>` whose `N` was the actual
/// length, while the witness re-derived the lexical hash via
/// `encode_string_bounded` over a zero-padded buffer; the two hashes
/// did not agree. Roborev review 2026-05-04 (high).
#[test]
fn bind_term_bytes_plain_string_literal_matches_canonical_encode_string() {
    // Canonical term-hash for the plain literal "hi"^^xsd:string.
    let canonical_value_hash = consts::encode_string("hi");
    let canonical_lang_hash = consts::encode_string_bounded(
        [0; consts::STRING_LEN_MAX],
        0,
    ); // empty lang tag
    let canonical_dt_hash = consts::hash2(
        [0, consts::encode_string("http://www.w3.org/2001/XMLSchema#string")],
    );
    let canonical_value_encoding = consts::hash4([
        canonical_value_hash,
        canonical_value_hash, // special_encoding == lexical_hash for plain xsd:string
        canonical_lang_hash,
        canonical_dt_hash,
    ]);
    let canonical_term_hash = consts::hash2([2, canonical_value_encoding]);

    // Witness: bytes carry "hi", padded.
    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    bytes[0] = 0x68; // 'h'
    bytes[1] = 0x69; // 'i'
    let w = dep::types::TermWitness {
        hash: canonical_term_hash,
        bytes,
        length: 2,
    };
    bind_term_bytes_plain_string_literal(w, canonical_lang_hash, canonical_dt_hash);
}

/// Honest STRLEN witness for a plain xsd:string literal. Goes through
/// the canonical term-hash so this matches what the prover would see
/// at proving time.
#[test]
fn strlen_canonical_witness_round_trip() {
    let canonical_value_hash = consts::encode_string("foo");
    let canonical_lang_hash = consts::encode_string_bounded(
        [0; consts::STRING_LEN_MAX],
        0,
    );
    let canonical_dt_hash = consts::hash2(
        [0, consts::encode_string("http://www.w3.org/2001/XMLSchema#string")],
    );
    let canonical_value_encoding = consts::hash4([
        canonical_value_hash,
        canonical_value_hash,
        canonical_lang_hash,
        canonical_dt_hash,
    ]);
    let canonical_term_hash = consts::hash2([2, canonical_value_encoding]);

    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    bytes[0] = 0x66; // 'f'
    bytes[1] = 0x6f; // 'o'
    bytes[2] = 0x6f; // 'o'
    let w = dep::types::TermWitness {
        hash: canonical_term_hash,
        bytes,
        length: 3,
    };
    bind_term_bytes_plain_string_literal(w, canonical_lang_hash, canonical_dt_hash);
    assert_eq(w.length, 3, "STRLEN(\"foo\") under canonical witness must be 3");
}

/// Honest STRSTARTS witness. Term-hash matches what
/// `encode_string("hello")` would produce on the credential side.
#[test]
fn strstarts_canonical_witness_round_trip() {
    let canonical_value_hash = consts::encode_string("hello");
    let canonical_lang_hash = consts::encode_string_bounded(
        [0; consts::STRING_LEN_MAX],
        0,
    );
    let canonical_dt_hash = consts::hash2(
        [0, consts::encode_string("http://www.w3.org/2001/XMLSchema#string")],
    );
    let canonical_value_encoding = consts::hash4([
        canonical_value_hash,
        canonical_value_hash,
        canonical_lang_hash,
        canonical_dt_hash,
    ]);
    let canonical_term_hash = consts::hash2([2, canonical_value_encoding]);

    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    bytes[0] = 0x68; // 'h'
    bytes[1] = 0x65; // 'e'
    bytes[2] = 0x6c; // 'l'
    bytes[3] = 0x6c; // 'l'
    bytes[4] = 0x6f; // 'o'
    let w = dep::types::TermWitness {
        hash: canonical_term_hash,
        bytes,
        length: 5,
    };
    bind_term_bytes_plain_string_literal(w, canonical_lang_hash, canonical_dt_hash);
    let prefix: [u8; 3] = [0x68, 0x65, 0x6c]; // "hel"
    assert(
        string_starts_with(w, prefix, 3),
        "STRSTARTS(\"hello\", \"hel\") under canonical witness must be true",
    );
}

/// Honest CONTAINS witness. Term-hash matches what `encode_string`
/// produces credential-side.
#[test]
fn contains_canonical_witness_round_trip() {
    let canonical_value_hash = consts::encode_string("foobar");
    let canonical_lang_hash = consts::encode_string_bounded(
        [0; consts::STRING_LEN_MAX],
        0,
    );
    let canonical_dt_hash = consts::hash2(
        [0, consts::encode_string("http://www.w3.org/2001/XMLSchema#string")],
    );
    let canonical_value_encoding = consts::hash4([
        canonical_value_hash,
        canonical_value_hash,
        canonical_lang_hash,
        canonical_dt_hash,
    ]);
    let canonical_term_hash = consts::hash2([2, canonical_value_encoding]);

    let mut bytes: [u8; consts::STRING_LEN_MAX] = [0; consts::STRING_LEN_MAX];
    let raw: [u8; 6] = [0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]; // "foobar"
    for i in 0..6 {
        bytes[i] = raw[i];
    }
    let w = dep::types::TermWitness {
        hash: canonical_term_hash,
        bytes,
        length: 6,
    };
    bind_term_bytes_plain_string_literal(w, canonical_lang_hash, canonical_dt_hash);
    let needle: [u8; 3] = [0x6f, 0x62, 0x61]; // "oba"
    assert(
        string_contains(w, needle, 3, 2),
        "CONTAINS(\"foobar\", \"oba\", pos=2) under canonical witness must be true",
    );
}
