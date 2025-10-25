pub use poseidon::{poseidon2::Poseidon2, poseidon::bn254::{hash_2, hash_4}};

pub fn p2hash2(input: [Field; 2]) -> Field {
  Poseidon2::hash(input, 2)
}

pub fn p2hash4(input: [Field; 4]) -> Field {
  Poseidon2::hash(input, 4)
}

pub fn phash2(input: [Field; 2]) -> Field {
  hash_2(input)
}

pub fn phash4(input: [Field; 4]) -> Field {
  hash_4(input)
}

pub fn keccak256<let N: u32>(input: [u8; N]) -> [u8; 32] {
  dep::keccak256::keccak256(input, N)
}
