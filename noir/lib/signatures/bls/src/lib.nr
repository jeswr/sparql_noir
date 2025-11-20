use ec::{consts::te::baby_jubjub, tecurve::affine::Point as TEPoint};
use poseidon::poseidon::PoseidonHasher;
use poseidon::poseidon2::Poseidon2Hasher;
use std::default::Default;
use std::hash::Hasher;

pub struct PubKey {
    value: TEPoint,
    k8: TEPoint,
}

pub struct Signature {
    pub r: TEPoint,
    pub left: TEPoint,
}

// Compilation time is extremely slow (https://github.com/onurinanc/noir-bls-signature)
// so this is not worth implementing.

pub fn verify_signature(public_key: PubKey, signature: Signature, message: Field) -> bool {
    // Raise not implemented error
    false
}
