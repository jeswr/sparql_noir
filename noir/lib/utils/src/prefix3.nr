//! Prefix-3 sorted Merkle commitment + non-membership primitive
//! (round 4 scaffolding).
//!
//! See `spec/prefix-tree-commitment.md` for the design rationale.
//! The prefix-3 commitment is a **second tree** the signer builds
//! alongside the leaf-hash sorted commitment in `super::merkle`. Its
//! leaves are keyed on `hash3_sp_g(s, p, g) = hash4([s, p, g, sep])`
//! (drop position `o`) and the tree is sorted ascending by leaf hash,
//! sentinel-bracketed exactly like the round-3 leaf-hash tree. The
//! signed message commits to **both roots** so a single signature
//! authenticates the same dataset under both keying schemes.
//!
//! Round 4 ships only this `(s, p, g)` prefix variant as a proof of
//! concept. The other 15 prefix subsets follow the same template; see
//! `spec/prefix-tree-commitment.md` Sec.7 for the generalisation
//! path.
//!
//! Soundness sketch (`spec/prefix-tree-commitment.md` Sec.4):
//!   1. The signer's `merkle_prefix3` is a deterministic function of
//!      the dataset; signature commits to its root.
//!   2. Two-leaf bracketing in the prefix-3 tree implies the absent
//!      prefix hash is not a leaf -- exactly the round-3 sorted-leaf
//!      argument applied to a different keying.
//!   3. Non-membership in the prefix-3 tree implies prefix non-
//!      membership in the dataset, by Pedersen-hash collision-
//!      resistance applied to `hash3_sp_g`.

use dep::types::{PrefixTriple3, SentinelLeaf};
use dep::consts;

use crate::reconstruct_index;
use crate::verify_leaf_inclusion;
use crate::verify_low_sentinel_inclusion;
use crate::verify_high_sentinel_inclusion;

/// `MerkleInfo` analogue for the prefix-3 commitment.
///
/// Unlike `super::MerkleInfo`, the input array is `[[Field; 3]; N]`
/// (no `o` position). Sentinel paths reuse the same shape as
/// `super::MerkleInfo` -- both trees use `consts::LOW_SENTINEL_HASH`
/// / `consts::HIGH_SENTINEL_HASH`, just at different roots.
///
/// **Deduplication.** When constructing the tree, we currently
/// preserve duplicates (multiple input prefixes with the same
/// `hash3_sp_g` value land as adjacent equal-hash leaves). The
/// signer should deduplicate before calling `merkle_prefix3` so that
/// `(left, right)` adjacency proofs are unambiguous; see
/// `spec/prefix-tree-commitment.md` Sec.2.1.
pub struct MerklePrefix3Info<let M: u32, let N: u32> {
    pub prefixes: [[Field; 3]; N],
    pub root: Field,
    pub root_u8: [u8; 32],
    pub paths: [[Field; M]; N],
    pub direction: [[u8; M - 1]; N],
    pub low_sentinel_path: [Field; M],
    pub low_sentinel_directions: [u8; M - 1],
    pub high_sentinel_path: [Field; M],
    pub high_sentinel_directions: [u8; M - 1],
}

/// Domain-separated `hash3` for the `(s, p, g)` prefix tree.
///
/// `hash3_sp_g(s, p, g) := hash4([s, p, g, PREFIX3_SP_G_DOMAIN_SEPARATOR])`.
///
/// The domain separator (`consts::PREFIX3_SP_G_DOMAIN_SEPARATOR`)
/// keeps the prefix-3 tree's leaf-hash space disjoint from the
/// leaf-hash sorted tree's, so cross-tree confusion attacks are
/// excluded by Pedersen-hash collision-resistance. No new hash
/// primitive is introduced -- `hash4` is reused.
pub fn hash3_sp_g(s: Field, p: Field, g: Field) -> Field {
    consts::hash4([s, p, g, consts::PREFIX3_SP_G_DOMAIN_SEPARATOR])
}

