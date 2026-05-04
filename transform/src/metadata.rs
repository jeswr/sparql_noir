//! JSON metadata serialisation.
//!
//! Translates the IR (`ContextualizedTriple`, `GraphContext`, plus
//! spargebra terms) into the JSON shape consumed by the TypeScript side.
//! Pure presentation: no algebra-level decisions live here.

use spargebra::term::{GroundTerm, NamedNodePattern, TermPattern};

use crate::{
    Aggregate, ContextualizedTriple, GraphContext, OptionalBlock, OrderDirection, OrderKey,
    QueryInfo,
};

fn aggregate_to_json(agg: &Aggregate) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert("kind".into(), serde_json::Value::String(agg.kind.metadata_tag().into()));
    obj.insert("output".into(), serde_json::Value::String(agg.output.clone()));
    if let Some(src) = &agg.source {
        obj.insert("source".into(), serde_json::Value::String(src.clone()));
    } else {
        obj.insert("source".into(), serde_json::Value::Null);
    }
    serde_json::Value::Object(obj)
}

fn order_key_to_json(key: &OrderKey) -> serde_json::Value {
    serde_json::json!({
        "variable": key.variable,
        "direction": match key.direction {
            OrderDirection::Asc => "asc",
            OrderDirection::Desc => "desc",
        },
    })
}

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

    let aggregates_json: Vec<serde_json::Value> =
        info.aggregates.iter().map(aggregate_to_json).collect();
    let order_by_json: Vec<serde_json::Value> =
        info.order_by.iter().map(order_key_to_json).collect();

    // Per-constraint metadata for NOT EXISTS / MINUS lowering. The TS
    // prover uses `bracketLeftIdx` / `bracketRightIdx` to locate the
    // bracket BGP slots and reads `boundaryCaseDispatch` (one map per
    // NOT EXISTS constraint) to translate the public
    // `boundary_cases[i]` integer back to the chosen primitive name
    // (`lower` / `middle` / `upper`). The actual boundary tag is a
    // *prove-time* fact -- the prover computes
    // `cmp(absent_hash, sorted_real_leaf_hashes)` and picks the
    // matching tag. See `spec/exists.md` Sec.3.3.
    let not_exists_json: Vec<serde_json::Value> = info
        .pattern
        .not_exists
        .iter()
        .map(|ne| {
            serde_json::json!({
                "bracketLeftIdx": ne.bracket_left_idx,
                "bracketRightIdx": ne.bracket_right_idx,
                "bracket_left_idx": ne.bracket_left_idx,
                "bracket_right_idx": ne.bracket_right_idx,
                // Tag → primitive mapping. Prover supplies the
                // matching tag at proof time as the public
                // `boundary_cases[i]` input.
                "boundaryCaseDispatch": {
                    "0": "lower",
                    "1": "middle",
                    "2": "upper",
                },
            })
        })
        .collect();

    // Easy-case OPTIONAL collapse metadata (round-3 follow-up — see
    // `spec/exists.md` §4.1; round-5 prefix-3 extension --
    // `spec/prefix-tree-commitment.md` Sec.8). One entry per collapsed
    // OPTIONAL, exposing the matched-arm slot and the two bracket
    // slots so the verifier (and the prover-side glue in `ts.js`)
    // knows where to place witnesses for each arm. `prefixKind` is
    // null for round-3 collapses (brackets index `bgp`) and
    // `"prefix3_sp_g"` for round-5 prefix-3 collapses (brackets index
    // `bgp_prefix3`).
    let easy_optionals_json: Vec<serde_json::Value> = info
        .pattern
        .easy_optionals
        .iter()
        .map(|eo| {
            let prefix_kind = eo
                .prefix_kind
                .map(|k| serde_json::Value::String(k.metadata_tag().to_string()))
                .unwrap_or(serde_json::Value::Null);
            serde_json::json!({
                "id": eo.id,
                "matchedIdx": eo.matched_idx,
                "matched_idx": eo.matched_idx,
                "bracketLeftIdx": eo.bracket_left_idx,
                "bracketRightIdx": eo.bracket_right_idx,
                "bracket_left_idx": eo.bracket_left_idx,
                "bracket_right_idx": eo.bracket_right_idx,
                "prefixKind": prefix_kind.clone(),
                "prefix_kind": prefix_kind,
            })
        })
        .collect();

    // Round-5 prefix-3 NOT EXISTS metadata. Same shape as the
    // round-3 `notExists` entries but bracket indices reference the
    // `bgp_prefix3` slot array (not `bgp`) and `prefixKind` records
    // which prefix subset is in use. The TS prover uses
    // `boundary_cases_prefix3[i]` to pick between the lower / middle /
    // upper dispatch arms.
    let prefix_not_exists_json: Vec<serde_json::Value> = info
        .pattern
        .prefix_not_exists
        .iter()
        .map(|pne| {
            serde_json::json!({
                "prefixKind": pne.prefix_kind.metadata_tag(),
                "prefix_kind": pne.prefix_kind.metadata_tag(),
                "bracketLeftIdx": pne.bracket_left_idx,
                "bracketRightIdx": pne.bracket_right_idx,
                "bracket_left_idx": pne.bracket_left_idx,
                "bracket_right_idx": pne.bracket_right_idx,
                "boundaryCaseDispatch": {
                    "0": "lower",
                    "1": "middle",
                    "2": "upper",
                },
            })
        })
        .collect();

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
        "aggregates": aggregates_json,
        "orderBy": order_by_json,
        "order_by": order_by_json,
        "limit": info.limit,
        "offset": info.offset,
        "notExists": not_exists_json,
        "not_exists": not_exists_json,
        "prefixNotExists": prefix_not_exists_json,
        "prefix_not_exists": prefix_not_exists_json,
        "bgpPrefix3Length": info.pattern.bgp_prefix3_len,
        "bgp_prefix3_length": info.pattern.bgp_prefix3_len,
        "easyOptionals": easy_optionals_json,
        "easy_optionals": easy_optionals_json,
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

    let aggregates_json: Vec<serde_json::Value> =
        info.aggregates.iter().map(aggregate_to_json).collect();
    let order_by_json: Vec<serde_json::Value> =
        info.order_by.iter().map(order_key_to_json).collect();

    serde_json::json!({
        "variables": combo_variables,
        "skip_signing": skip_signing,
        "inputPatterns": combo_patterns,
        "matchedOptionals": matched_indices,
        "hiddenInputs": circuit_hidden,
        "aggregates": aggregates_json,
        "orderBy": order_by_json,
        "order_by": order_by_json,
        "limit": info.limit,
        "offset": info.offset,
    })
}
