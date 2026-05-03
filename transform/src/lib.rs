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

use crate::expr::{filter_to_noir, serialize_term};
use crate::lower::{process_query, reset_optional_counter};
use crate::metadata::contextualized_pattern_to_json;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::wasm_bindgen;

use std::collections::BTreeMap;

// Embed the template at compile time for WASM compatibility
const MAIN_TEMPLATE: &str = include_str!("../template/main-verify.template.nr");
const MAIN_TEMPLATE_SIMPLE: &str = include_str!("../template/main-simple.template.nr");

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

/// Recursively collect all optional blocks from a pattern, flattening nested optionals.
fn collect_all_optional_blocks(optionals: &[OptionalBlock]) -> Vec<OptionalBlock> {
    let mut result = Vec::new();
    for opt in optionals {
        // Add this optional
        result.push(OptionalBlock {
            id: opt.id,
            patterns: opt.patterns.clone(),
            bindings: opt.bindings.clone(),
            assertions: opt.assertions.clone(),
            filters: opt.filters.clone(),
            nested_optionals: Vec::new(), // Flatten - don't recurse into children here
        });
        // Recursively collect nested optionals
        result.extend(collect_all_optional_blocks(&opt.nested_optionals));
    }
    result
}

/// Generate the sparql.nr content for a specific optional combination.
/// 
/// This creates a synthetic QueryInfo with the base patterns plus the matched optional patterns,
/// then uses the same code path as the main transform to generate the circuit.
fn generate_circuit_for_optional_combination(
    base_info: &QueryInfo,
    all_optionals: &[OptionalBlock],
    matched_indices: &[usize],
    options: &TransformOptions,
) -> Result<(String, Vec<serde_json::Value>, bool, bool), String> {
    // Build a combined PatternInfo with base + matched optional patterns
    let mut combined = PatternInfo {
        patterns: base_info.pattern.patterns.clone(),
        bindings: base_info.pattern.bindings.clone(),
        assertions: base_info.pattern.assertions.clone(),
        filters: base_info.pattern.filters.clone(),
        union_branches: base_info.pattern.union_branches.clone(),
        optional_blocks: Vec::new(), // Flatten - no nested optionals in the combined version
    };
    
    // Collect variables that only appear in unmatched optionals
    let mut optional_only_vars: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (idx, opt) in all_optionals.iter().enumerate() {
        if !matched_indices.contains(&idx) {
            // This optional is not matched - collect its variables
            for b in &opt.bindings {
                optional_only_vars.insert(b.variable.clone());
            }
        }
    }
    
    // Remove variables that appear in base patterns
    for b in &base_info.pattern.bindings {
        optional_only_vars.remove(&b.variable);
    }
    // Remove variables that appear in matched optionals
    for &idx in matched_indices {
        if idx < all_optionals.len() {
            let opt = &all_optionals[idx];
            for b in &opt.bindings {
                optional_only_vars.remove(&b.variable);
            }
        }
    }
    
    for &idx in matched_indices {
        if idx < all_optionals.len() {
            let opt = &all_optionals[idx];
            combined.patterns.extend(opt.patterns.clone());
            combined.bindings.extend(opt.bindings.clone());
            combined.assertions.extend(opt.assertions.clone());
            combined.filters.extend(opt.filters.clone());
        }
    }
    
    // Filter out variables that only appear in unmatched optionals
    let filtered_variables: Vec<String> = base_info.variables.iter()
        .filter(|v| !optional_only_vars.contains(*v))
        .cloned()
        .collect();
    
    // Create a synthetic QueryInfo for this combination
    let combo_info = QueryInfo {
        variables: filtered_variables,
        pattern: combined,
    };
    
    // Use the same circuit generation logic as the main transform
    generate_sparql_nr_from_query_info(&combo_info, options)
}

