use dep::types::{IndexedRoot, Root, Triple};
use dep::consts;

pub struct MerkleInfo<let M: u32, let N: u32> {
    pub triples: [[Field; 4]; N],
    pub root: Field,
    pub root_u8: [u8; 32],
    pub paths: [[Field; M]; N],
    pub direction: [[u8; M - 1]; N],
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

pub fn verify_inclusion(triple: Triple, root_value: Field) {
    let mut current = triple.path[0];
    for i in 1..consts::MERKLE_DEPTH {
        current = consts::hash2(
            if triple.directions[i - 1] == 0 { [current, triple.path[i]] } else { [triple.path[i], current] }
        );
    }
    // TODO: Cleanup - we shouldn't need this check
    assert_eq(current, root_value, "Path does not lead to the correct root");
    assert_eq(consts::hash4(triple.terms), triple.path[0], "Triple does not hash to the root");
}

pub fn encode_string<let N: u32>(string: str<N>) -> Field {
    Field::from_le_bytes(consts::hash_string(string.as_bytes()))
}

/// Build a Merkle tree over `triples`, sorted ascending by
/// `consts::hash4(triple)`. The signed root commits to the sorted
/// multiset, which is the load-bearing pre-condition for the
/// non-membership / NOT EXISTS primitive (`spec/exists.md` §3.3).
///
/// **Bag semantics.** Duplicate triples are kept (no canonicalisation):
/// they appear as adjacent equal-hash leaves in the sorted tree. The
/// non-membership primitive uses **strict** `<` ordering against the
/// neighbour leaves, so duplicates do not affect the absence proof's
/// soundness — the absent hash is, by definition, distinct from every
/// real leaf, including duplicates.
///
/// **Sentinels.** This implementation sorts the supplied triples and
/// pads the remainder of the tree with the existing `[0; …]` zero
/// padding. For non-membership proofs at the boundaries (absent hash
/// less than the smallest leaf, or greater than the largest), the
/// caller is responsible for either choosing a triple-hash domain that
/// excludes the sentinel value (overwhelmingly likely under a
/// collision-resistant hash) or supplying explicit `Field::min` /
/// `Field::max` sentinel triples in the input. The simpler "no
/// sentinels, prover never proves out-of-range absence" contract is
/// fine for our round-3 scope; sentinel handling is documented in
/// `spec/exists.md` §3.3 as a follow-up if real boundary cases hit.
pub fn merkle<let M: u32, let N: u32>(triples: [[Field; 4]; N]) -> MerkleInfo<M, N> {
    let mut tree = [[0; 1024]; M];
    let mut paths = [[0; M]; N];
    let mut direction = [[0; M - 1]; N];

    // Compute leaf hashes and an associated permutation that sorts them
    // ascending by hash. The sort is implemented as a simple insertion
    // sort over `N`: this is `O(N^2)` but `N` is the number of triples
    // in a single signed dataset, which is bounded by the deployment's
    // protocol design (typically tens to a few thousand) — well within
    // tractable. The sort is stable: equal-hash leaves keep their
    // original input order, so the canonical root is uniquely
    // determined by the input set.
    let mut leaf_hashes: [Field; N] = [0; N];
    for i in 0..N {
        leaf_hashes[i] = consts::hash4(triples[i]);
    }

    // `sorted_idx[k]` = index in the input array of the k-th smallest
    // leaf. We don't reorder `triples` itself — the `MerkleInfo.triples`
    // / `paths` / `direction` arrays in the returned struct stay
    // input-order so downstream code (which references positional
    // metadata) is unaffected. The tree itself is built over the
    // sorted leaves.
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
                    // tie — keep input order (sorted_idx[j-1] < sorted_idx[j]
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

    // `inv_idx[input_pos]` = the sorted position the input-pos-th leaf
    // ended up at. Used to compute Merkle paths for each leaf in input
    // order without reshuffling the input arrays.
    let mut inv_idx: [u32; N] = [0; N];
    for k in 0..N {
        inv_idx[sorted_idx[k]] = k;
    }

    // Lay out the tree's level-0 in **sorted** order. Slots beyond N
    // remain zero — the existing padding contract (`spec/exists.md`
    // §3.3 sentinels paragraph).
    for k in 0..N {
        tree[0][k] = leaf_hashes[sorted_idx[k]];
    }

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
    // position. `paths[i][0]` is still the leaf's own hash; the rest
    // walk up the tree.
    for i in 0..N {
        let mut index = inv_idx[i];

        paths[i][0] = tree[0][index];

        for j in 1..M {
            paths[i][j] = tree[j - 1][index ^ 1]; // XOR to get the sibling node
            direction[i][j - 1] = if index % 2 == 0 { 0 } else { 1 }; // 0 for left, 1 for right
            index /= 2; // Move up the tree
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
    // that paths/inv_idx stay consistent after sorting.
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

/// Non-membership proof against the sorted Merkle commitment.
///
/// Given two adjacent leaves in the sorted tree (`left` at sorted index
/// `i`, `right` at sorted index `i + 1`) and an `absent_hash` that the
/// caller claims is not in the tree, this primitive verifies:
///
/// 1. Both `left` and `right` are valid leaves of the same Merkle tree
///    (their inclusion paths lead to `root_value`).
/// 2. `left.path[0] < absent_hash < right.path[0]` — strict ordering.
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
/// equal any `tree[0][k]` — otherwise that `k` would be wedged between
/// the two consecutive sorted indices, contradicting consecutiveness.
///
/// **Bag-semantics note.** Equal-hash duplicates are permitted in the
/// tree (see `merkle` doc-comment). Strict `<` against the absent hash
/// is correct: duplicates have hash equal to one of the real triples,
/// and strict `<` means `absent_hash` is provably distinct from every
/// real triple's hash, regardless of multiplicity.
///
/// **Sentinels.** Boundary cases (absent hash smaller than the smallest
/// leaf, or larger than the largest) are not directly handled here.
/// See `spec/exists.md` §3.3 for the documented contract: callers
/// outside the sentinel-bracketed range are expected to be vanishingly
/// rare for collision-resistant `hash4`. If real deployments need
/// strict boundary handling, supply `[0; 4]` and `[Field::max-like; 4]`
/// sentinel triples explicitly in the input set; future work can add
/// implicit sentinels in `merkle()` itself.
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
/// lowering for `NOT EXISTS` and `MINUS` uses this variant — it places
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

    // Adjacency: right's sorted index = left's sorted index + 1. The
    // directions vector encodes the index in little-endian: bit j is 0
    // if the leaf is the left child at level j (i.e. index bit j is
    // 0), 1 otherwise. We reconstruct the indices and assert
    // `right_idx == left_idx + 1`.
    let mut left_idx: u64 = 0;
    let mut right_idx: u64 = 0;
    let mut bit: u64 = 1;
    for j in 0..(consts::MERKLE_DEPTH - 1) {
        if left.directions[j] == 1 {
            left_idx += bit;
        }
        if right.directions[j] == 1 {
            right_idx += bit;
        }
        bit *= 2;
    }
    assert_eq(
        right_idx,
        left_idx + 1,
        "non-membership: right leaf is not adjacent to left leaf",
    );
}
