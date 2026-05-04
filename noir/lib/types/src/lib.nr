use dep::consts::{MERKLE_DEPTH, HONK_VK_SIZE, HONK_PROOF_SIZE, signature::Signature};

pub struct Triple {
  pub terms: [Field; 4],
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
/// **strictly between** the sentinels (i.e. `0 < absent_hash < p - 1`)
/// witnessable by `verify_non_membership_*` -- including hashes that
/// fall below the smallest real leaf or above the largest. The strict
/// `<` bracketing means an `absent_hash` equal to a sentinel value
/// itself is unwitnessable, but that requires the verifier to supply
/// `absent_hash` in `{0, p - 1}`; for `absent_hash = consts::hash4(...)`
/// this is a preimage event with probability `<= 1/p ~= 2^-254` and is
/// therefore negligible. See `spec/exists.md` Sec.3.3.
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
