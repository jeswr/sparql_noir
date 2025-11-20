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
    signature: {
      secp256k1: "secp256k1",
      secp256r1: "secp256r1",
      babyjubjub: "babyjubjub",
      babyjubjubOpt: "babyjubjubOpt",
      schnorr: "schnorr",
    },
    stringHashOutputSize: {},
  },
  rename: {
    hash2: "fieldHash",
    hash4: "fieldHash"
  }
} as const;
