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
        // Constrain `directions[i - 1]` to be a Boolean (0 or 1). Any
        // non-Boolean value would let a prover satisfy inclusion under
        // "anything non-zero = right" semantics while making the
        // index reconstruction in `verify_non_membership_no_inclusion`
        // omit / mis-count the bit -- breaking the adjacency proof's
        // soundness. Roborev finding 2026-05-03 (high).
        let dir = triple.directions[i - 1];
        assert((dir == 0) | (dir == 1), "Merkle direction bit must be 0 or 1");
        current = consts::hash2(
            if dir == 0 { [current, triple.path[i]] } else { [triple.path[i], current] }
        );
    }
    // TODO: Cleanup - we shouldn't need this check
    assert_eq(current, root_value, "Path does not lead to the correct root");
    // The Merkle commitment is over the term-hash quartet, not over the
    // bounded byte witness -- see `spec/encoding.md` Sec.6.3. The `bytes` /
    // `length` fields of each `TermWitness` are advisory at the Triple
    // level; round-2 string operators bind them locally at use-sites.
    let term_hashes: [Field; 4] = [
        triple.terms[0].hash,
        triple.terms[1].hash,
        triple.terms[2].hash,
        triple.terms[3].hash,
    ];
    assert_eq(consts::hash4(term_hashes), triple.path[0], "Triple does not hash to the root");
}

pub fn encode_string<let N: u32>(string: str<N>) -> Field {
    Field::from_le_bytes(consts::hash_string(string.as_bytes()))
}

/// Build a Merkle tree over `triples`, sorted ascending by
/// `consts::hash4(triple)`. The signed root commits to the sorted
/// multiset, which is the load-bearing pre-condition for the
/// non-membership / NOT EXISTS primitive (`spec/exists.md` Sec.3.3).
///
/// **Bag semantics.** Duplicate triples are kept (no canonicalisation):
/// they appear as adjacent equal-hash leaves in the sorted tree. The
/// non-membership primitive uses **strict** `<` ordering against the
/// neighbour leaves, so duplicates do not affect the absence proof's
/// soundness -- the absent hash is, by definition, distinct from every
/// real leaf, including duplicates.
///
/// **Sentinels.** This implementation sorts the supplied triples and
/// pads the remainder of the tree with the existing `[0; ...]` zero
/// padding. For non-membership proofs at the boundaries (absent hash
/// less than the smallest leaf, or greater than the largest), the
/// caller is responsible for either choosing a triple-hash domain that
/// excludes the sentinel value (overwhelmingly likely under a
/// collision-resistant hash) or supplying explicit `Field::min` /
/// `Field::max` sentinel triples in the input. The simpler "no
/// sentinels, prover never proves out-of-range absence" contract is
/// fine for our round-3 scope; sentinel handling is documented in
/// `spec/exists.md` Sec.3.3 as a follow-up if real boundary cases hit.
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

    // `inv_idx[input_pos]` = the sorted position the input-pos-th leaf
    // ended up at. Used to compute Merkle paths for each leaf in input
    // order without reshuffling the input arrays.
    let mut inv_idx: [u32; N] = [0; N];
    for k in 0..N {
        inv_idx[sorted_idx[k]] = k;
    }

    // Lay out the tree's level-0 in **sorted** order. Slots beyond N
    // remain zero -- the existing padding contract (`spec/exists.md`
    // Sec.3.3 sentinels paragraph).
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
///
/// **Sentinels.** Boundary cases (absent hash smaller than the smallest
/// leaf, or larger than the largest) are not directly handled here.
/// See `spec/exists.md` Sec.3.3 for the documented contract: callers
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

    // Adjacency: right's sorted index = left's sorted index + 1. The
    // directions vector encodes the index in little-endian: bit j is 0
    // if the leaf is the left child at level j (i.e. index bit j is
    // 0), 1 otherwise. We reconstruct the indices and assert
    // `right_idx == left_idx + 1`.
    //
    // Directions are constrained to be Booleans by `verify_inclusion`
    // (which runs over both leaves before this no-inclusion variant
    // is called from the transform-emitted body, or as part of the
    // composite `verify_non_membership` above). We re-assert here as
    // defence in depth -- the no-inclusion variant is exposed publicly
    // and a future caller that bypasses `verify_inclusion` would
    // otherwise be exposed to the high-severity 2026-05-03 finding.
    let mut left_idx: u64 = 0;
    let mut right_idx: u64 = 0;
    let mut bit: u64 = 1;
    for j in 0..(consts::MERKLE_DEPTH - 1) {
        let l = left.directions[j];
        let r = right.directions[j];
        assert((l == 0) | (l == 1), "non-membership: left direction bit must be 0 or 1");
        assert((r == 0) | (r == 1), "non-membership: right direction bit must be 0 or 1");
        if l == 1 {
            left_idx += bit;
        }
        if r == 1 {
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

// =============================================================================
// Bounded byte-array witness -- round-1 plumbing tests
// =============================================================================
// These tests live alongside the inclusion / non-membership tests because
// they exercise the same `Triple` shape under the new
// `terms: [TermWitness; 4]` layout. Round 2 will add string-operator
// tests in `noir/lib/xpath`; round 1 only demonstrates that the BGP
// path still works and the `bytes` field is reachable.

use dep::types::TermWitness;

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
/// circuit body -- round-2 string operators will read them. This test
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