/// Convenience wrapper accepting the prefix as a 3-element array.
pub fn hash3_sp_g_arr(prefix: [Field; 3]) -> Field {
    hash3_sp_g(prefix[0], prefix[1], prefix[2])
}

/// Build the prefix-3 sorted Merkle tree alongside the leaf-hash
/// sorted tree.
///
/// Mirrors `super::merkle` exactly, except:
/// - Input slot is `[[Field; 3]; N]` (`(s, p, g)` per row).
/// - Leaf-hash function is `hash3_sp_g` (a domain-separated `hash4`).
/// - Same low / high sentinels via `consts::LOW_SENTINEL_HASH` /
///   `consts::HIGH_SENTINEL_HASH` at sorted indices `0` and `N + 1`.
///
/// **Bag semantics** (`spec/prefix-tree-commitment.md` Sec.2.1).
/// Duplicates at the input layer (multiple input rows with the same
/// `(s, p, g)`) survive into the tree as adjacent equal-hash leaves.
/// For `merkle_prefix3` to be useful as a non-membership oracle, the
/// signer should deduplicate at the input layer first; the tree
/// itself doesn't enforce uniqueness. The non-membership primitives
/// use strict `<` ordering, so adjacent-equal-hash leaves don't
/// affect soundness, but they do make the witness shape ambiguous
/// (the prover could pick either of two `(left_dup, right_real)`
/// brackets at the same boundary).
pub fn merkle_prefix3<let M: u32, let N: u32>(prefixes: [[Field; 3]; N]) -> MerklePrefix3Info<M, N> {
    // Capacity / depth bounds -- mirror `super::merkle`.
    std::static_assert(
        N + 2 <= 1024,
        "merkle_prefix3: N + 2 (real leaves + sentinels) exceeds the 1024-slot tree-level capacity",
    );
    std::static_assert(
        M <= 11,
        "merkle_prefix3: M > 11 exceeds the fixed 1024-slot per-level slab",
    );
    let mut logical_capacity: u32 = 1;
    for _ in 0..(M - 1) {
        logical_capacity *= 2;
    }
    std::static_assert(
        N + 2 <= logical_capacity,
        "merkle_prefix3: N + 2 exceeds the logical level-0 capacity 2^(M - 1) of the tree",
    );

    let mut tree = [[0; 1024]; M];
    let mut paths = [[0; M]; N];
    let mut direction = [[0; M - 1]; N];

    // Compute leaf hashes via domain-separated `hash4`.
    let mut leaf_hashes: [Field; N] = [0; N];
    for i in 0..N {
        leaf_hashes[i] = hash3_sp_g_arr(prefixes[i]);
    }

    // Insertion sort -- mirror `super::merkle`, stable on equal hashes.
    let mut sorted_idx: [u32; N] = [0; N];
    for k in 0..N {
        sorted_idx[k] = k;
    }
    for i in 1..N {
        let mut j = i;
        for _ in 0..N {
            if j > 0 {
                let a = leaf_hashes[sorted_idx[j - 1]];
                let b = leaf_hashes[sorted_idx[j]];
                if a.lt(b) {
                    j = 0;
                } else if a == b {
                    j = 0;
                } else {
                    let tmp = sorted_idx[j - 1];
                    sorted_idx[j - 1] = sorted_idx[j];
                    sorted_idx[j] = tmp;
                    j -= 1;
                }
            }
        }
    }

    // Inverse permutation: input position -> sentinel-shifted sorted position.
    let mut inv_idx: [u32; N] = [0; N];
    for k in 0..N {
        inv_idx[sorted_idx[k]] = k + 1;
    }

    // Layout: tree[0][0] = LOW_SENTINEL, [1..=N] = sorted real, [N+1] = HIGH_SENTINEL.
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

    // Per-input-row paths.
    for i in 0..N {
        let mut index = inv_idx[i];
        paths[i][0] = tree[0][index];
        for j in 1..M {
            paths[i][j] = tree[j - 1][index ^ 1];
            direction[i][j - 1] = if index % 2 == 0 { 0 } else { 1 };
            index /= 2;
        }
    }

    // Low-sentinel path (sorted index 0 -- all direction bits 0).
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

    // High-sentinel path (sorted index N + 1).
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

    MerklePrefix3Info {
        prefixes,
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

/// Verify that a `PrefixTriple3` is a leaf of the prefix-3 sorted
/// Merkle tree rooted at `root_value`.
///
/// The leaf hash is `hash3_sp_g(triple.terms)`. Path / direction walk
/// is shared with the round-3 inclusion primitive via
/// `verify_leaf_inclusion`.
pub fn verify_inclusion_prefix3(triple: PrefixTriple3, root_value: Field) {
    verify_leaf_inclusion(
        hash3_sp_g_arr(triple.terms),
        triple.path,
        triple.directions,
        root_value,
    );
}

/// Non-membership proof against the prefix-3 sorted Merkle commitment,
/// **interior case** -- `absent_prefix_hash` strictly between two
/// adjacent real prefix leaves.
///
/// Mirrors `super::verify_non_membership` against the prefix-3 tree.
/// For boundary cases use the `_low_sentinel` / `_high_sentinel`
/// variants below.
pub fn verify_non_membership_prefix3(
    left: PrefixTriple3,
    right: PrefixTriple3,
    absent_prefix_hash: Field,
    root_value: Field,
) {
    verify_inclusion_prefix3(left, root_value);
    verify_inclusion_prefix3(right, root_value);
    verify_non_membership_prefix3_no_inclusion(left, right, absent_prefix_hash);
}

/// Ordering / adjacency half of `verify_non_membership_prefix3`.
/// Used when both bracket leaves have been inclusion-checked
/// elsewhere (e.g. via the transform layer's `bgp_prefix3` walk).
pub fn verify_non_membership_prefix3_no_inclusion(
    left: PrefixTriple3,
    right: PrefixTriple3,
    absent_prefix_hash: Field,
) {
    assert(left.path[0].lt(absent_prefix_hash), "non-membership prefix3: left leaf hash >= absent prefix hash");
    assert(absent_prefix_hash.lt(right.path[0]), "non-membership prefix3: absent prefix hash >= right leaf hash");

    let left_idx = reconstruct_index(left.directions);
    let right_idx = reconstruct_index(right.directions);
    assert_eq(
        right_idx,
        left_idx + 1,
        "non-membership prefix3: right leaf is not adjacent to left leaf",
    );
}

/// Non-membership proof against the prefix-3 sorted Merkle commitment,
/// **lower boundary case** -- `absent_prefix_hash` strictly less than
/// every real prefix leaf in the dataset.
pub fn verify_non_membership_prefix3_low_sentinel(
    low: SentinelLeaf,
    right: PrefixTriple3,
    absent_prefix_hash: Field,
    root_value: Field,
) {
    verify_low_sentinel_inclusion(low, root_value);
    verify_inclusion_prefix3(right, root_value);
    verify_non_membership_prefix3_low_sentinel_no_inclusion(low, right, absent_prefix_hash);
}

/// Ordering / adjacency half of
/// `verify_non_membership_prefix3_low_sentinel`. Used when both leaves
/// have been inclusion-checked elsewhere.
pub fn verify_non_membership_prefix3_low_sentinel_no_inclusion(
    low: SentinelLeaf,
    right: PrefixTriple3,
    absent_prefix_hash: Field,
) {
    assert_eq(low.path[0], consts::LOW_SENTINEL_HASH, "non-membership prefix3: low sentinel hash mismatch");
    assert(consts::LOW_SENTINEL_HASH.lt(absent_prefix_hash), "non-membership prefix3: absent prefix hash <= low sentinel");
    assert(absent_prefix_hash.lt(right.path[0]), "non-membership prefix3: absent prefix hash >= right leaf hash");

    // Adjacency: low sentinel at sorted index 0, right at sorted index 1.
    for j in 0..(consts::MERKLE_DEPTH - 1) {
        let d = low.directions[j];
        assert((d == 0) | (d == 1), "non-membership prefix3: low direction bit must be 0 or 1");
        assert_eq(d, 0, "non-membership prefix3: low sentinel must sit at sorted index 0");
    }
    let right_idx = reconstruct_index(right.directions);
    assert_eq(
        right_idx,
        1,
        "non-membership prefix3: right leaf is not adjacent to the low sentinel (sorted index 1)",
    );
}

/// Non-membership proof against the prefix-3 sorted Merkle commitment,
/// **upper boundary case** -- `absent_prefix_hash` strictly greater
/// than every real prefix leaf in the dataset.
pub fn verify_non_membership_prefix3_high_sentinel(
    left: PrefixTriple3,
    high: SentinelLeaf,
    absent_prefix_hash: Field,
    root_value: Field,
) {
    verify_inclusion_prefix3(left, root_value);
    verify_high_sentinel_inclusion(high, root_value);
    verify_non_membership_prefix3_high_sentinel_no_inclusion(left, high, absent_prefix_hash);
}

/// Ordering / adjacency half of
/// `verify_non_membership_prefix3_high_sentinel`. Used when both
/// leaves have been inclusion-checked elsewhere.
pub fn verify_non_membership_prefix3_high_sentinel_no_inclusion(
    left: PrefixTriple3,
    high: SentinelLeaf,
    absent_prefix_hash: Field,
) {
    assert_eq(high.path[0], consts::HIGH_SENTINEL_HASH, "non-membership prefix3: high sentinel hash mismatch");
    assert(left.path[0].lt(absent_prefix_hash), "non-membership prefix3: left leaf hash >= absent prefix hash");
    assert(absent_prefix_hash.lt(consts::HIGH_SENTINEL_HASH), "non-membership prefix3: absent prefix hash >= high sentinel");

    let left_idx = reconstruct_index(left.directions);
    let high_idx = reconstruct_index(high.directions);
    assert_eq(
        high_idx,
        left_idx + 1,
        "non-membership prefix3: high sentinel is not adjacent to the left leaf",
    );
}

// =====================================================================
// Property tests
// =====================================================================

#[test]
fn test_prefix3_merkle_paths_lead_to_root() {
    // Each input prefix's path must lead to the prefix-3 sorted root,
    // and `paths[i][0]` must equal the domain-separated `hash3_sp_g`
    // of the input prefix.
    let prefixes = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    let info = merkle_prefix3::<11, 3>(prefixes);
    for i in 0..3 {
        let mut current = info.paths[i][0];
        for j in 1..11 {
            current = if info.direction[i][j - 1] == 0 {
                consts::hash2([current, info.paths[i][j]])
            } else {
                consts::hash2([info.paths[i][j], current])
            };
        }
        assert_eq(current, info.root, "Prefix3 path must lead to the sorted root");
        assert_eq(
            hash3_sp_g_arr(info.prefixes[i]),
            info.paths[i][0],
            "Path leaf must be hash3_sp_g of the prefix",
        );
    }
}

#[test]
fn test_prefix3_merkle_permutation_invariant() {
    // The prefix-3 root must be permutation-invariant under input
    // reordering -- same property the leaf-hash sorted tree provides.
    let prefixes_a = [[7, 8, 9], [1, 2, 3], [4, 5, 6]];
    let prefixes_b = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    let info_a = merkle_prefix3::<11, 3>(prefixes_a);
    let info_b = merkle_prefix3::<11, 3>(prefixes_b);
    assert_eq(
        info_a.root,
        info_b.root,
        "Prefix3 root must be permutation-invariant",
    );
}

#[test]
fn test_prefix3_sentinel_paths_lead_to_root() {
    // The two sentinel inclusion paths emitted by `merkle_prefix3`
    // must verify against the sorted root.
    let prefixes = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    let info = merkle_prefix3::<11, 3>(prefixes);
    assert_eq(info.low_sentinel_path[0], consts::LOW_SENTINEL_HASH, "low sentinel hash");
    assert_eq(info.high_sentinel_path[0], consts::HIGH_SENTINEL_HASH, "high sentinel hash");

    let low = SentinelLeaf {
        path: info.low_sentinel_path,
        directions: info.low_sentinel_directions,
    };
    verify_low_sentinel_inclusion(low, info.root);

    let high = SentinelLeaf {
        path: info.high_sentinel_path,
        directions: info.high_sentinel_directions,
    };
    verify_high_sentinel_inclusion(high, info.root);
}

#[test]
fn test_prefix3_inclusion_round_trip() {
    // Each prefix produced by `merkle_prefix3` must round-trip through
    // `verify_inclusion_prefix3`.
    let prefixes = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    let info = merkle_prefix3::<11, 3>(prefixes);
    for i in 0..3 {
        let triple = PrefixTriple3 {
            terms: info.prefixes[i],
            path: info.paths[i],
            directions: info.direction[i],
        };
        verify_inclusion_prefix3(triple, info.root);
    }
}

#[test]
fn test_prefix3_non_membership_low_boundary() {
    // An `absent_prefix_hash` strictly less than every real prefix
    // leaf must be witnessable via the low sentinel.
    let prefixes = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    let info = merkle_prefix3::<11, 3>(prefixes);

    // Find the input row at sorted index 1 (smallest real leaf).
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
    assert(found, "test fixture: no input prefix at sorted index 1");

    let smallest = PrefixTriple3 {
        terms: info.prefixes[smallest_idx],
        path: info.paths[smallest_idx],
        directions: info.direction[smallest_idx],
    };
    let low = SentinelLeaf {
        path: info.low_sentinel_path,
        directions: info.low_sentinel_directions,
    };

    // Absent hash strictly between LOW_SENTINEL_HASH=0 and any non-
    // zero real leaf hash. `1` works under collision-resistant hash3.
    let absent_prefix_hash: Field = 1;
    assert(absent_prefix_hash.lt(smallest.path[0]), "fixture: absent < smallest real leaf");

    verify_non_membership_prefix3_low_sentinel(low, smallest, absent_prefix_hash, info.root);
}

#[test]
fn test_prefix3_non_membership_high_boundary() {
    // An `absent_prefix_hash` strictly greater than every real prefix
    // leaf must be witnessable via the high sentinel.
    let prefixes = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    let info = merkle_prefix3::<11, 3>(prefixes);

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
    assert(found, "test fixture: no input prefix at sorted index 3");

    let largest = PrefixTriple3 {
        terms: info.prefixes[largest_idx],
        path: info.paths[largest_idx],
        directions: info.direction[largest_idx],
    };
    let high = SentinelLeaf {
        path: info.high_sentinel_path,
        directions: info.high_sentinel_directions,
    };

    let absent_prefix_hash: Field = consts::HIGH_SENTINEL_HASH - 1;
    assert(largest.path[0].lt(absent_prefix_hash), "fixture: largest < absent");

    verify_non_membership_prefix3_high_sentinel(largest, high, absent_prefix_hash, info.root);
}

#[test]
fn test_prefix3_non_membership_interior() {
    // An `absent_prefix_hash` strictly between two adjacent real
    // prefix leaves must be witnessable via the interior primitive.
    let prefixes = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    let info = merkle_prefix3::<11, 3>(prefixes);

    // Locate sorted indices 1 and 2 in the input array.
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

    let left = PrefixTriple3 {
        terms: info.prefixes[idx1],
        path: info.paths[idx1],
        directions: info.direction[idx1],
    };
    let right = PrefixTriple3 {
        terms: info.prefixes[idx2],
        path: info.paths[idx2],
        directions: info.direction[idx2],
    };

    // Pick an absent hash strictly between left and right. As in the
    // round-3 interior test, `left.path[0] + 1` is provably > left and
    // (under collision-resistance) provably != any real leaf, and we
    // assert it < right at runtime so the test fails loudly if the
    // fixture were ever degenerate.
    let absent_prefix_hash: Field = left.path[0] + 1;
    assert(left.path[0].lt(absent_prefix_hash), "fixture: left < absent");
    assert(absent_prefix_hash.lt(right.path[0]), "fixture: absent < right");

    verify_non_membership_prefix3(left, right, absent_prefix_hash, info.root);
}

#[test(should_fail_with = "non-membership prefix3: absent prefix hash >= right leaf hash")]
fn test_prefix3_non_membership_rejects_present_prefix() {
    // Soundness check: if the prover claims absence for a prefix that
    // *is* in the tree, the strict-`<` ordering must fail. We use the
    // smallest real leaf as the absent hash and witness it with the
    // low sentinel + that same leaf as the right bracket; since the
    // absent hash equals the right leaf hash, the
    // `absent < right.path[0]` strict assertion fires.
    let prefixes = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    let info = merkle_prefix3::<11, 3>(prefixes);

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
    let smallest = PrefixTriple3 {
        terms: info.prefixes[smallest_idx],
        path: info.paths[smallest_idx],
        directions: info.direction[smallest_idx],
    };
    let low = SentinelLeaf {
        path: info.low_sentinel_path,
        directions: info.low_sentinel_directions,
    };

    // absent_prefix_hash equals the smallest real leaf hash -- the
    // prefix is present, so non-membership must be rejected.
    let absent_prefix_hash: Field = smallest.path[0];

    verify_non_membership_prefix3_low_sentinel(low, smallest, absent_prefix_hash, info.root);
}

#[test(should_fail_with = "non-membership prefix3: right leaf is not adjacent to left leaf")]
fn test_prefix3_non_membership_rejects_non_adjacent_brackets() {
    // Soundness check: the prover cannot bracket an absent hash with
    // two non-adjacent real leaves to forge non-membership for any
    // value in between. Sorted indices 1 and 3 are not adjacent
    // (index 2 sits between them); the `right_idx == left_idx + 1`
    // assertion must reject the proof.
    let prefixes = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    let info = merkle_prefix3::<11, 3>(prefixes);

    let mut idx1: u32 = 0;
    let mut idx3: u32 = 0;
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
        } else if idx == 3 {
            idx3 = i as u32;
        }
    }
    let left = PrefixTriple3 {
        terms: info.prefixes[idx1],
        path: info.paths[idx1],
        directions: info.direction[idx1],
    };
    let right = PrefixTriple3 {
        terms: info.prefixes[idx3],
        path: info.paths[idx3],
        directions: info.direction[idx3],
    };

    // Pick absent_prefix_hash strictly between left and right (we know
    // at least one real leaf sits between them at sorted index 2,
    // which means a witness against this `(left, right)` pair claims
    // absence of a hash that *is* in the tree). The adjacency
    // assertion catches the lie even before the strict-`<` check.
    let absent_prefix_hash: Field = left.path[0] + 1;
    assert(left.path[0].lt(absent_prefix_hash), "fixture: left < absent");
    assert(absent_prefix_hash.lt(right.path[0]), "fixture: absent < right");

    verify_non_membership_prefix3(left, right, absent_prefix_hash, info.root);
}

#[test]
fn test_prefix3_domain_separator_disjoint_from_leaf_hash_tree() {
    // Smoke check that `hash3_sp_g(s, p, g)` is *not* equal to
    // `hash4(s, p, g, 0)` -- if the domain separator were 0 the prefix
    // tree would collide with `hash4` over `(s, p, g, 0)` quads. This
    // doesn't prove cross-tree disjointness in general (which depends
    // on Pedersen-hash collision-resistance) but ensures our chosen
    // separator is non-zero and produces visibly different output.
    let h_prefix = hash3_sp_g(1, 2, 3);
    let h_quad_zero = consts::hash4([1, 2, 3, 0]);
    assert(h_prefix != h_quad_zero, "prefix3 hash collides with hash4 zero-padded -- domain separator misconfigured");
}
