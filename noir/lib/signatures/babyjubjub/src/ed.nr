use poseidon;
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

// Returns the public key of the given secret key as (pub_key_x, pub_key_y)
pub fn eddsa_to_pub(secret: Field) -> (Field, Field) {
    let bjj = baby_jubjub();
    let pub_key = bjj.curve.mul(secret, bjj.curve.gen);
    (pub_key.x, pub_key.y)
}

mod tests {
    use poseidon::poseidon::PoseidonHasher;
    use poseidon::poseidon2::Poseidon2Hasher;

    use ec::{consts::te::baby_jubjub, tecurve::affine::Point as TEPoint};

    use super::{eddsa_to_pub, eddsa_verify};

    #[test]
    fn main() {
        let priv_key_a = 123;
        let priv_key_b = 456;
        let msg = 789;

        let bjj = baby_jubjub();

        let pub_key_a = bjj.curve.mul(priv_key_a, bjj.curve.gen);
        let pub_key_b = bjj.curve.mul(priv_key_b, bjj.curve.gen);
        let (pub_key_a_x, pub_key_a_y) = eddsa_to_pub(priv_key_a);
        let (pub_key_b_x, pub_key_b_y) = eddsa_to_pub(priv_key_b);
        assert(TEPoint::new(pub_key_a_x, pub_key_a_y) == pub_key_a);
        assert(TEPoint::new(pub_key_b_x, pub_key_b_y) == pub_key_b);
        // Manually computed as fields can't use modulo. Importantantly the commitment is within
        // the subgroup order. Note that choice of hash is flexible for this step.
        let r_at = std::hash::pedersen_commitment([pub_key_a_x, msg]).x; // modulus computed manually
        println(r_at);
        println(bjj.suborder);


        // 13380958058331317129387672577139706899020092336304495515432812077386933923252
        // 2736030358979909402780800718157159386076813972158567259200215660948447373041

        let r_a = 1414770703199880747815475415092878800081323795074043628810774576767372531818;
        // let r_b = hash::pedersen_commitment([_priv_key_b, msg])[0] % bjj.suborder; // modulus computed manually
        let r_b = 571799555715456644614141527517766533395606396271089506978608487688924659618;

        let r8_a = bjj.curve.mul(r_a, bjj.base8);
        let r8_b = bjj.curve.mul(r_b, bjj.base8);
        // let h_a: [Field; 6] = hash::poseidon::bn254::hash_5([
        //     r8_a.x,
        //     r8_a.y,
        //     pub_key_a.x,
        //     pub_key_a.y,
        //     msg,
        // ]);
        // let h_b: [Field; 6] = hash::poseidon::bn254::hash_5([
        //     r8_b.x,
        //     r8_b.y,
        //     pub_key_b.x,
        //     pub_key_b.y,
        //     msg,
        // ]);
        // let s_a = (r_a + _priv_key_a * h_a) % bjj.suborder; // modulus computed manually
        let s_a = 30333430637424319196043722294837632681219980330991241982145549329256671548;
        // let s_b = (r_b + _priv_key_b * h_b) % bjj.suborder; // modulus computed manually
        let s_b = 1646085314320208098241070054368798527940102577261034947654839408482102287019;
        // User A verifies their signature over the message
        println(pub_key_a.x);
        println(pub_key_a.y);
        println(s_a);
        println(r8_a.x);
        println(r8_a.y);
        println(msg);
        println(bjj.suborder);

//         assert(eddsa_verify::<PoseidonHasher>(
// 0x16b051f37589e0dcf4ad3c415c090798c10d3095bedeedabfcc709ad787f3507,
// 0x062800ac9e60839fab9218e5ed9d541f4586e41275f4071816a975895d349a5e,
// 0x112b0979943746dfd82db66ee20a3ab530afb3a98acc928802a70300dbe93c,
// 0x163814666f04c4d2969059a6b63ee26a0f9f0f81bd5957b0796e2e8f4a8a2f06,
// 0x1255b17d9e4bfb81831625b788f8a1665128079ac4b6c8c3cd1b857666a05a54,
// 0x0315
//         ));

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
        
        
        assert(eddsa_verify::<PoseidonHasher>(pub_key_a.x, pub_key_a.y, s_a, r8_a.x, r8_a.y, msg));
        // User B's signature over the message can't be used with user A's pub key
        assert(!eddsa_verify::<PoseidonHasher>(pub_key_a.x, pub_key_a.y, s_b, r8_b.x, r8_b.y, msg));
        // User A's signature over the message can't be used with another message
        assert(
            !eddsa_verify::<PoseidonHasher>(pub_key_a.x, pub_key_a.y, s_a, r8_a.x, r8_a.y, msg + 1),
        );
        // Using a different hash should fail
        assert(
            !eddsa_verify::<Poseidon2Hasher>(pub_key_a.x, pub_key_a.y, s_a, r8_a.x, r8_a.y, msg),
        );
        // assert(eddsa_verify::<PoseidonHasher>(
        //     9735880756823542870599005147315398584333407491253182785427746340930255886965,
        //     12713632335289729096435865576347585185731569960492924623361718344193180270623, 
        //     2080621263036922038591137013198660226491988134232503858452836021931314015523,
        //     16262528141898743186305616629048578044690060065217437484724731561170355172935,
        //     12033570225101445914253954939367244708242824678616446458222648047736411476992, 
        //     789
        // ));
    }
}

#[export]
fn bench_eddsa_poseidon(
    pub_key_x: Field,
    pub_key_y: Field,
    signature_s: Field,
    signature_r8_x: Field,
    signature_r8_y: Field,
    message: Field,
) -> bool {
    eddsa_verify::<poseidon::poseidon::PoseidonHasher>(
        pub_key_x,
        pub_key_y,
        signature_s,
        signature_r8_x,
        signature_r8_y,
        message,
    )
}
