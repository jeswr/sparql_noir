//! JSON metadata serialisation.
//!
//! Translates the IR (`ContextualizedTriple`, `GraphContext`, plus
//! spargebra terms) into the JSON shape consumed by the TypeScript side.
//! Pure presentation: no algebra-level decisions live here.

use spargebra::term::{GroundTerm, NamedNodePattern, TermPattern};

use crate::{ContextualizedTriple, GraphContext, OptionalBlock, QueryInfo};

pub(crate) fn ground_term_to_json(gt: &GroundTerm) -> serde_json::Value {
    match gt {
        GroundTerm::NamedNode(nn) => serde_json::json!({
            "termType": "NamedNode",
            "value": nn.as_str()
        }),
        GroundTerm::Literal(l) => serde_json::json!({
            "termType": "Literal",
            "value": l.value(),
            "language": l.language(),
            "datatype": {
                "termType": "NamedNode",
                "value": l.datatype().as_str()
            }
        }),
    }
}

pub(crate) fn term_pattern_to_json(tp: &TermPattern) -> serde_json::Value {
    match tp {
        TermPattern::NamedNode(nn) => serde_json::json!({
            "termType": "NamedNode",
            "value": nn.as_str()
        }),
        TermPattern::Variable(v) => serde_json::json!({
            "termType": "Variable",
            "value": v.as_str()
        }),
        TermPattern::BlankNode(b) => serde_json::json!({
            "termType": "BlankNode",
            "value": b.as_str()
        }),
        TermPattern::Literal(l) => serde_json::json!({
            "termType": "Literal",
            "value": l.value(),
            "language": l.language(),
            "datatype": {
                "termType": "NamedNode",
                "value": l.datatype().as_str()
            }
        }),
        #[allow(unreachable_patterns)]
        _ => serde_json::json!({"termType": "DefaultGraph"}),
    }
}

pub(crate) fn named_node_pattern_to_json(nnp: &NamedNodePattern) -> serde_json::Value {
    match nnp {
        NamedNodePattern::NamedNode(nn) => serde_json::json!({
            "termType": "NamedNode",
            "value": nn.as_str()
        }),
        NamedNodePattern::Variable(v) => serde_json::json!({
            "termType": "Variable",
            "value": v.as_str()
        }),
    }
}

pub(crate) fn contextualized_pattern_to_json(ct: &ContextualizedTriple) -> serde_json::Value {
    let graph = match &ct.graph {
        GraphContext::Default => serde_json::json!({"termType": "DefaultGraph"}),
        GraphContext::NamedNode(iri) => serde_json::json!({"termType": "NamedNode", "value": iri}),
        GraphContext::Variable(name) => serde_json::json!({"termType": "Variable", "value": name}),
    };
    serde_json::json!({
        "subject": term_pattern_to_json(&ct.pattern.subject),
        "predicate": named_node_pattern_to_json(&ct.pattern.predicate),
        "object": term_pattern_to_json(&ct.pattern.object),
        "graph": graph
    })
}

/// Build the base-circuit metadata document. The TypeScript side has
/// historically read both camelCase and snake_case spellings of every
/// field, so each key is emitted twice; do not normalise without
/// auditing the JS consumers first.
pub(crate) fn build_base_metadata(
    info: &QueryInfo,
    all_optionals: &[OptionalBlock],
    skip_signing: bool,
    base_hidden: &[serde_json::Value],
) -> serde_json::Value {
    let total_patterns: usize = info.pattern.patterns.len()
        + all_optionals.iter().map(|o| o.patterns.len()).sum::<usize>();

    let mut all_patterns: Vec<serde_json::Value> = info
        .pattern
        .patterns
        .iter()
        .map(contextualized_pattern_to_json)
        .collect();
    for opt in all_optionals {
        all_patterns.extend(opt.patterns.iter().map(contextualized_pattern_to_json));
    }

    let optional_patterns_json: Vec<serde_json::Value> = all_optionals
        .iter()
        .map(|o| {
            serde_json::json!({
                "id": o.id,
                "patterns": o.patterns.iter().map(contextualized_pattern_to_json).collect::<Vec<_>>()
            })
        })
        .collect();

    let union_branches_json: Vec<Vec<serde_json::Value>> = info
        .pattern
        .union_branches
        .as_ref()
        .map(|bs| {
            bs.iter()
                .map(|b| {
                    b.patterns
                        .iter()
                        .map(contextualized_pattern_to_json)
                        .collect::<Vec<_>>()
                })
                .collect()
        })
        .unwrap_or_default();

    serde_json::json!({
        "variables": info.variables,
        "skip_signing": skip_signing,
        "inputPatterns": all_patterns,
        "optionalPatterns": optional_patterns_json,
        "unionBranches": union_branches_json,
        "hiddenInputs": base_hidden,
        "input_patterns": all_patterns,
        "optional_patterns": optional_patterns_json,
        "union_branches": union_branches_json,
        "hidden_inputs": base_hidden,
        "num_optionals": all_optionals.len(),
        "total_patterns": total_patterns,
    })
}

/// Build the per-variant metadata for a single OPTIONAL combination.
pub(crate) fn build_variant_metadata(
    info: &QueryInfo,
    all_optionals: &[OptionalBlock],
    matched_indices: &[usize],
    skip_signing: bool,
    circuit_hidden: &[serde_json::Value],
) -> serde_json::Value {
    let mut optional_only_vars: std::collections::HashSet<String> =
        std::collections::HashSet::new();
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
    for &idx in matched_indices {
        if idx < all_optionals.len() {
            for b in &all_optionals[idx].bindings {
                optional_only_vars.remove(&b.variable);
            }
        }
    }
    let combo_variables: Vec<String> = info
        .variables
        .iter()
        .filter(|v| !optional_only_vars.contains(*v))
        .cloned()
        .collect();

    let mut combo_patterns: Vec<serde_json::Value> = info
        .pattern
        .patterns
        .iter()
        .map(contextualized_pattern_to_json)
        .collect();
    for idx in matched_indices {
        combo_patterns.extend(
            all_optionals[*idx]
                .patterns
                .iter()
                .map(contextualized_pattern_to_json),
        );
    }

    serde_json::json!({
        "variables": combo_variables,
        "skip_signing": skip_signing,
        "inputPatterns": combo_patterns,
        "matchedOptionals": matched_indices,
        "hiddenInputs": circuit_hidden,
    })
}
