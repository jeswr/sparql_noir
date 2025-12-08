use k256::PublicKey;
use k256::elliptic_curve::sec1::{Coordinates, ToEncodedPoint};
use serde::Deserialize;
use std::fs;

#[derive(Deserialize)]
struct SignJson {
    root: String,
    #[serde(rename = "pubKey")]
    pub_key: String, // hex compressed 33 bytes
    #[serde(rename = "signaure")]
    signature: String, // hex 64 bytes r||s
}

#[derive(Deserialize)]
struct BindingsJson {
    variables: Vec<String>,
    assignments: Vec<String>,
    #[serde(rename = "bgp_triples")]
    bgp_triples: Vec<[String; 4]>,
    paths: Vec<[String; 11]>,
    direction: Vec<[String; 10]>,
}

pub fn write_prover_toml(
    sign_json_path: &str,
    bindings_json_path: &str,
    out_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let sign: SignJson = serde_json::from_str(&fs::read_to_string(sign_json_path)?)?;
    let binds: BindingsJson = serde_json::from_str(&fs::read_to_string(bindings_json_path)?)?;

    // Decompress pubkey
    let pk_bytes = hex::decode(&sign.pub_key)?;
    let pk = PublicKey::from_sec1_bytes(&pk_bytes)?;
    let ep = pk.to_encoded_point(false);
    let (x, y) = match ep.coordinates() {
        Coordinates::Uncompressed { x, y } => (x.to_vec(), y.to_vec()),
        _ => return Err("Missing coordinates".into()),
    };

    // Signature bytes
    let signature: Vec<u8> = hex::decode(&sign.signature)?;

    // TOML builder using toml crate's Value for simplicity
    let mut table = toml::Table::new();

    // public_key: [ { x = [u8;32], y = [u8;32] } ]
    let mut pk_tbl = toml::Table::new();
    pk_tbl.insert(
        "x".into(),
        toml::Value::Array(x.into_iter().map(|b| toml::Value::Integer(b as i64)).collect()),
    );
    pk_tbl.insert(
        "y".into(),
        toml::Value::Array(y.into_iter().map(|b| toml::Value::Integer(b as i64)).collect()),
    );
    table.insert("public_key".into(), toml::Value::Array(vec![toml::Value::Table(pk_tbl)]));

    // roots: [ { value = Field(hex), signature = [u8;64], keyIndex = 0 } ]
    let mut root_tbl = toml::Table::new();
    root_tbl.insert("value".into(), toml::Value::String(sign.root));
    root_tbl.insert(
        "signature".into(),
        toml::Value::Array(signature.into_iter().map(|b| toml::Value::Integer(b as i64)).collect()),
    );
    root_tbl.insert("keyIndex".into(), toml::Value::Integer(0));
    table.insert("roots".into(), toml::Value::Array(vec![toml::Value::Table(root_tbl)]));

    // Convert BGP triples to Noir format like existing Prover.toml
    let mut bgp_arr = Vec::new();
    for i in 0..binds.bgp_triples.len() {
        let terms = toml::Value::Array(
            binds.bgp_triples[i]
                .iter()
                .map(|s| toml::Value::String(s.clone()))
                .collect(),
        );
        let path = toml::Value::Array(
            binds.paths[i]
                .iter()
                .map(|s| toml::Value::String(s.clone()))
                .collect(),
        );
        let dirs = toml::Value::Array(
            binds.direction[i]
                .iter()
                .take(10)
                .map(|s| {
                    let v = s.trim_start_matches("0x");
                    let n = u8::from_str_radix(v, 16).unwrap_or(0);
                    toml::Value::Integer(n as i64)
                })
                .collect(),
        );
        let mut triple_tbl = toml::Table::new();
        triple_tbl.insert("terms".into(), terms);
        triple_tbl.insert("path".into(), path);
        triple_tbl.insert("directions".into(), dirs);
        bgp_arr.push(toml::Value::Table(triple_tbl));
    }
    table.insert("bgp".into(), toml::Value::Array(bgp_arr));

    // Variables as a TOML inline table
    let mut vars_tbl = toml::Table::new();
    for (i, name) in binds.variables.iter().enumerate() {
        vars_tbl.insert(name.clone(), toml::Value::String(binds.assignments[i].clone()));
    }
    table.insert("variables".into(), toml::Value::Table(vars_tbl));
    table.insert("hidden".into(), toml::Value::Array(Vec::new()));

    let toml_str = toml::to_string_pretty(&toml::Value::Table(table))?;
    fs::write(out_path, toml_str)?;
    Ok(())
}