/// Generate sparql.nr content from a QueryInfo.
/// This is the core circuit generation logic, extracted to be reusable.
/// Returns (sparql_nr content, hidden inputs, has_hidden, needs_xpath)
fn generate_sparql_nr_from_query_info(
    info: &QueryInfo,
    options: &TransformOptions,
) -> Result<(String, Vec<serde_json::Value>, bool, bool), String> {
    // Build bindings map for non-projected variables
    let mut binding_map: BTreeMap<String, Term> = BTreeMap::new();
    for b in &info.pattern.bindings {
        if !info.variables.contains(&b.variable) && !binding_map.contains_key(&b.variable) {
            binding_map.insert(b.variable.clone(), b.term.clone());
        }
    }

    // Generate assertions
    let mut assertions: Vec<String> = Vec::new();
    let mut union_assertions: Vec<Vec<String>> = Vec::new();
    let mut hidden: Vec<serde_json::Value> = Vec::new();

    if let Some(branches) = &info.pattern.union_branches {
        for branch in branches {
            let mut branch_bindings = binding_map.clone();
            for b in &branch.bindings {
                if !info.variables.contains(&b.variable) && !branch_bindings.contains_key(&b.variable) {
                    branch_bindings.insert(b.variable.clone(), b.term.clone());
                }
            }

            let mut branch_asserts: Vec<String> = Vec::new();

            for b in &branch.bindings {
                let left = Term::Variable(b.variable.clone());
                branch_asserts.push(format!(
                    "{} == {}",
                    serialize_term(&left, info, &branch_bindings),
                    serialize_term(&b.term, info, &branch_bindings)
                ));
            }

            for Assertion(l, r) in &branch.assertions {
                branch_asserts.push(format!(
                    "{} == {}",
                    serialize_term(l, info, &branch_bindings),
                    serialize_term(r, info, &branch_bindings)
                ));
            }

            for f in &branch.filters {
                let expr = filter_to_noir(f, info, &branch_bindings, &mut hidden)?;
                branch_asserts.push(expr);
            }

            union_assertions.push(branch_asserts);
        }
    } else {
        for b in &info.pattern.bindings {
            let left = Term::Variable(b.variable.clone());
            assertions.push(format!(
                "{} == {}",
                serialize_term(&left, info, &binding_map),
                serialize_term(&b.term, info, &binding_map)
            ));
        }

        for Assertion(l, r) in &info.pattern.assertions {
            assertions.push(format!(
                "{} == {}",
                serialize_term(l, info, &binding_map),
                serialize_term(r, info, &binding_map)
            ));
        }

        for f in &info.pattern.filters {
            let expr = filter_to_noir(f, info, &binding_map, &mut hidden)?;
            assertions.push(expr);
        }
    }

    // Generate sparql.nr
    let mut sparql_nr = String::new();
    sparql_nr.push_str("// Generated by sparql_noir transform\n");
    sparql_nr.push_str("use dep::consts;\n");
    if options.skip_signing {
        sparql_nr.push_str("use super::Triple;\n");
    } else {
        sparql_nr.push_str("use dep::utils;\n");
        sparql_nr.push_str("use dep::types::Triple;\n");
    }
    
    // Check if EBV is used by looking for ebv_value/ebv_datatype in hidden inputs
    let needs_ebv = hidden.iter().any(|h| {
        h.get("computedType").and_then(|v| v.as_str())
            .map(|t| t == "ebv_value" || t == "ebv_datatype")
            .unwrap_or(false)
    });
    if needs_ebv {
        sparql_nr.push_str("use dep::ebv;\n");
    }
    
    // Check if xpath functions are used in any assertions
    let needs_xpath = assertions.iter().any(|a| a.contains("xpath::")) ||
        union_assertions.iter().any(|branch| branch.iter().any(|a| a.contains("xpath::")));
    if needs_xpath {
        sparql_nr.push_str("use dep::xpath;\n");
    }
    
    sparql_nr.push_str("\n");
    sparql_nr.push_str(&format!(
        "pub(crate) type BGP = [Triple; {}];\n",
        info.pattern.patterns.len()
    ));

    sparql_nr.push_str("pub(crate) struct Variables {\n");
    for v in &info.variables {
        sparql_nr.push_str(&format!("  pub(crate) {}: Field,\n", v));
    }
    sparql_nr.push_str("}\n\n");

    let has_hidden = !hidden.is_empty();
    if has_hidden {
        sparql_nr.push_str(&format!(
            "pub(crate) type Hidden = [Field; {}];\n",
            hidden.len()
        ));
    }

    sparql_nr.push_str(&format!(
        "pub(crate) fn checkBinding(bgp: BGP, variables: Variables{}) {{\n",
        if has_hidden { ", hidden: Hidden" } else { "" }
    ));

    if !union_assertions.is_empty() {
        for (idx, branch) in union_assertions.iter().enumerate() {
            let expr = if branch.is_empty() {
                "false".to_string()
            } else {
                branch.iter().map(|s| format!("({})", s)).collect::<Vec<_>>().join(" & ")
            };
            sparql_nr.push_str(&format!("  let branch_{} = {};\n", idx, expr));
        }
        let ors = (0..union_assertions.len())
            .map(|i| format!("branch_{}", i))
            .collect::<Vec<_>>()
            .join(" | ");
        sparql_nr.push_str(&format!("  assert({});\n", ors));
    } else {
        for a in &assertions {
            sparql_nr.push_str(&format!("  assert({});\n", a));
        }
    }
    sparql_nr.push_str("}\n");

    Ok((sparql_nr, hidden, has_hidden, needs_xpath))
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
    
    // Generate the base circuit (no optionals or all optionals matched based on strategy)
    // We'll generate the "all optionals matched" case as the primary circuit
    let (base_sparql_nr, base_hidden, has_hidden, needs_xpath) = generate_circuit_for_optional_combination(
        &info,
        &all_optionals,
        &(0..num_optionals).collect::<Vec<_>>(), // All optionals matched
        &options,
    )?;

    // Generate main.nr from embedded template
    let template = if options.skip_signing { MAIN_TEMPLATE_SIMPLE } else { MAIN_TEMPLATE };
    let mut main_nr = template.to_string();
    if has_hidden {
        main_nr = main_nr
            .replace("{{h0}}", ", Hidden")
            .replace("{{h1}}", ",\n    hidden: Hidden")
            .replace("{{h2}}", ", hidden");
    } else {
        main_nr = main_nr
            .replace("{{h0}}", "")
            .replace("{{h1}}", "")
            .replace("{{h2}}", "");
    }

    // Nargo.toml - different dependencies when skip_signing is enabled
    // Check if EBV is used by looking for ebv_value/ebv_datatype in hidden inputs
    let needs_ebv = base_hidden.iter().any(|h| {
        h.get("computedType").and_then(|v| v.as_str())
            .map(|t| t == "ebv_value" || t == "ebv_datatype")
            .unwrap_or(false)
    });
    
    let nargo_toml = if options.skip_signing {
        let mut toml = r#"[package]
name = "sparql_proof"
type = "bin"
authors = [""]

[dependencies]
consts = { path = "../noir/lib/consts" }
"#.to_string();
        if needs_ebv {
            toml.push_str("ebv = { path = \"../noir/lib/ebv\" }\n");
        }
        if needs_xpath {
            toml.push_str("xpath = { path = \"../noir/lib/xpath\" }\n");
        }
        toml
    } else {
        let mut toml = r#"[package]
name = "sparql_proof"
type = "bin"
authors = [""]

[dependencies]
consts = { path = "../noir/lib/consts" }
types = { path = "../noir/lib/types" }
utils = { path = "../noir/lib/utils" }
"#.to_string();
        if needs_ebv {
            toml.push_str("ebv = { path = \"../noir/lib/ebv\" }\n");
        }
        if needs_xpath {
            toml.push_str("xpath = { path = \"../noir/lib/xpath\" }\n");
        }
        toml
    };

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
