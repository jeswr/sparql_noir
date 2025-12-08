use blake2::{Blake2s256, Digest};
use num_bigint::BigUint;
use num_traits::{Num, Zero};

// BN254 field modulus (same as Noir bn254)
fn bn254_modulus() -> BigUint {
    BigUint::from_str_radix(
        "30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47",
        16,
    )
    .expect("valid modulus")
}

fn reduce_hex_to_field(hex_str: &str) -> BigUint {
    let p = bn254_modulus();
    let s = hex_str.trim_start_matches("0x");
    let n = if s.is_empty() {
        BigUint::zero()
    } else {
        BigUint::from_str_radix(s, 16).unwrap_or_else(|_| BigUint::zero())
    };
    n % p
}

fn field_to_le32_bytes(n: &BigUint) -> [u8; 32] {
    let mut bytes = n.to_bytes_le();
    bytes.resize(32, 0u8);
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes[..32]);
    out
}

fn hash_to_field_bytes(bytes: &[u8]) -> BigUint {
    // Noir's std::hash::hash_to_field uses blake2s then maps to Field
    let mut hasher = Blake2s256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let p = bn254_modulus();
    let n = BigUint::from_bytes_le(&digest);
    n % p
}

pub fn hash2(a_hex: &str, b_hex: &str) -> String {
    let a = reduce_hex_to_field(a_hex);
    let b = reduce_hex_to_field(b_hex);
    let mut data = [0u8; 64];
    data[..32].copy_from_slice(&field_to_le32_bytes(&a));
    data[32..].copy_from_slice(&field_to_le32_bytes(&b));
    let h = hash_to_field_bytes(&data);
    format!("0x{}", h.to_str_radix(16))
}

pub fn hash4(a_hex: &str, b_hex: &str, c_hex: &str, d_hex: &str) -> String {
    // hash over 4 field elements by concatenating their le bytes
    let a = reduce_hex_to_field(a_hex);
    let b = reduce_hex_to_field(b_hex);
    let c = reduce_hex_to_field(c_hex);
    let d = reduce_hex_to_field(d_hex);
    let mut data = [0u8; 128];
    data[0..32].copy_from_slice(&field_to_le32_bytes(&a));
    data[32..64].copy_from_slice(&field_to_le32_bytes(&b));
    data[64..96].copy_from_slice(&field_to_le32_bytes(&c));
    data[96..128].copy_from_slice(&field_to_le32_bytes(&d));
    let h = hash_to_field_bytes(&data);
    format!("0x{}", h.to_str_radix(16))
}

