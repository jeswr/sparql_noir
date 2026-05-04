use dep::consts::{MERKLE_DEPTH, STRING_LEN_MAX, HONK_VK_SIZE, HONK_PROOF_SIZE, signature::Signature};

/// One term of a triple, carrying both the field-element identity
/// (`hash`) and a bounded byte-array witness (`bytes` / `length`).
///
/// **Round-1 contract** (see `spec/encoding.md` sec.6.3):
///
/// - The Merkle commitment / inclusion check (`utils::verify_inclusion`)
///   binds **only** the `hash` field. The `bytes` / `length` witnesses
///   are advisory at the Triple level -- an adversarial prover may set
///   them to anything until a string operator constrains them at its
///   call site.
/// - Round-2 string-operator lowering (`STRSTARTS`, `CONTAINS`, etc.)
///   will emit, immediately before reading `bytes`, an equality
///   constraint of the form
///   `consts::encode_string_bounded(w.bytes, w.length) == expected_lexical_hash`,
///   tying the byte witness to the term's lexical-form hash. Reading
///   `bytes` without that binding is unsound.
/// - `length` is the count of meaningful bytes; positions
///   `[length..STRING_LEN_MAX)` are unconstrained padding (typically
///   zero). Consumers walking the bytes MUST clamp their index to
///   `length`.
///
/// `STRING_LEN_MAX` is set in `noir/lib/consts/src/lib.nr` (default 64,
/// configurable via `setup.ts --string-len-max <n>`).
pub struct TermWitness {
  pub hash: Field,
  pub bytes: [u8; STRING_LEN_MAX],
  pub length: u32,
}

pub struct Triple {
  pub terms: [TermWitness; 4],
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
