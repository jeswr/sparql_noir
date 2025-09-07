// Logic derived from tests in https://github.com/noir-lang/eddsa/blob/master/src/lib.nr
pub mod eddsa;
use eddsa::eddsa_verify;
use poseidon::poseidon::PoseidonHasher;

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

pub fn verify_signature(
    public_key: PubKey,
    signature: Signature,
    message: Field,
) -> bool {
    // TODO: Work out if this is the correct hasher / make it configurable
    eddsa_verify::<PoseidonHasher>(public_key.x, public_key.y, signature.s, signature.r.x, signature.r.y, message)
}
