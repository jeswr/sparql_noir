pub global MERKLE_DEPTH: u32 = 11;
pub global hash2: fn([Field; 2]) -> Field = std::hash::pedersen_hash;
pub global hash4: fn([Field; 4]) -> Field = std::hash::pedersen_hash;
pub global verify_signature: fn([u8; 32], [u8; 32], [u8; 64], [u8; 32]) -> bool = std::ecdsa_secp256k1::verify_signature;

pub fn hash_string<let N: u32>(input: [u8; N]) -> [u8; 32] {
    std::hash::blake2s(input)
}

// Recursion
pub global HONK_VK_SIZE: u32 = 112;
pub global HONK_PROOF_SIZE: u32 = 456;
pub global HONK_IDENTIFIER: u32 = 1;
