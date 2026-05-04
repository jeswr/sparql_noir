use dep::consts::{MERKLE_DEPTH, HONK_VK_SIZE, HONK_PROOF_SIZE, signature::Signature};

pub struct Triple {
  pub terms: [Field; 4],
  pub path: [Field; MERKLE_DEPTH],
  pub directions: [u8; MERKLE_DEPTH - 1],
}

/// A prefix-3 leaf in the **prefix-3 sorted Merkle commitment**
/// (`tree_3sp_g`), a *second* commitment shape that the signer builds
/// alongside the leaf-hash sorted commitment for round-4 prefix
/// non-membership proofs. Leaves are keyed by
/// `utils::hash3_sp_g(s, p, g)` (drop the `o` position) so that
/// `NOT EXISTS { ?p ex:age ?o }` (and other patterns where `o` is
/// inner-only) can be witnessed via the same two-leaf bracketing
/// argument that `verify_non_membership_*` uses on `tree_4`.
///
/// `terms` carries the three fixed positions in canonical
/// `(s, p, g)` order. The leaf hash committed in the tree is
/// `utils::hash3_sp_g(terms)`, which is just `hash4` with a fixed
/// domain-separator constant (`consts::PREFIX3_SP_G_DOMAIN_SEPARATOR`)
/// in the `o` slot -- same primitive, different domain, no new
/// cryptographic assumption. See `spec/prefix-tree-commitment.md`
/// Sec.2.2 for the rationale.
///
/// **Why a separate type instead of reusing `Triple`?** The type
/// system enforces "this slot is a prefix-tree bracket, not a full-
/// quad bracket" at the call site. Prefix-tree primitives accept
/// `PrefixTriple3` and would refuse a four-term `Triple` (and vice
/// versa).
pub struct PrefixTriple3 {
  pub terms: [Field; 3],
  pub path: [Field; MERKLE_DEPTH],
  pub directions: [u8; MERKLE_DEPTH - 1],
}

/// A synthetic sentinel leaf in the sorted Merkle commitment.
///
/// The signer's `utils::merkle` injects two such leaves into every
/// commitment: a low sentinel at sorted index `0` with leaf-hash
/// `consts::LOW_SENTINEL_HASH = 0`, and a high sentinel at sorted
/// index `N + 1` with leaf-hash `consts::HIGH_SENTINEL_HASH = -1`
/// (= the BN254 prime minus one). They make every `absent_hash`
/// witnessable by `verify_non_membership_*` -- including ones that
/// fall below the smallest real leaf or above the largest. See
/// `spec/exists.md` Sec.3.3.
///
/// Sentinels have **no `terms`** (the leaf hash is fixed by ABI, not
/// derived from a quad), so the standard `verify_inclusion` step
/// `assert_eq(hash4(terms), path[0])` is replaced by a direct
/// `path[0] == consts::LOW_SENTINEL_HASH` /
/// `consts::HIGH_SENTINEL_HASH` check via the
/// `verify_low_sentinel_inclusion` /
/// `verify_high_sentinel_inclusion` primitives in `dep::utils`.
pub struct SentinelLeaf {
  pub path: [Field; MERKLE_DEPTH],
  pub directions: [u8; MERKLE_DEPTH - 1],
}

pub struct Root {
  pub value: Field,
  pub signature: Signature,
}

pub struct IndexedRoot {
  pub index: u32,
  pub root: Root,
}

pub struct Proof {
  pub vk: [Field; HONK_VK_SIZE],
  pub proof: [Field; HONK_PROOF_SIZE],
  pub public_inputs: [Field; 2],
}
