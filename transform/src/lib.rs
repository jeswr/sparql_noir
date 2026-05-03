//! SPARQL to Noir Circuit Transformer - Library
//!
//! This library provides the core transformation functionality that can be
//! compiled to WebAssembly for use in JavaScript/TypeScript environments.
//!
//! The crate is laid out as a layered IR (see SPARQL_ROADMAP.md §6.1):
//! `parse` → `ir` → `lower` → `expr` → `emit` / `metadata`. The internal
//! module skeletons are present but currently empty; subsequent commits move
//! their contents out of this file one layer at a time.

mod parse;
mod ir;
mod expr;
mod lower;
mod emit;
mod metadata;

pub use crate::expr::{ieee754_equal, ieee754_less_than, FloatSpecial};

use crate::emit::{
    build_nargo_toml, collect_all_optional_blocks, fill_main_nr_template,
    generate_circuit_for_optional_combination,
};
use crate::lower::{process_query, reset_optional_counter};
use crate::metadata::contextualized_pattern_to_json;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::wasm_bindgen;

pub use crate::ir::{
    Assertion, Binding, ContextualizedTriple, GraphContext, OptionalBlock, PatternInfo,
    QueryInfo, Term,
};

// =============================================================================
// RESULT TYPES FOR WASM
// =============================================================================

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

// =============================================================================
// CORE TRANSFORM FUNCTION
// =============================================================================

/// Options for the transform operation
#[derive(Default, Clone, Debug)]
pub struct TransformOptions {
    /// If true, generate a simplified circuit without signature/Merkle verification
    pub skip_signing: bool,
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

    let info = process_query(root)?;

    // Collect all optional blocks (flatten nested optionals for now)
    let all_optionals = collect_all_optional_blocks(&info.pattern.optional_blocks);
    let num_optionals = all_optionals.len();
    
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

    // Calculate total patterns including all optionals
    let total_patterns: usize = info.pattern.patterns.len() 
        + all_optionals.iter().map(|o| o.patterns.len()).sum::<usize>();

    // Metadata for the base circuit
    let mut all_patterns: Vec<serde_json::Value> = info.pattern.patterns.iter()
        .map(contextualized_pattern_to_json)
        .collect();
    for opt in &all_optionals {
        all_patterns.extend(opt.patterns.iter().map(contextualized_pattern_to_json));
    }

    let metadata = serde_json::json!({
        "variables": info.variables,
        "skip_signing": options.skip_signing,
        "inputPatterns": all_patterns,
        "optionalPatterns": all_optionals.iter().map(|o| {
            serde_json::json!({
                "id": o.id,
                "patterns": o.patterns.iter().map(contextualized_pattern_to_json).collect::<Vec<_>>()
            })
        }).collect::<Vec<_>>(),
        "unionBranches": info.pattern.union_branches.as_ref().map(|bs| {
            bs.iter().map(|b| b.patterns.iter().map(contextualized_pattern_to_json).collect::<Vec<_>>()).collect::<Vec<_>>()
        }).unwrap_or_default(),
        "hiddenInputs": base_hidden.clone(),
        "input_patterns": all_patterns,
        "optional_patterns": all_optionals.iter().map(|o| {
            serde_json::json!({
                "id": o.id,
                "patterns": o.patterns.iter().map(contextualized_pattern_to_json).collect::<Vec<_>>()
            })
        }).collect::<Vec<_>>(),
        "union_branches": info.pattern.union_branches.as_ref().map(|bs| {
            bs.iter().map(|b| b.patterns.iter().map(contextualized_pattern_to_json).collect::<Vec<_>>()).collect::<Vec<_>>()
        }).unwrap_or_default(),
        "hidden_inputs": base_hidden.clone(),
        "num_optionals": num_optionals,
        "total_patterns": total_patterns,
    });

    // Generate additional circuits for other optional combinations (if any optionals exist)
    let mut optional_circuits = Vec::new();
    
    if num_optionals > 0 {
        // Generate circuits for all 2^n combinations except the "all matched" case
        // (which is the base circuit)
        let num_combinations = 1 << num_optionals; // 2^n
        
        for combo in 0..(num_combinations - 1) {
            // combo represents which optionals are matched (as a bit mask)
            let matched_indices: Vec<usize> = (0..num_optionals)
                .filter(|i| (combo >> i) & 1 == 1)
                .collect();
            
            let (circuit_sparql_nr, circuit_hidden, _, _) = generate_circuit_for_optional_combination(
                &info,
                &all_optionals,
                &matched_indices,
                &options,
            )?;
            
            // Compute filtered variables for this combination
            // Variables that only appear in unmatched optionals should be excluded
            let mut optional_only_vars: std::collections::HashSet<String> = std::collections::HashSet::new();
            for (idx, opt) in all_optionals.iter().enumerate() {
                if !matched_indices.contains(&idx) {
                    for b in &opt.bindings {
                        optional_only_vars.insert(b.variable.clone());
                    }
                }
            }
            for b in &info.pattern.bindings {
                optional_only_vars.remove(&b.variable);
            }
            for &idx in &matched_indices {
                if idx < all_optionals.len() {
                    for b in &all_optionals[idx].bindings {
                        optional_only_vars.remove(&b.variable);
                    }
                }
            }
            let combo_variables: Vec<String> = info.variables.iter()
                .filter(|v| !optional_only_vars.contains(*v))
                .cloned()
                .collect();
            
            // Calculate patterns for this combination
            let mut combo_patterns: Vec<serde_json::Value> = info.pattern.patterns.iter()
                .map(contextualized_pattern_to_json)
                .collect();
            for idx in &matched_indices {
                combo_patterns.extend(all_optionals[*idx].patterns.iter().map(contextualized_pattern_to_json));
            }
            
            let circuit_metadata = serde_json::json!({
                "variables": combo_variables,
                "skip_signing": options.skip_signing,
                "inputPatterns": combo_patterns,
                "matchedOptionals": matched_indices,
                "hiddenInputs": circuit_hidden,
            });
            
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

// =============================================================================
// WASM BINDINGS
// =============================================================================

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn transform(query: &str) -> String {
    transform_with_options(query, false)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn transform_with_options(query: &str, skip_signing: bool) -> String {
    let options = TransformOptions { skip_signing };
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
