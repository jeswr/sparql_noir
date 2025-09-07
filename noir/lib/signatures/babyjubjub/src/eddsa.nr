use std::default::Default;
use std::hash::Hasher;
use ec::{consts::te::baby_jubjub, tecurve::affine::Point as TEPoint};

pub fn eddsa_verify<H>(
    pub_key_x: Field,
    pub_key_y: Field,
    signature_s: Field,
    signature_r8_x: Field,
    signature_r8_y: Field,
    message: Field,
) -> bool
where
    H: Hasher + Default,
{
    // Verifies by testing:
    // S * B8 = R8 + H(R8, A, m) * A8
    let bjj = baby_jubjub();

    let pub_key = TEPoint::new(pub_key_x, pub_key_y);
    assert(bjj.curve.contains(pub_key));

    let signature_r8 = TEPoint::new(signature_r8_x, signature_r8_y);
    assert(bjj.curve.contains(signature_r8));
    // Ensure S < Subgroup Order
    assert(signature_s.lt(bjj.suborder));
    // Calculate the h = H(R, A, msg)
    let mut hasher = H::default();
    hasher.write(signature_r8_x);
    hasher.write(signature_r8_y);
    hasher.write(pub_key_x);
    hasher.write(pub_key_y);
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
    let left = bjj.curve.mul(signature_s, bjj.base8);

    left.eq(right)
}

mod tests {
    use poseidon::poseidon::PoseidonHasher;
    use super::{eddsa_verify};

    #[test]
    fn main() {
        assert(eddsa_verify::<PoseidonHasher>(
0xa8fe27776ee4672e5d59855a6b3d0a318c285c2dc706b8b250a611125100b04,
0x4dee6b04c7d5ab565d1a09b9297bcc5d5dfa92b7cf23d26d81f6f403d70d9c2,
0x60379daff8d349b1f74f59da81d62e464d80a0a1bc017a4a638b3ade5b37a90,
0xe9ff1fa745d6c6c058829a0128a46642a9de1e378a09aca29f465953aa6efbf,
0xf3b06c10a46d516011ada174b6287fdeebd2b5f7d2b329368dfa00d5366c981,
0
        ));

        assert(eddsa_verify::<PoseidonHasher>(
0xa8fe27776ee4672e5d59855a6b3d0a318c285c2dc706b8b250a611125100b04,
0x4dee6b04c7d5ab565d1a09b9297bcc5d5dfa92b7cf23d26d81f6f403d70d9c2,
0xabd5823a7fdd0b282deab413b8d2b0f1feebf9bce9e51e78858c99cefc0610,
0x29d07aedda37d98ff0ff3f9582fde3f2f61443c97c79e9388ccb42d6b1247780,
0x3c65a9084a010247883347c16924c9ad470bc2e9bbaa720df2df33b191d7ca,
789
        ));

        assert(eddsa_verify::<PoseidonHasher>(
0xa8fe27776ee4672e5d59855a6b3d0a318c285c2dc706b8b250a611125100b04,
0x4dee6b04c7d5ab565d1a09b9297bcc5d5dfa92b7cf23d26d81f6f403d70d9c2,
0x5501b69244997057b6463bd910edf31558847438a39d38806f5b8cda8ff44ca,
0x55708457148fe5cb894357c26ad8e342831aa3c593b32591d3c22933b50ff9,
0x246616c74d64f62e016923d5d1a1bee1327ef5e593f77ae0cf1d8752cd58d1de,
0x1f8d80e2298209f5de5331d8246749b10c5a25d51bff7e63250af90750394d34
        ));
    }
}
