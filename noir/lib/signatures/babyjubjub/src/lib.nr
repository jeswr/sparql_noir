use ec::{consts::te::baby_jubjub, tecurve::affine::Point as TEPoint};
use poseidon::poseidon::PoseidonHasher;
use poseidon::poseidon2::Poseidon2Hasher;
use std::default::Default;
use std::hash::Hasher;
// use std::hash::sha2::Sha2Hasher;

pub struct PubKey {
    pub x: Field,
    pub y: Field,
}

pub struct Point {
    pub x: Field,
    pub y: Field,
}

pub struct Signature {
    pub r: Point,
    pub s: Field,
}

pub fn eddsa_verify<H>(public_key: PubKey, signature: Signature, message: Field) -> bool
where
    H: Hasher + Default,
{
    // Verifies by testing:
    // S * B8 = R8 + H(R8, A, m) * A8
    let bjj = baby_jubjub();

    let pub_key = TEPoint::new(public_key.x, public_key.y);
    assert(bjj.curve.contains(pub_key));

    let signature_r8 = TEPoint::new(signature.r.x, signature.r.y);
    assert(bjj.curve.contains(signature_r8));
    // Ensure S < Subgroup Order
    assert(signature.s.lt(bjj.suborder));
    // Calculate the h = H(R, A, msg)
    let mut hasher = H::default();
    hasher.write(signature.r.x);
    hasher.write(signature.r.y);
    hasher.write(public_key.x);
    hasher.write(public_key.y);
    hasher.write(message);
    let hash: Field = hasher.finish();
    // Calculate second part of the right side:  right2 = h*8*A
    // Multiply by 8 by doubling 3 times. This also ensures that the result is in the subgroup.
    let pub_key_mul_2 = bjj.curve.add(pub_key, pub_key);
    let pub_key_mul_4 = bjj.curve.add(pub_key_mul_2, pub_key_mul_2);
    let pub_key_mul_8 = bjj.curve.add(pub_key_mul_4, pub_key_mul_4);
    // We check that A8 is not zero.
    assert(!pub_key_mul_8.is_zero());
    // Compute the right side: R8 + h * A8
    let right = bjj.curve.add(signature_r8, bjj.curve.mul(hash, pub_key_mul_8));
    // Calculate left side of equation left = S * B8
    let left = bjj.curve.mul(signature.s, bjj.base8);

    left.eq(right)
}

pub fn verify_signature(public_key: PubKey, signature: Signature, message: Field) -> bool {
    // TODO: Work out if this is the correct hasher / make it configurable
    eddsa_verify::<Poseidon2Hasher>(public_key, signature, message)
}
