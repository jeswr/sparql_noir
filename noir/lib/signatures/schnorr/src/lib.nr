pub type PubKey = std::embedded_curve_ops::EmbeddedCurvePoint;

pub type Signature = [u8; 64];

// pub struct Signature {
//     s: std::embedded_curve_ops::EmbeddedCurveScalar,
//     e: std::embedded_curve_ops::EmbeddedCurveScalar,
// }

// pub fn verify_signature(pubkey: PubKey, signature: Signature, message: Field) -> bool {
//   dep::schnorr::verify_signature(pubkey, signature, message.to_le_bytes::<32>())
// }

use std::{embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar}};

pub fn verify_signature(
    public_key: PubKey,
    signature: Signature,
    message: Field,
) -> bool {
    //scalar lo/hi from bytes
        //scalar lo/hi from bytes
    let sig_s = scalar_from_bytes(signature, 0);
    let sig_e = scalar_from_bytes(signature, 32);

    println("singature values are");
    println(sig_s);
    println(sig_e);

    // pub_key is on Grumpkin curve
    let mut is_ok = (public_key.y * public_key.y == public_key.x * public_key.x * public_key.x - 17)
        & (!public_key.is_infinite);

    if is_ok {
        println("Public key is on Grumpkin curve: true");
    } else {
        println("Public key is on Grumpkin curve: false");
    }

    println("Signature components extracted");
    println(sig_s.lo);
    println(sig_s.hi);
    println(sig_e.lo);
    println(sig_e.hi);
    println(((sig_s.lo != 0) | (sig_s.hi != 0)) & ((sig_e.lo != 0) | (sig_e.hi != 0)));
    if ((sig_s.lo != 0) | (sig_s.hi != 0)) & ((sig_e.lo != 0) | (sig_e.hi != 0)) {
        let (r_is_infinite, result) =
            calculate_signature_challenge(public_key, sig_s, sig_e, message.to_le_bytes::<32>());

        println("pre looping");

        is_ok &= !r_is_infinite;

        println(is_ok);

        for i in 0..32 {
            print("loop i:");
            println(i);
            println(result[i]);
            println(signature[32 + i]);
            println(signature[i]);
            is_ok &= result[i] == signature[32 + i];
        }

        println("post looping");
        println(is_ok);

    } else {
        is_ok = false;
    }
    println(is_ok);
    is_ok
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

//Bytes to scalar: take the first (after the specified offset) 16 bytes of the input as the lo value, and the next 16 bytes as the hi value
fn scalar_from_bytes(bytes: [u8; 64], offset: u32) -> EmbeddedCurveScalar {
    let mut v: Field = 1;
    let mut lo: Field = 0;
    let mut hi: Field = 0;
    for i in 0..16 {
        lo = lo + (bytes[offset + 31 - i] as Field) * v;
        hi = hi + (bytes[offset + 15 - i] as Field) * v;
        v = v * 256;
    }
    let sig_s = EmbeddedCurveScalar::new(lo, hi);
    sig_s
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

#[test]
fn test_actual_signature() {
    let public_key: EmbeddedCurvePoint = EmbeddedCurvePoint {
        x: 0x21aedc10ed933f1e7ebfdb0a6f46ff94521268c733436023f005ae6039858260,
        y: 0x1da965201959641ea49ae08ccec9520517d6d08a828d93cfaa2a9f9cffd6bfd1,
        is_infinite: false,
    };
    let signature = [
        36, 164, 123, 151, 119, 114,  49, 218,  56,  65, 211,
        91, 190,  10,  62,  67, 106,  46, 113,  30, 142, 247,
        178, 134,  93,  75, 181, 231,  54, 219,  73, 228,  89,
        120,  28,   5, 180, 107,  34, 220, 183,  12,  95, 225,
        138,  50, 206, 165,  70, 191, 134,  64, 120, 164, 161,
        40, 206,  80, 223,   6, 131, 192, 128,  75
    ];
    let verified = verify_signature(public_key, signature, 0x11b8e9f630af889935f79017fdedc559bb037aa8e881dd4e349714ed620bbaba);
    assert(verified);
}
