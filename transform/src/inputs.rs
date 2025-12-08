use k256::PublicKey;
use k256::elliptic_curve::sec1::{Coordinates, ToEncodedPoint};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Deserialize)]
struct SignJson {
    root: String,
    #[serde(rename = "pubKey")]
    pub_key: String, // hex compressed 33 bytes
    #[serde(rename = "signaure")]
    signature: String, // hex 64 bytes r||s
    triples: Vec<[String; 4]>,
    paths: Vec<[String; 11]>,
    direction: Vec<[String; 10]>,
}

#[derive(Deserialize)]
struct BindingsJson {
    variables: Vec<String>,
    assignments: Vec<String>,
    #[serde(rename = "bgp_triples")]
    bgp_triples: Vec<[String; 4]>,
    // bindings file does not carry real paths; we'll map using sign.json
}

#[derive(Serialize)]
struct PubKeyOut { x: Vec<u8>, y: Vec<u8> }

#[derive(Serialize)]
struct RootOut {
    value: String,
    signature: Vec<u8>,
    #[serde(rename = "keyIndex")]
    key_index: u32,
}

#[derive(Serialize)]
struct TripleOut {
    terms: [String; 4],
    path: [String; 11],
    directions: [u8; 10],
}

#[derive(Serialize)]
struct InputsOut {
    public_key: [PubKeyOut; 1],
    roots: [RootOut; 1],
    bgp: Vec<TripleOut>,
    variables: serde_json::Value,
}

pub fn write_noir_inputs(
    sign_json_path: &str,
    bindings_json_path: &str,
    out_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let sign: SignJson = serde_json::from_str(&fs::read_to_string(sign_json_path)?)?;
    let binds: BindingsJson = serde_json::from_str(&fs::read_to_string(bindings_json_path)?)?;

    // Decompress secp256k1 public key
    let pk_bytes = hex::decode(&sign.pub_key)?;
    let pk = PublicKey::from_sec1_bytes(&pk_bytes)?;
    let ep = pk.to_encoded_point(false);
    let (x, y) = match ep.coordinates() {
        Coordinates::Uncompressed { x, y } => (x.to_vec(), y.to_vec()),
        _ => return Err("Missing coordinates".into()),
    };

    // Signature r||s -> [u8;64]
    let sig_bytes = hex::decode(&sign.signature)?;
    let signature = sig_bytes;

    // Build BGP triples array using signer paths/directions mapped by triple equality
    let mut bgp: Vec<TripleOut> = Vec::with_capacity(binds.bgp_triples.len());
    for i in 0..binds.bgp_triples.len() {
        let terms = &binds.bgp_triples[i];
        let idx = sign
            .triples
            .iter()
            .position(|t| t == terms)
            .ok_or_else(|| format!("Triple not found in signer output: {:?}", terms))?;
        let mut dirs = [0u8; 10];
        for (j, s) in sign.direction[idx].iter().enumerate().take(10) {
            let v = s.trim_start_matches("0x");
            dirs[j] = u8::from_str_radix(v, 16).unwrap_or(0);
        }
        bgp.push(TripleOut {
            terms: terms.clone(),
            path: sign.paths[idx].clone(),
            directions: dirs,
        });
    }

    // Variables map
    let mut vars_obj = serde_json::Map::new();
    for (i, name) in binds.variables.iter().enumerate() {
        vars_obj.insert(name.clone(), serde_json::Value::String(binds.assignments[i].clone()));
    }

    let out = InputsOut {
    public_key: [PubKeyOut { x, y }],
    roots: [RootOut { value: sign.root, signature, key_index: 0 }],
        bgp,
        variables: serde_json::Value::Object(vars_obj),
    };

    fs::write(out_path, serde_json::to_string_pretty(&out)?)?;
    Ok(())
}
