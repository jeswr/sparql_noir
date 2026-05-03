//! SPARQL → Noir circuit transformer.
//!
//! This crate compiles a SPARQL query into the artefacts a Noir prover
//! needs: a query-specific `sparql.nr` (constraint body), a `main.nr`
//! entry point, a `Nargo.toml` manifest, and a JSON metadata document
//! describing the pattern positions / hidden inputs the verifier must
//! provide. It also produces one circuit variant per OPTIONAL bit-mask.
//!
//! Internally the pipeline is layered (see SPARQL_ROADMAP.md §6.1):
//!
//! ```text
//! parse   → spargebra parsing & query-form dispatch
//! ir      → algebra-level data types
//! lower   → GraphPattern → IR
//! expr    → Expression → Noir code strings
//! emit    → IR → sparql.nr / main.nr / Nargo.toml
//! metadata → IR → JSON
//! ```
//!
//! `transform_query` orchestrates these layers; everything else is
//! deliberately private to the crate.

mod emit;
mod expr;
mod ir;
mod lower;
mod metadata;
mod parse;

pub use crate::expr::{ieee754_equal, ieee754_less_than, FloatSpecial};
pub use crate::ir::{
    Aggregate, AggregateKind, Assertion, Binding, ContextualizedTriple, GraphContext, OptionalBlock,
    OrderDirection, OrderKey, PatternInfo, QueryInfo, Term,
};

use crate::emit::{
    build_nargo_toml, collect_all_optional_blocks, fill_main_nr_template,
    generate_circuit_for_optional_combination,
};
use crate::lower::{process_query_with_options, reset_optional_counter};
use crate::metadata::{build_base_metadata, build_variant_metadata};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::wasm_bindgen;

/// Result of the transform operation, serializable to JSON
#[derive(serde::Serialize)]
pub struct TransformResult {
    pub sparql_nr: String,
    pub main_nr: String,
    pub nargo_toml: String,
    pub metadata: serde_json::Value,
    /// Additional circuits for OPTIONAL combinations (if any)
    /// Each entry represents a different combination of optional patterns being matched
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub optional_circuits: Vec<OptionalCircuit>,
}

/// A circuit variant for a specific OPTIONAL combination
#[derive(serde::Serialize, Clone)]
pub struct OptionalCircuit {
    /// Which optional block IDs are matched in this variant
    pub matched_optionals: Vec<usize>,
    /// The sparql.nr content for this variant
    pub sparql_nr: String,
    /// Metadata for this variant
    pub metadata: serde_json::Value,
}

/// Error result
#[derive(serde::Serialize)]
pub struct TransformError {
    pub error: String,
}

/// Default cap on the number of OPTIONAL blocks accepted by the
/// transform. Each OPTIONAL doubles the number of generated circuit
/// variants (one per matched/unmatched bit-mask), so the practical
/// limit is small. Round 3 will collapse the power-set into a single
/// circuit (per SPARQL_ROADMAP.md §6.4 / Q2 decision); until then we
/// reject queries above this bound rather than silently exploding.
pub const DEFAULT_OPTIONAL_CAP: usize = 4;

/// Default cap on the unrolled depth of `+` and `*` Kleene paths. The
/// transform unrolls `path+` to `path | path/path | …` up to this many
/// segments and rejects deeper unrolls. Trade-off: larger values match
/// longer chains but inflate the BGP and (when nested in a UNION) the
/// branch count quadratically. Configurable via
/// [`TransformOptions::path_segment_max`].
pub const DEFAULT_PATH_SEGMENT_MAX: usize = 4;

/// Options for the transform operation
#[derive(Clone, Debug)]
pub struct TransformOptions {
    /// If true, generate a simplified circuit without signature/Merkle verification
    pub skip_signing: bool,
    /// Reject queries with more than this many flattened OPTIONAL
    /// blocks. Defaults to [`DEFAULT_OPTIONAL_CAP`].
    pub optional_cap: usize,
    /// Maximum unrolled depth for `+` / `*` Kleene paths. Defaults to
    /// [`DEFAULT_PATH_SEGMENT_MAX`].
    pub path_segment_max: usize,
}

impl Default for TransformOptions {
    fn default() -> Self {
        Self {
            skip_signing: false,
            optional_cap: DEFAULT_OPTIONAL_CAP,
            path_segment_max: DEFAULT_PATH_SEGMENT_MAX,
        }
    }
}

