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

pub fn eddsa_verify<H>(public_key: PubKey, signature: Signature, message: Field) -> bool
where
    H: Hasher + Default,
{
    // Verifies by testing:
    // S * B8 = R8 + H(R8, A, m) * A8
    let bjj = baby_jubjub();

    assert(bjj.curve.contains(signature.r));

    // TODO: SEE IF THIS IS REQUIRED / can make the signature easier to forge
    // Ensure S < Subgroup Order
    // assert(signature.s.lt(bjj.suborder));

    // TODO: See if
    // Calculate the h = H(R, A, msg)
    let mut hasher = H::default();
    hasher.write(signature.r.x);
    hasher.write(signature.r.y);
    hasher.write(public_key.value.x);
    hasher.write(public_key.value.y);
    hasher.write(message);
    let hash: Field = hasher.finish();
    // let hash: Field = 1234;

    // Compute the right side: R8 + h * A8
    let right = bjj.curve.add(signature.r, bjj.curve.mul(hash, public_key.k8));

    signature.left.eq(right)
}

pub fn verify_signature(public_key: PubKey, signature: Signature, message: Field) -> bool {
    // TODO: Work out if this is the correct hasher / make it configurable
    eddsa_verify::<PoseidonHasher>(public_key, signature, message)
}
