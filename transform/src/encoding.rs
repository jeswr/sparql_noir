use num_bigint::BigUint;
use num_traits::{Num, Zero};
use oxrdf::{GraphName, Term};

use crate::merkle; // reuse hash2/hash4 for combining components

fn bn254_modulus() -> BigUint {
    BigUint::from_str_radix(
        "30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47",
        16,
    )
    .expect("valid modulus")
}

fn blake3_field_hex(bytes: &[u8]) -> String {
    let digest = blake3::hash(bytes);
    let p = bn254_modulus();
    let n = BigUint::from_bytes_le(digest.as_bytes()) % p;
    format!("0x{}", n.to_str_radix(16))
}

fn dec_string_to_field_hex(s: &str) -> String {
    let p = bn254_modulus();
    if s.is_empty() {
        return "0x0".to_string();
    }
    let n = BigUint::from_str_radix(s, 10).unwrap_or_else(|_| BigUint::zero()) % p;
    format!("0x{}", n.to_str_radix(16))
}

pub fn term_field_hex(term: &Term) -> String {
    match term {
        Term::NamedNode(nn) => blake3_field_hex(nn.as_str().as_bytes()),
        Term::Literal(lit) => {
            let value = blake3_field_hex(lit.value().as_bytes());
            let special = match lit.datatype().as_str() {
                "http://www.w3.org/2001/XMLSchema#boolean" => match lit.value().to_ascii_lowercase().as_str() {
                    "true" | "1" => "0x1".to_string(),
                    _ => "0x0".to_string(),
                },
                "http://www.w3.org/2001/XMLSchema#integer" => dec_string_to_field_hex(lit.value()),
                _ => blake3_field_hex(lit.value().as_bytes()),
            };
            let lang = lit
                .language()
                .map(|l| blake3_field_hex(l.as_bytes()))
                .unwrap_or_else(|| blake3_field_hex("".as_bytes()));
            let dtype = blake3_field_hex(lit.datatype().as_str().as_bytes());
            // Combine 4 components via blake2s-based hash_to_field to mirror Noir
            merkle::hash4(&value, &special, &lang, &dtype)
        }
        Term::BlankNode(bn) => blake3_field_hex(format!("_:{}", bn.as_str()).as_bytes()),
    }
}

pub fn get_term_encoding_string(term: &Term) -> String {
    let (code_hex, inner) = match term {
        Term::NamedNode(_) => ("0x0".to_string(), term_field_hex(term)),
        Term::BlankNode(_) => ("0x1".to_string(), term_field_hex(term)),
        Term::Literal(_) => ("0x2".to_string(), term_field_hex(term)),
    };
    merkle::hash2(&code_hex, &inner)
}

pub fn get_graph_encoding_string(g: &GraphName) -> String {
    match g {
        GraphName::NamedNode(n) => get_term_encoding_string(&Term::from(n.clone())),
        GraphName::BlankNode(b) => get_term_encoding_string(&Term::from(b.clone())),
        GraphName::DefaultGraph => {
            let enc = blake3_field_hex("".as_bytes());
            merkle::hash2("0x4", &enc)
        }
    }
}
