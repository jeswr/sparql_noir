pub type PubKey = std::embedded_curve_ops::EmbeddedCurvePoint;

pub type Signature = [u8; 64];

// pub fn verify_signature(pubkey: PubKey, signature: Signature, message: Field) -> bool {
//   dep::schnorr::verify_signature(pubkey, signature, message.to_le_bytes::<32>())
// }

use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar};

pub fn verify_signature(
    public_key: PubKey,
    signature: Signature,
    message: Field,
) -> bool {
    //scalar lo/hi from bytes
    let sig_s_bytes = [signature[0], signature[1], signature[2], signature[3], signature[4], signature[5], signature[6], signature[7], signature[8], signature[9], signature[10], signature[11], signature[12], signature[13], signature[14], signature[15], signature[16], signature[17], signature[18], signature[19], signature[20], signature[21], signature[22], signature[23], signature[24], signature[25], signature[26], signature[27], signature[28], signature[29], signature[30], signature[31]];
    let sig_e_bytes = [signature[32], signature[33], signature[34], signature[35], signature[36], signature[37], signature[38], signature[39], signature[40], signature[41], signature[42], signature[43], signature[44], signature[45], signature[46], signature[47], signature[48], signature[49], signature[50], signature[51], signature[52], signature[53], signature[54], signature[55], signature[56], signature[57], signature[58], signature[59], signature[60], signature[61], signature[62], signature[63]];
    let sig_s = EmbeddedCurveScalar::from_field(Field::from_le_bytes(sig_s_bytes));
    let sig_e = EmbeddedCurveScalar::from_field(Field::from_le_bytes(sig_e_bytes));
    // pub_key is on Grumpkin curve
    let mut is_ok = (public_key.y * public_key.y == public_key.x * public_key.x * public_key.x - 17)
        & (!public_key.is_infinite);

    if is_ok {
        println("Public key is on Grumpkin curve: true");
    } else {
        println("Public key is on Grumpkin curve: false");
    }

    if ((sig_s.lo != 0) | (sig_s.hi != 0)) & ((sig_e.lo != 0) | (sig_e.hi != 0)) {
        let (r_is_infinite, result) =
            calculate_signature_challenge(public_key, sig_s, sig_e, message.to_le_bytes::<32>());

        is_ok &= !r_is_infinite;
        for i in 0..32 {
            is_ok &= result[i] == signature[32 + i];
        }
    } else {
        is_ok = false;
    }
    is_ok
}

pub fn assert_valid_signature<let N: u32>(
    public_key: EmbeddedCurvePoint,
    signature: [u8; 64],
    message: [u8; N],
) {
    //scalar lo/hi from bytes
    let sig_s_bytes = [signature[0], signature[1], signature[2], signature[3], signature[4], signature[5], signature[6], signature[7], signature[8], signature[9], signature[10], signature[11], signature[12], signature[13], signature[14], signature[15], signature[16], signature[17], signature[18], signature[19], signature[20], signature[21], signature[22], signature[23], signature[24], signature[25], signature[26], signature[27], signature[28], signature[29], signature[30], signature[31]];
    let sig_e_bytes = [signature[32], signature[33], signature[34], signature[35], signature[36], signature[37], signature[38], signature[39], signature[40], signature[41], signature[42], signature[43], signature[44], signature[45], signature[46], signature[47], signature[48], signature[49], signature[50], signature[51], signature[52], signature[53], signature[54], signature[55], signature[56], signature[57], signature[58], signature[59], signature[60], signature[61], signature[62], signature[63]];
    let sig_s = EmbeddedCurveScalar::from_field(Field::from_le_bytes(sig_s_bytes));
    let sig_e = EmbeddedCurveScalar::from_field(Field::from_le_bytes(sig_e_bytes));

    // assert pub_key is on Grumpkin curve
    assert(public_key.y * public_key.y == public_key.x * public_key.x * public_key.x - 17);
    assert(public_key.is_infinite == false);
    // assert signature is not null
    assert((sig_s.lo != 0) | (sig_s.hi != 0));
    assert((sig_e.lo != 0) | (sig_e.hi != 0));

    let (r_is_infinite, result) = calculate_signature_challenge(public_key, sig_s, sig_e, message);

    assert(!r_is_infinite);
    for i in 0..32 {
        assert(result[i] == signature[32 + i]);
    }
}

fn calculate_signature_challenge<let N: u32>(
    public_key: EmbeddedCurvePoint,
    sig_s: EmbeddedCurveScalar,
    sig_e: EmbeddedCurveScalar,
    message: [u8; N],
) -> (bool, [u8; 32]) {
    let g1 = EmbeddedCurvePoint {
        x: 1,
        y: 17631683881184975370165255887551781615748388533673675138860,
        is_infinite: false,
    };
    let r = std::embedded_curve_ops::multi_scalar_mul([g1, public_key], [sig_s, sig_e]);
    // compare the _hashes_ rather than field elements modulo r
    let pedersen_hash = std::hash::pedersen_hash([r.x, public_key.x, public_key.y]);
    let pde: [u8; 32] = pedersen_hash.to_be_bytes();

    let mut hash_input = [0; N + 32];
    for i in 0..32 {
        hash_input[i] = pde[i];
    }
    for i in 0..N {
        hash_input[32 + i] = message[i];
    }

    let result = std::hash::blake2s(hash_input);
    (r.is_infinite, result)
}

#[test]
fn test_zero_signature() {
    let public_key: EmbeddedCurvePoint = EmbeddedCurvePoint {
        x: 1,
        y: 17631683881184975370165255887551781615748388533673675138860,
        is_infinite: false,
    };
    let verified = verify_signature(public_key, [0; 64], 0);
    assert(!verified);
}
