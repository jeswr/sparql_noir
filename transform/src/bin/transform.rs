//! SPARQL to Noir Circuit Transformer - CLI
//!
//! This binary provides a command-line interface for the SPARQL to Noir transformer.

use std::fs;
use std::path::Path;

use clap::{Arg, Command};

// Import from the library
use transform::transform_query;

fn write_file(path: &str, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)
}

fn get_repo_root() -> String {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| manifest_dir.to_string_lossy().to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let matches = Command::new("sparql_noir")
        .version("1.0")
        .about("Generates Noir ZK circuits from SPARQL queries")
        .arg(
            Arg::new("query")
                .short('q')
                .long("query")
                .value_name("QUERY")
                .help("SPARQL query string or path to .rq file")
                .num_args(1),
        )
        .arg(
            Arg::new("input")
                .short('i')
                .long("input")
                .value_name("FILE")
                .help("(Legacy, ignored) Input RDF file")
                .num_args(1),
        )
        .arg(
            Arg::new("output")
                .short('o')
                .long("output")
                .value_name("FILE")
                .help("(Legacy, ignored) Output path")
                .num_args(1),
        )
        .get_matches();

    // Read query - require explicit query specification
    let query_text = if let Some(q) = matches.get_one::<String>("query") {
        let path = Path::new(q);
        if path.exists() {
            fs::read_to_string(path)?
        } else {
            q.clone()
        }
    } else {
        return Err("No query specified. Use -q <query> or -q <path/to/query.rq>".into());
    };

    // Use the library function
    let result = transform_query(&query_text).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

    // Write outputs
    let repo_root = get_repo_root();
    let sparql_out = format!("{}/noir_prove/src/sparql.nr", repo_root);
    let main_out = format!("{}/noir_prove/src/main.nr", repo_root);
    let nargo_out = format!("{}/noir_prove/Nargo.toml", repo_root);
    let meta_out = format!("{}/noir_prove/metadata.json", repo_root);

    write_file(&sparql_out, &result.sparql_nr)?;
    write_file(&main_out, &result.main_nr)?;
    write_file(&nargo_out, &result.nargo_toml)?;
    write_file(&meta_out, &serde_json::to_string_pretty(&result.metadata)?)?;

    println!(
        "Generated: {}, {}, {}, {}",
        sparql_out, main_out, nargo_out, meta_out
    );

    Ok(())
}
