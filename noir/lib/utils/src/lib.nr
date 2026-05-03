use dep::types::{IndexedRoot, Root, SentinelLeaf, Triple};
use dep::consts;

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
    verify_leaf_inclusion(
        consts::hash4(triple.terms),
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
pub fn merkle<let M: u32, let N: u32>(triples: [[Field; 4]; N]) -> MerkleInfo<M, N> {
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
        for j in 0..10 {
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
        terms: info.triples[smallest_idx],
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
        for j in 0..10 {
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
        terms: info.triples[largest_idx],
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
fn reconstruct_index(directions: [u8; consts::MERKLE_DEPTH - 1]) -> u64 {
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
///    inequality reduces to `absent_hash != 0`, which holds for every
///    `consts::hash4(triple)` under Pedersen-hash collision-resistance.
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
    // sentinel itself (a real triple cannot have hash `0` under
    // Pedersen-hash collision-resistance, so this is also implicitly
    // a non-collision check).
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
///    strict inequality reduces to `absent_hash != p - 1`, which
///    holds for every `consts::hash4(triple)` under Pedersen-hash
///    collision-resistance.
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
