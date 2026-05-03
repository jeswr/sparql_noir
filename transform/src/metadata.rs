//! JSON metadata serialisation.
//!
//! Translates the IR (`ContextualizedTriple`, `GraphContext`, plus
//! spargebra terms) into the JSON shape consumed by the TypeScript side.
//! Pure presentation: no algebra-level decisions live here.

use spargebra::term::{GroundTerm, NamedNodePattern, TermPattern};

use crate::{ContextualizedTriple, GraphContext};

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