/// Transform a SPARQL query into Noir circuit files.
/// 
/// Returns a TransformResult containing:
/// - sparql_nr: The query-specific constraint checking code
/// - main_nr: The circuit entry point
/// - nargo_toml: The Nargo package manifest
/// - metadata: JSON metadata about the query patterns
pub fn transform_query(query_str: &str) -> Result<TransformResult, String> {
    transform_query_with_options(query_str, TransformOptions::default())
}

/// Transform a SPARQL query into Noir circuit files with options.
pub fn transform_query_with_options(query_str: &str, options: TransformOptions) -> Result<TransformResult, String> {
    // Reset the optional block counter for each new query
    reset_optional_counter();
    
    let query = crate::parse::parse_query(query_str)?;
    let root = crate::parse::root_pattern(&query);

    let info = process_query_with_options(root, &options)?;

    // Collect all optional blocks (flatten nested optionals for now)
    let all_optionals = collect_all_optional_blocks(&info.pattern.optional_blocks);
    let num_optionals = all_optionals.len();

    // Defensive cap (round 2 — see SPARQL_ROADMAP.md §7 + §6.4). Each
    // OPTIONAL doubles the variant count; collapse to a single circuit
    // is round 3. Reject explicitly so users see a clear error rather
    // than waiting on an exponential build.
    if num_optionals > options.optional_cap {
        return Err(format!(
            "Query has {} OPTIONAL blocks, exceeding the configured cap of {}. \
             Each OPTIONAL doubles the number of generated circuit variants \
             (2^n); raise `TransformOptions::optional_cap` if you really need \
             this, or refactor the query. Round 3 will collapse the power \
             set into a single circuit.",
            num_optionals, options.optional_cap
        ));
    }
    
    // Generate the base circuit (the "all optionals matched" variant).
    let (base_sparql_nr, base_hidden, has_hidden, needs_xpath) = generate_circuit_for_optional_combination(
        &info,
        &all_optionals,
        &(0..num_optionals).collect::<Vec<_>>(),
        &options,
    )?;

    let main_nr = fill_main_nr_template(options.skip_signing, has_hidden);

    // EBV pulls in `dep::ebv`; that detection lives at the same layer as
    // the `Nargo.toml` shape, so they share a derivation step.
    let needs_ebv = base_hidden.iter().any(|h| {
        h.get("computedType").and_then(|v| v.as_str())
            .map(|t| t == "ebv_value" || t == "ebv_datatype")
            .unwrap_or(false)
    });
    let nargo_toml = build_nargo_toml(options.skip_signing, needs_ebv, needs_xpath);

    let metadata = build_base_metadata(&info, &all_optionals, options.skip_signing, &base_hidden);

    // Power-set of OPTIONAL bitmasks, minus the all-matched case (that's
    // the base circuit). For n=0 this loop runs zero times.
    let mut optional_circuits = Vec::new();
    if num_optionals > 0 {
        let num_combinations = 1usize << num_optionals;
        for combo in 0..(num_combinations - 1) {
            let matched_indices: Vec<usize> = (0..num_optionals)
                .filter(|i| (combo >> i) & 1 == 1)
                .collect();

            let (circuit_sparql_nr, circuit_hidden, _, _) =
                generate_circuit_for_optional_combination(
                    &info,
                    &all_optionals,
                    &matched_indices,
                    &options,
                )?;

            let circuit_metadata = build_variant_metadata(
                &info,
                &all_optionals,
                &matched_indices,
                options.skip_signing,
                &circuit_hidden,
            );

            optional_circuits.push(OptionalCircuit {
                matched_optionals: matched_indices,
                sparql_nr: circuit_sparql_nr,
                metadata: circuit_metadata,
            });
        }
    }

    Ok(TransformResult {
        sparql_nr: base_sparql_nr,
        main_nr,
        nargo_toml,
        metadata,
        optional_circuits,
    })
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn transform(query: &str) -> String {
    transform_with_options(query, false)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn transform_with_options(query: &str, skip_signing: bool) -> String {
    let options = TransformOptions {
        skip_signing,
        ..TransformOptions::default()
    };
    match transform_query_with_options(query, options) {
        Ok(result) => serde_json::to_string(&result).unwrap_or_else(|e| {
            serde_json::to_string(&TransformError { error: e.to_string() }).unwrap()
        }),
        Err(e) => serde_json::to_string(&TransformError { error: e }).unwrap(),
    }
}

// For non-WASM targets, provide a simple function that can be called from main.rs
#[cfg(not(target_arch = "wasm32"))]
pub fn transform(query: &str) -> Result<TransformResult, String> {
    transform_query(query)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn transform_with_opts(query: &str, options: TransformOptions) -> Result<TransformResult, String> {
    transform_query_with_options(query, options)
}
