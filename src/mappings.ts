export default {
  noir: {
    hash2: {
      // blake2s: "std::hash::hash_to_field",
      pedersen: "std::hash::pedersen_hash",
      poseidon: "dep::hashes::phash2",
      poseidon2: "dep::hashes::p2hash2",
      mimc: "dep::mimc::mimc_bn254",
    },
    hash4: {
      // blake2s: "std::hash::hash_to_field",
      pedersen: "std::hash::pedersen_hash",
      poseidon: "dep::hashes::phash4",
      poseidon2: "dep::hashes::p2hash4",
      mimc: "dep::mimc::mimc_bn254",
    },
    stringHash: {
      blake2s: "std::hash::blake2s",
      blake3: "std::hash::blake3",
      sha256: "dep::sha256::digest",
      sha384: "dep::sha512::sha384::digest",
      sha512: "dep::sha512::sha512::digest",
      keccak256: "dep::hashes::keccak256",
    },
    /**
     * Variable-length string hash, dispatched per `stringHash`. Must
     * satisfy: `stringHashVar(buf, len) == stringHash(buf[0..len])` for
     * any honest prover. Round-2 byte-binding only ships under sha256;
     * the remaining hashes lack a variable-length Noir API and
     * therefore assert (so the round-2 byte-binding contract remains
     * sound). Round-3 scope -- see `spec/encoding.md` sec.6.5.
     */
    stringHashVar: {
      sha256: "dep::sha256::sha256_var(input, length as u64)",
      // The following hashes have no variable-length API in their
      // Noir implementations (or use an incompatible BoundedVec
      // shape that we've not yet plumbed through). Asserting `false`
      // keeps the round-2 byte-binding contract sound: honest provers
      // under a non-variable-length hash trip the assertion at
      // proving time before any mismatch can be exploited.
      blake2s: "{ let _ = input; let _ = length; assert(false, \"hash_string_var: blake2s lacks variable-length API -- round-2 byte-binding is sha256-only\"); [0; 32] }",
      blake3: "{ let _ = input; let _ = length; assert(false, \"hash_string_var: blake3 lacks variable-length API -- round-2 byte-binding is sha256-only\"); [0; 32] }",
      sha384: "{ let _ = input; let _ = length; assert(false, \"hash_string_var: sha384 not yet wired -- round-2 byte-binding is sha256-only\"); [0; 48] }",
      sha512: "{ let _ = input; let _ = length; assert(false, \"hash_string_var: sha512 not yet wired (BoundedVec API mismatch) -- round-2 byte-binding is sha256-only\"); [0; 64] }",
      keccak256: "{ let _ = input; let _ = length; assert(false, \"hash_string_var: keccak256 lacks variable-length API -- round-2 byte-binding is sha256-only\"); [0; 32] }",
    },
    signature: {
      secp256k1: "secp256k1",
      secp256r1: "secp256r1",
      babyjubjub: "babyjubjub",
      babyjubjubOpt: "babyjubjubOpt",
      schnorr: "schnorr",
    },
    stringHashOutputSize: {},
    stringLenMax: {},
  },
  rename: {
    hash2: "fieldHash",
    hash4: "fieldHash",
    stringHashVar: "stringHash"
  }
} as const;
