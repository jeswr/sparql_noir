export default {
  noir: {
    hash2: {
      blake2s: "std::hash::hash_to_field",
      pedersen: "std::hash::pedersen_hash"
    },
    hash4: {
      blake2s: "std::hash::hash_to_field",
      pedersen: "std::hash::pedersen_hash"
    },
    stringHash: {
      blake2s: "std::hash::blake2s",
      blake3: "std::hash::blake3",
      sha256: "dep::sha256::sha256::sha256"
    },
    signature: {
      secp256k1: "secp256k1",
      secp256r1: "secp256r1",
      babyjubjub: "babyjubjub",
      babyjubjubOpt: "babyjubjubOpt"
    }
  },
  rename: {
    hash2: "fieldHash",
    hash4: "fieldHash"
  }
} as const;
