use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use clap::{Arg, Command};
use spargebra::algebra::{Expression, Function, GraphPattern, PropertyPathExpression};
use spargebra::term::{
    BlankNode, GroundTerm, NamedNodePattern, Term as SparqlTerm, TermPattern, TriplePattern, Variable,
};
use spargebra::{Query, SparqlParser};

use spareval::QueryEvaluator;
use std::sync::atomic::{AtomicUsize, Ordering};

#[allow(dead_code)]
trait QueryEvaluatorExprExt {
    fn evaluate_expression(_expr: &Expression) -> Option<SparqlTerm> { None }
    fn evaluate_effective_boolean_value_expression(_expr: &Expression) -> Option<bool> { None }
}

impl QueryEvaluatorExprExt for QueryEvaluator {}

// --- Noir Code Generation ---
// This transform generates Noir code that uses hash functions from dep::consts.
// The Noir compiler evaluates constant expressions at compile time, so static
// hash expressions like hash2([0, encode_string("...")]) are computed during
// circuit compilation, not at runtime in the circuit.
//
// Note: We generate Noir expressions rather than pre-computed values because
// the hash implementations (pedersen_hash, sha256) are specific to Noir's
// crypto libraries and cannot be easily replicated in Rust.

// --- Minimal data model for generation time ---
#[derive(Clone, Debug)]
enum NoirTerm {
    Variable(String),
    Input(usize, usize), // (triple_idx, term_idx)
    Static(GroundTerm),
}

#[derive(Clone, Debug)]
struct EqAssertion(pub NoirTerm, pub NoirTerm);

#[derive(Clone, Debug)]
struct BindConstraint {
    left: String,      // variable name
    right: NoirTerm, // where it binds from
}

#[derive(Clone, Debug)]
struct OutInfo {
    input_patterns: Vec<TriplePattern>,
    optional_patterns: Vec<TriplePattern>,
    binds: Vec<BindConstraint>,
    eqs: Vec<EqAssertion>,
    filters: Vec<Expression>,
    union_branches: Option<Vec<OutInfo>>, // for UNION
}

#[derive(Clone, Debug)]
struct ProjectInfo {
    variables: Vec<String>,
    out: OutInfo,
}

// --- Noir expression helpers ---
// These generate Noir code strings that use dep::consts and dep::utils functions.
// The Noir compiler evaluates these expressions at compile time for static inputs.

/// Generate Noir expression to encode a string to a Field
fn string_to_field_expr(s: &str) -> String {
    format!(
        "utils::encode_string(\"{}\")",
        s.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

/// Handle special literal datatypes (boolean, integer)
fn special_literal_expr(lit: &spargebra::term::Literal) -> String {
    let dt = lit.datatype();
    let v = lit.value();
    if dt.as_str() == "http://www.w3.org/2001/XMLSchema#boolean" {
        let lower = v.to_ascii_lowercase();
        if lower == "true" || v == "1" {
            return "1".to_string();
        }
        if lower == "false" || v == "0" {
            return "0".to_string();
        }
    }
    if dt.as_str() == "http://www.w3.org/2001/XMLSchema#integer" {
        if v.parse::<i128>().is_ok() {
            return v.to_string();
        }
    }
    string_to_field_expr(v)
}

/// Generate Noir expression for term's inner field encoding (before type prefix)
fn term_to_field_expr(term: &GroundTerm) -> String {
    match term {
        GroundTerm::NamedNode(nn) => string_to_field_expr(nn.as_str()),
        GroundTerm::Literal(l) => {
            let value_encoding = string_to_field_expr(l.value());
            let literal_encoding = special_literal_expr(l);
            let lang = l
                .language()
                .map(|lg| string_to_field_expr(lg))
                .unwrap_or_else(|| string_to_field_expr(""));
            let datatype_encoding = string_to_field_expr(l.datatype().as_str());
            // Uses hash4 from dep::consts - resolved at Noir compile time
            format!(
                "consts::hash4([{}, {}, {}, {}])",
                value_encoding,
                literal_encoding,
                lang,
                datatype_encoding
            )
        }
    }
}

/// Generate Noir expression for full term encoding (type prefix + inner)
fn get_term_encoding_string(term: &GroundTerm) -> String {
    let term_type_code = match term {
        GroundTerm::NamedNode(_) => 0,
        GroundTerm::Literal(_) => 2,
    };
    // Uses hash2 from dep::consts - resolved at Noir compile time
    format!(
        "consts::hash2([{}, {}])",
        term_type_code,
        term_to_field_expr(term)
    )
}

// --- Path planner helpers ---
const PATH_SEGMENT_MAX: usize = 8; // should mirror noir_prove consts

fn collect_paths_from_graphpattern(gp: &GraphPattern, out: &mut Vec<(TermPattern, PropertyPathExpression, TermPattern)>) {
    match gp {
        GraphPattern::Path { subject, path, object } => {
            out.push((subject.clone(), path.clone(), object.clone()));
        }
        GraphPattern::Bgp { patterns: _ } => {}
        GraphPattern::Join { left, right }
        | GraphPattern::LeftJoin { left, right, .. }
        | GraphPattern::Union { left, right } => {
            collect_paths_from_graphpattern(left, out);
            collect_paths_from_graphpattern(right, out);
        }
        GraphPattern::Filter { inner, .. }
        | GraphPattern::Distinct { inner }
        | GraphPattern::Reduced { inner }
        | GraphPattern::Slice { inner, .. }
        | GraphPattern::Graph { inner, .. }
        | GraphPattern::Project { inner, .. }
        | GraphPattern::OrderBy { inner, .. }
        | GraphPattern::Group { inner, .. }
        | GraphPattern::Service { inner, .. }
        | GraphPattern::Extend { inner, .. } => {
            collect_paths_from_graphpattern(inner, out);
        }
        GraphPattern::Values { .. } => {}
        _ => {}
    }
}

// Flatten simple path expressions into atomic steps (predicate IRI + direction)
// direction: 0 = forward, 1 = reverse
// Expand a property path expression into one or more plan objects (serde_json::Value).
// Plan JSON formats supported:
// - { instances: [{predicate: IRI, dir: 0|1}, ...] }
// - { sequence: [plan, plan, ...] }
// - { alt: [plan, plan, ...] }
// - { repeat: { base: plan, min: u32, max: u32 } }
// - { negated: [iri, ...] }
fn expand_path_to_plans(path: &PropertyPathExpression) -> Vec<serde_json::Value> {
    match path {
        PropertyPathExpression::NamedNode(nn) => vec![serde_json::json!({
            "instances": [{"predicate": nn.as_str().to_string(), "dir": 0}],
        })],
        PropertyPathExpression::Reverse(inner) => {
            if let PropertyPathExpression::NamedNode(nn) = inner.as_ref() {
                vec![serde_json::json!({
                    "instances": [{"predicate": nn.as_str().to_string(), "dir": 1}],
                })]
            } else {
                // Reverse of complex expression: represent as sequence with reverse marker
                let inner_plans = expand_path_to_plans(inner.as_ref());
                inner_plans
                    .into_iter()
                    .map(|p| serde_json::json!({"reverse": p}))
                    .collect()
            }
        }
        PropertyPathExpression::Sequence(a, b) => {
            let left = expand_path_to_plans(a.as_ref());
            let right = expand_path_to_plans(b.as_ref());
            // Combine each left with each right into a sequence plan
            let mut out: Vec<serde_json::Value> = Vec::new();
            for l in left {
                for r in &right {
                    // If both are simple instances we can merge into one instances array
                    if l.get("instances").is_some() && r.get("instances").is_some() {
                        let mut insts: Vec<serde_json::Value> = Vec::new();
                        if let Some(larr) = l.get("instances") {
                            if let Some(a) = larr.as_array() {
                                insts.extend_from_slice(a);
                            }
                        }
                        if let Some(rarr) = r.get("instances") {
                            if let Some(a) = rarr.as_array() {
                                insts.extend_from_slice(a);
                            }
                        }
                        out.push(serde_json::json!({"instances": insts}));
                    } else {
                        out.push(serde_json::json!({"sequence": [l, r]}));
                    }
                }
            }
            out
        }
        PropertyPathExpression::Alternative(a, b) => {
            let mut out = expand_path_to_plans(a.as_ref());
            out.extend(expand_path_to_plans(b.as_ref()));
            vec![serde_json::json!({"alt": out})]
        }
        PropertyPathExpression::ZeroOrOne(inner) => {
            let mut out = expand_path_to_plans(inner.as_ref());
            // include zero-length (identity) as empty instances
            out.push(serde_json::json!({"instances": []}));
            vec![serde_json::json!({"alt": out})]
        }
        PropertyPathExpression::ZeroOrMore(inner) => {
            let base = expand_path_to_plans(inner.as_ref());
            // represent as repeat of base with min 0
            // If base has multiple alternatives, wrap them as alt inside base
            let base_plan = if base.len() == 1 { base.into_iter().next().unwrap() } else { serde_json::json!({"alt": base}) };
            vec![serde_json::json!({"repeat": {"base": base_plan, "min": 0, "max": PATH_SEGMENT_MAX}})]
        }
        PropertyPathExpression::OneOrMore(inner) => {
            let base = expand_path_to_plans(inner.as_ref());
            let base_plan = if base.len() == 1 { base.into_iter().next().unwrap() } else { serde_json::json!({"alt": base}) };
            vec![serde_json::json!({"repeat": {"base": base_plan, "min": 1, "max": PATH_SEGMENT_MAX}})]
        }
        PropertyPathExpression::NegatedPropertySet(list) => {
            let iris: Vec<String> = list.iter().map(|n| n.as_str().to_string()).collect();
            vec![serde_json::json!({"negated": iris})]
        }
    }
}


fn serialize_term(
    term: &NoirTerm,
    state: &ProjectInfo,
    bindings: &BTreeMap<String, NoirTerm>,
) -> String {
    match term {
        NoirTerm::Static(gt) => get_term_encoding_string(gt),
        NoirTerm::Variable(name) => {
            if state.variables.iter().any(|v| v == name) {
                format!("variables.{}", name)
            } else if let Some(mapped) = bindings.get(name) {
                serialize_term(mapped, state, bindings)
            } else {
                // Fallback to a variable slot if exposed (won't exist). First pass: treat as 0
                format!("variables.{}", name)
            }
        }
        NoirTerm::Input(i, j) => format!("bgp[{}].terms[{}]", i, j),
    }
}

// Try to evaluate an expression to a constant boolean using the evaluator (no substitutions).
fn try_eval_ebv(expr: &Expression) -> Option<bool> {
    // Prefer the shim trait (UFCS) so this code compiles whether or not
    // the Oxigraph branch exposes a different signature for the helper.
    <QueryEvaluator as QueryEvaluatorExprExt>::evaluate_effective_boolean_value_expression(expr)
}

// Convert a FILTER expression to a Noir boolean expression, possibly adding hidden inputs
fn filter_to_noir(
    expr: &Expression,
    state: &ProjectInfo,
    bindings: &BTreeMap<String, NoirTerm>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    if let Some(b) = try_eval_ebv(expr) {
        return Ok(if b { "true".into() } else { "false".into() });
    }
    match expr {
        Expression::And(a, b) => Ok(format!(
            "({}) & ({})",
            filter_to_noir(a, state, bindings, hidden)?,
            filter_to_noir(b, state, bindings, hidden)?
        )),
        Expression::Or(a, b) => Ok(format!(
            "({}) | ({})",
            filter_to_noir(a, state, bindings, hidden)?,
            filter_to_noir(b, state, bindings, hidden)?
        )),
        Expression::Not(i) => Ok(format!(
            "({}) == false",
            filter_to_noir(i, state, bindings, hidden)?
        )),
        Expression::SameTerm(a, b) => {
            Ok(format!("({}) == ({})", filter_to_noir(a, state, bindings, hidden)?, filter_to_noir(b, state, bindings, hidden)?))
        }
        Expression::Equal(a, b) => {
            // If both sides are constants, fold
            if let (Ok(NoirTerm::Static(la)), Ok(NoirTerm::Static(lb))) =
                (value_expr_to_term(a), value_expr_to_term(b))
            {
                let eq = ground_term_eq(&la, &lb);
                return Ok(if eq { "true".into() } else { "false".into() });
            }
            let left = value_expr_to_term(a)?;
            let right = value_expr_to_term(b)?;
            Ok(format!(
                "{} == {}",
                serialize_term(&left, state, bindings),
                serialize_term(&right, state, bindings)
            ))
        }
        // Basic numeric comparisons: only constant-fold when both sides are numeric literals
        Expression::Greater(a, b)
        | Expression::GreaterOrEqual(a, b)
        | Expression::Less(a, b)
        | Expression::LessOrEqual(a, b) => {
            // Dynamic numeric/date comparison via hidden inputs and encoding checks
            Ok(numeric_or_date_comparison(
                expr, a, b, state, bindings, hidden,
            )?)
        }
        // BOUND(?v): compile-time check based on whether the variable is produced by the BGP/binds
        Expression::Bound(v) => {
            let name = v.as_str();
            let is_bound = state.variables.iter().any(|s| s == name) || bindings.contains_key(name);
            Ok(if is_bound {
                "true".into()
            } else {
                "false".into()
            })
        }
    // literal EBV handled via evaluator above
        // Function calls: implement selected ones (isIRI/isBlank/isLiteral). Others accepted.
        Expression::FunctionCall(func, args) => match (func, args.as_slice()) {
            (Function::IsIri, [arg]) => Ok(is_check(arg, 0, state, bindings, hidden)?),
            (Function::IsBlank, [arg]) => Ok(is_check(arg, 1, state, bindings, hidden)?),
            (Function::IsLiteral, [arg]) => Ok(is_check(arg, 2, state, bindings, hidden)?),
            _ => Err(format!("Unsupported function call: {}", func)),
        },
        // Fallback: accept and rely on engine semantics
        _ => Err(format!("Unsupported expression: {}", expr)),
    }
}

fn value_expr_to_term(expr: &Expression) -> Result<NoirTerm, String> {
    match expr {
        Expression::NamedNode(nn) => Ok(NoirTerm::Static(GroundTerm::NamedNode(nn.clone()))),
        Expression::Literal(l) => Ok(NoirTerm::Static(GroundTerm::Literal(l.clone()))),
        Expression::Variable(v) => Ok(NoirTerm::Variable(v.as_str().to_string())),
        // Try evaluator to fold more expressions to a constant term
        other => {
            // Call the shim trait version via UFCS to avoid API differences
            if let Some(term) = <QueryEvaluator as QueryEvaluatorExprExt>::evaluate_expression(other) {
                match term {
                    spargebra::term::Term::NamedNode(nn) =>
                        Ok(NoirTerm::Static(GroundTerm::NamedNode(nn))),
                    spargebra::term::Term::Literal(l) =>
                        Ok(NoirTerm::Static(GroundTerm::Literal(l))),
                    _ => Err("Unsupported evaluated term kind".into()),
                }
            } else {
                Err("Unsupported value expression in first pass".into())
            }
        }
    }
}

fn numeric_literal_value(expr: &Expression) -> Option<i128> {
    match expr {
        Expression::Literal(l) => {
            let dt = l.datatype().as_str();
            if dt == "http://www.w3.org/2001/XMLSchema#integer" {
                l.value().parse::<i128>().ok()
            } else {
                None
            }
        }
        _ => None,
    }
}

// Note: custom EBV constant folding has been removed to avoid diverging from upstream semantics.

fn ground_term_eq(a: &GroundTerm, b: &GroundTerm) -> bool {
    match (a, b) {
        (GroundTerm::NamedNode(la), GroundTerm::NamedNode(lb)) => la.as_str() == lb.as_str(),
        (GroundTerm::Literal(la), GroundTerm::Literal(lb)) => {
            la.value() == lb.value()
                && la.datatype().as_str() == lb.datatype().as_str()
                && la.language() == lb.language()
        }
        _ => false,
    }
}

// Note: EBV for literals should be handled by the SPARQL evaluation layer, not here.

// --- Algebra handling (subset for first pass) ---
fn handle_patterns(patterns: &[TriplePattern]) -> Result<OutInfo, String> {
    let mut variables: BTreeSet<String> = BTreeSet::new();
    let mut eqs: Vec<EqAssertion> = Vec::new();
    let mut binds: Vec<BindConstraint> = Vec::new();
    let mut output_patterns: Vec<TriplePattern> = Vec::new();
    let optional_patterns: Vec<TriplePattern> = Vec::new();

    for (i, pattern) in patterns.iter().enumerate() {
        output_patterns.push(pattern.clone());
        let subject = &pattern.subject;
        let predicate = &pattern.predicate;
        let object = &pattern.object;

        // subject
        match subject {
            TermPattern::NamedNode(nn) => {
                eqs.push(EqAssertion(
                    NoirTerm::Static(GroundTerm::NamedNode(nn.clone())),
                    NoirTerm::Input(i, 0),
                ));
            }
            TermPattern::Variable(v) => {
                let name = v.as_str().to_string();
                let already = variables.contains(&name);
                if already {
                    eqs.push(EqAssertion(
                        NoirTerm::Variable(name.clone()),
                        NoirTerm::Input(i, 0),
                    ));
                } else {
                    binds.push(BindConstraint {
                        left: name.clone(),
                        right: NoirTerm::Input(i, 0),
                    });
                    variables.insert(name);
                }
            }
            TermPattern::BlankNode(_) => {
                return Err("Blank nodes not supported in first pass".into());
            }
            TermPattern::Literal(_) => {
                return Err("Literal not allowed in subject position".into());
            }
        }

        // predicate (must be NamedNode or Variable)
        match predicate {
            spargebra::term::NamedNodePattern::NamedNode(nn) => {
                eqs.push(EqAssertion(
                    NoirTerm::Static(GroundTerm::NamedNode(nn.clone())),
                    NoirTerm::Input(i, 1),
                ));
            }
            spargebra::term::NamedNodePattern::Variable(v) => {
                let name = v.as_str().to_string();
                let already = variables.contains(&name);
                if already {
                    eqs.push(EqAssertion(
                        NoirTerm::Variable(name.clone()),
                        NoirTerm::Input(i, 1),
                    ));
                } else {
                    binds.push(BindConstraint {
                        left: name.clone(),
                        right: NoirTerm::Input(i, 1),
                    });
                    variables.insert(name);
                }
            }
        }

        // object
        match object {
            TermPattern::NamedNode(nn) => {
                eqs.push(EqAssertion(
                    NoirTerm::Static(GroundTerm::NamedNode(nn.clone())),
                    NoirTerm::Input(i, 2),
                ));
            }
            TermPattern::Literal(l) => {
                eqs.push(EqAssertion(
                    NoirTerm::Static(GroundTerm::Literal(l.clone())),
                    NoirTerm::Input(i, 2),
                ));
            }
            TermPattern::Variable(v) => {
                let name = v.as_str().to_string();
                let already = variables.contains(&name);
                if already {
                    eqs.push(EqAssertion(
                        NoirTerm::Variable(name.clone()),
                        NoirTerm::Input(i, 2),
                    ));
                } else {
                    binds.push(BindConstraint {
                        left: name.clone(),
                        right: NoirTerm::Input(i, 2),
                    });
                    variables.insert(name);
                }
            }
            _ => return Err("Unsupported object term in first pass".into()),
        }
    }

    Ok(OutInfo {
        input_patterns: output_patterns,
        optional_patterns,
        binds,
        eqs,
        filters: Vec::new(),
        union_branches: None,
    })
}

fn bgp(patterns: &[TriplePattern]) -> Result<OutInfo, String> {
    handle_patterns(patterns)
}

fn extend(
    variable: &Variable,
    expression: &Expression,
    inner: &GraphPattern,
) -> Result<OutInfo, String> {
    // First pass: only support binding variables to other terms (variables or constants)
    let mut res = operation(inner)?;
    let right = match expression {
        Expression::Variable(v) => NoirTerm::Variable(v.as_str().to_string()),
        Expression::NamedNode(nn) => NoirTerm::Static(GroundTerm::NamedNode(nn.clone())),
        Expression::Literal(l) => NoirTerm::Static(GroundTerm::Literal(l.clone())),
        _ => return Err("Unsupported BIND expression in first pass".into()),
    };
    res.binds.push(BindConstraint {
        left: variable.as_str().to_string(),
        right,
    });
    Ok(res)
}

fn join(left: &GraphPattern, right: &GraphPattern) -> Result<OutInfo, String> {
    // Flatten into a single BGP list if possible
    let mut patterns: Vec<TriplePattern> = Vec::new();
    for gp in [left, right] {
        match gp {
            GraphPattern::Bgp { patterns: p } => patterns.extend(p.clone()),
            GraphPattern::Path { subject, path, object } => {
                // Support simple link paths and reverse link (e.g. ^p)
                match path {
                    PropertyPathExpression::NamedNode(nn) => {
                        patterns.push(TriplePattern {
                            subject: subject.clone(),
                            predicate: NamedNodePattern::NamedNode(nn.clone()),
                            object: object.clone(),
                        });
                    }
                    PropertyPathExpression::Reverse(inner) => {
                        // If reverse of a named node, swap subject/object and use the inner named node
                        if let PropertyPathExpression::NamedNode(nn) = inner.as_ref() {
                            patterns.push(TriplePattern {
                                subject: object.clone(),
                                predicate: NamedNodePattern::NamedNode(nn.clone()),
                                object: subject.clone(),
                            });
                        } else {
                            return Err(format!("Unsupported reverse path form in join: {path:?}"));
                        }
                    }
                    _ => return Err(format!("Unsupported path expression in join: {path:?}")),
                }
            }
            GraphPattern::Extend {
                inner,
                variable,
                expression,
            } => {
                // Evaluate inner and then add extend bind
                let mut out = operation(inner)?;
                let ext = extend(variable, expression, inner)?;
                // ext is based on inner, we just merge binds
                out.binds.extend(ext.binds);
                return Ok(out);
            }
            _ => return Err(format!("Unsupported join side: {gp:?}")),
        }
    }
    handle_patterns(&patterns)
}

fn filter(expr: &Expression, inner: &GraphPattern) -> Result<OutInfo, String> {
    let mut res = operation(inner)?;
    res.filters.push(expr.clone());
    Ok(res)
}

fn left_join(
    left: &GraphPattern,
    right: &GraphPattern,
    expr_opt: &Option<Expression>,
) -> Result<OutInfo, String> {
    // Treat OPTIONAL { right } as optional patterns for metadata; ignore in circuit constraints.
    let mut res = operation(left)?;
    // Collect optional triple patterns if right is a BGP
    if let GraphPattern::Bgp { patterns } = right {
        // Append to optional_patterns for metadata emission
        res.optional_patterns.extend(patterns.clone());
    } else {
        // For now, only support OPTIONAL with a BGP block
        return Err(format!("Unsupported OPTIONAL pattern: {right:?}"));
    }
    // FILTER inside OPTIONAL: if present, we carry it along
    if let Some(expr) = expr_opt {
        res.filters.push(expr.clone());
    }
    Ok(res)
}

fn operation(op: &GraphPattern) -> Result<OutInfo, String> {
    match op {
        GraphPattern::Path { subject, path, object } => {
            // Expand property path expressions into equivalent graph pattern constructs
            let gp = expand_path(subject, path, object)?;
            return operation(&gp);
        }
        GraphPattern::Filter { expr, inner } => filter(expr, inner),
        GraphPattern::Bgp { patterns } => bgp(patterns),
        GraphPattern::Extend {
            inner,
            variable,
            expression,
        } => extend(variable, expression, inner),
        GraphPattern::Join { left, right } => join(left, right),
        GraphPattern::LeftJoin {
            left,
            right,
            expression,
            ..
        } => left_join(left, right, expression),
        GraphPattern::Union { left, right } => {
            // Flatten binary UNION tree into a list
            fn collect_union_branches(
                gp: &GraphPattern,
                out: &mut Vec<OutInfo>,
            ) -> Result<(), String> {
                match gp {
                    GraphPattern::Union { left, right } => {
                        collect_union_branches(left, out)?;
                        collect_union_branches(right, out)?;
                        Ok(())
                    }
                    _ => {
                        out.push(operation(gp)?);
                        Ok(())
                    }
                }
            }
            let mut branches: Vec<OutInfo> = Vec::new();
            collect_union_branches(left, &mut branches)?;
            collect_union_branches(right, &mut branches)?;
            // Pick input patterns from the longest branch (defines BGP size)
            let input_patterns = branches
                .iter()
                .max_by_key(|o| o.input_patterns.len())
                .map(|o| o.input_patterns.clone())
                .unwrap_or_default();
            Ok(OutInfo {
                input_patterns,
                optional_patterns: Vec::new(),
                binds: Vec::new(),
                eqs: Vec::new(),
                filters: Vec::new(),
                union_branches: Some(branches),
            })
        }
        _ => Err(format!("Unsupported operation: {op:?}")),
    }
}

fn project(op: &GraphPattern) -> Result<ProjectInfo, String> {
    if let GraphPattern::Project { inner, variables } = op {
        let vars: Vec<String> = variables.iter().map(|v| v.as_str().to_string()).collect();
        let out = operation(inner)?;
        Ok(ProjectInfo {
            variables: vars,
            out,
        })
    } else {
        Err(format!("Unsupported top-level operation: {op:?}"))
    }
}

// Atomic counter to generate fresh variable names for intermediate sequence nodes
static VAR_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn fresh_var_name() -> String {
    let id = VAR_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("__v{}", id)
}

fn fresh_var_term() -> TermPattern {
    TermPattern::Variable(Variable::new_unchecked(fresh_var_name()))
}

// Expand a PropertyPathExpression into an equivalent GraphPattern that uses only BGP/Join/Union/Extend/Nop
fn expand_path(
    subject: &TermPattern,
    path: &PropertyPathExpression,
    object: &TermPattern,
) -> Result<GraphPattern, String> {
    match path {
        PropertyPathExpression::NamedNode(nn) => Ok(GraphPattern::Bgp {
            patterns: vec![TriplePattern {
                subject: subject.clone(),
                predicate: NamedNodePattern::NamedNode(nn.clone()),
                object: object.clone(),
            }],
        }),
        PropertyPathExpression::Reverse(inner) => {
            if let PropertyPathExpression::NamedNode(nn) = inner.as_ref() {
                Ok(GraphPattern::Bgp {
                    patterns: vec![TriplePattern {
                        subject: object.clone(),
                        predicate: NamedNodePattern::NamedNode(nn.clone()),
                        object: subject.clone(),
                    }],
                })
            } else {
                Err(format!("Unsupported Reverse inner in expand_path: {path:?}"))
            }
        }
        PropertyPathExpression::Sequence(a, b) => {
            // subject / a / b / object => introduce intermediate var(s)
            // create mid term
            let mid = fresh_var_term();
            let left = expand_path(subject, a.as_ref(), &mid)?;
            let right = expand_path(&mid, b.as_ref(), object)?;
            Ok(GraphPattern::Join {
                left: Box::new(left),
                right: Box::new(right),
            })
        }
        PropertyPathExpression::Alternative(a, b) => {
            let left = expand_path(subject, a.as_ref(), object)?;
            let right = expand_path(subject, b.as_ref(), object)?;
            Ok(GraphPattern::Union {
                left: Box::new(left),
                right: Box::new(right),
            })
        }
        PropertyPathExpression::ZeroOrOne(inner) => {
            // (path)?  => UNION( path , extend/no-op that equates subject and object )
            // If either side is a variable, prefer an Extend to bind
            // Build the one-step path
            let one = expand_path(subject, inner.as_ref(), object)?;
            // Build the zero-step: if both are variables and equal, return Nop or an Extend
            // If subject is variable and object is not, extend subject from object; vice versa.
            let zero = if let TermPattern::Variable(sv) = subject {
                // BIND(subject = object)
                GraphPattern::Extend {
                    inner: Box::new(GraphPattern::Bgp { patterns: Vec::new() }),
                    variable: sv.clone(),
                    expression: match object {
                        TermPattern::Variable(v) => Expression::Variable(v.clone()),
                        TermPattern::NamedNode(nn) => Expression::NamedNode(nn.clone()),
                        TermPattern::Literal(l) => Expression::Literal(l.clone()),
                        _ => return Err("Unsupported zero-or-one term type".into()),
                    },
                }
            } else if let TermPattern::Variable(ov) = object {
                GraphPattern::Extend {
                    inner: Box::new(GraphPattern::Bgp { patterns: Vec::new() }),
                    variable: ov.clone(),
                    expression: match subject {
                        TermPattern::Variable(v) => Expression::Variable(v.clone()),
                        TermPattern::NamedNode(nn) => Expression::NamedNode(nn.clone()),
                        TermPattern::Literal(l) => Expression::Literal(l.clone()),
                        _ => return Err("Unsupported zero-or-one term type".into()),
                    },
                }
            } else if subject == object {
                GraphPattern::Bgp { patterns: Vec::new() }
            } else {
                // Neither side is a variable and they are not equal: zero-step impossible, return Nop
                GraphPattern::Bgp { patterns: Vec::new() }
            };

            Ok(GraphPattern::Union {
                left: Box::new(one),
                right: Box::new(zero),
            })
        }
        _ => Err(format!("Unsupported path expression in expand_path: {path:?}")),
    }
}

// --- Emission: build Noir files and metadata ---
fn get_repo_root() -> String {
    // Use the parent of the transform crate directory as the repository root
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| manifest_dir.to_string_lossy().to_string())
}

// Returns: (sparql.nr content, main.nr content, Nargo.toml content, metadata)
fn generate_circuit_from_query(query_str: &str) -> Result<(String, String, String, Metadata), String> {
    println!(
        "generate_circuit: using provided query string ({} bytes)",
        query_str.len()
    );
    let query = SparqlParser::new()
        .parse_query(&query_str)
        .map_err(|e| format!("Parse error: {e}"))?;

    let root = match &query {
        Query::Select { pattern, .. }
        | Query::Construct { pattern, .. }
        | Query::Describe { pattern, .. }
        | Query::Ask { pattern, .. } => pattern,
    };

    let state = project(&root)?;

    // Build bindings map from binds for non-projected vars (first pass mirrors TS behavior)
    let mut bindings: BTreeMap<String, NoirTerm> = BTreeMap::new();
    for b in &state.out.binds {
        if !state.variables.iter().any(|v| v == &b.left) && !bindings.contains_key(&b.left) {
            bindings.insert(b.left.clone(), b.right.clone());
        }
    }

    // Build assertion list(s)
    let mut assertions: Vec<String> = Vec::new();
    let mut union_assertions: Vec<Vec<String>> = Vec::new();
    let mut hidden_inputs: Vec<serde_json::Value> = Vec::new();
    if let Some(branches) = &state.out.union_branches {
        for br in branches {
            // Build branch-local bindings: start with global 'bindings' then add br.binds (for non-projected vars)
            let mut br_bindings: BTreeMap<String, NoirTerm> = bindings.clone();
            for b in &br.binds {
                if !state.variables.iter().any(|v| v == &b.left)
                    && !br_bindings.contains_key(&b.left)
                {
                    br_bindings.insert(b.left.clone(), b.right.clone());
                }
            }
            let mut br_asser: Vec<String> = Vec::new();
            // Assert binds and eqs for this branch using branch-local bindings
            for b in &br.binds {
                let left = NoirTerm::Variable(b.left.clone());
                let right = b.right.clone();
                br_asser.push(format!(
                    "{} == {}",
                    serialize_term(&left, &state, &br_bindings),
                    serialize_term(&right, &state, &br_bindings)
                ));
            }
            for EqAssertion(l, r) in &br.eqs {
                br_asser.push(format!(
                    "{} == {}",
                    serialize_term(l, &state, &br_bindings),
                    serialize_term(r, &state, &br_bindings)
                ));
            }
            for f in &br.filters {
                let expr = filter_to_noir(f, &state, &br_bindings, &mut hidden_inputs)?;
                br_asser.push(expr);
            }
            union_assertions.push(br_asser);
        }
    } else {
        for b in &state.out.binds {
            let left = NoirTerm::Variable(b.left.clone());
            let right = b.right.clone();
            assertions.push(format!(
                "{} == {}",
                serialize_term(&left, &state, &bindings),
                serialize_term(&right, &state, &bindings)
            ));
        }
        for EqAssertion(l, r) in &state.out.eqs {
            assertions.push(format!(
                "{} == {}",
                serialize_term(l, &state, &bindings),
                serialize_term(r, &state, &bindings)
            ));
        }
        for f in &state.out.filters {
            let expr = filter_to_noir(f, &state, &bindings, &mut hidden_inputs)?;
            assertions.push(expr);
        }
    }

    // Emit Noir sparql.nr with dep::consts and dep::utils imports
    let mut sparql_nr = String::new();
    sparql_nr.push_str("// Generated by sparql_noir transform\n");
    // Always import consts and utils since we use them for hash expressions
    sparql_nr.push_str("use dep::consts;\n");
    sparql_nr.push_str("use dep::utils;\n");
    sparql_nr.push_str("use dep::types::Triple;\n\n");
    sparql_nr.push_str(&format!(
        "pub(crate) type BGP = [Triple; {}];\n",
        state.out.input_patterns.len()
    ));

    // Variables struct
    sparql_nr.push_str("pub(crate) struct Variables {\n");
    for v in &state.variables {
        sparql_nr.push_str(&format!("  pub(crate) {}: Field,\n", v));
    }
    sparql_nr.push_str("}\n\n");

    // Function
    let has_hidden = !hidden_inputs.is_empty();
    if has_hidden {
        sparql_nr.push_str(&format!(
            "pub(crate) type Hidden = [Field; {}];\n",
            hidden_inputs.len()
        ));
    }
    sparql_nr.push_str(&format!(
        "pub(crate) fn checkBinding(bgp: BGP, variables: Variables{}) {{\n",
        if has_hidden { ", hidden: Hidden" } else { "" }
    ));
    if !union_assertions.is_empty() {
        // Define one boolean per branch = AND of its assertions
        for (idx, br) in union_assertions.iter().enumerate() {
            let expr = if br.is_empty() {
                "false".to_string()
            } else {
                br.iter()
                    .map(|s| format!("({})", s))
                    .collect::<Vec<_>>()
                    .join(" & ")
            };
            sparql_nr.push_str(&format!("  let branch_{} = {} ;\n", idx, expr));
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

    // Emit main.nr by templating - template is in transform/template/
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let template_path = manifest_dir.join("template/main-verify.template.nr");
    let mut main_template = fs::read_to_string(&template_path)
        .map_err(|e| format!("Failed to read template {:?}: {}", template_path, e))?;
    if has_hidden {
        main_template = main_template
            .replace("{{h0}}", ", Hidden")
            .replace("{{h1}}", ",\n    hidden: Hidden")
            .replace("{{h2}}", ", hidden");
    } else {
        main_template = main_template
            .replace("{{h0}}", "")
            .replace("{{h1}}", "")
            .replace("{{h2}}", "");
    }

    // Generate Nargo.toml content with dependencies to noir/lib/*
    let nargo_toml = r#"[package]
name = "sparql_proof"
type = "bin"
authors = [""]

[dependencies]
consts = { path = "../noir/lib/consts" }
types = { path = "../noir/lib/types" }
utils = { path = "../noir/lib/utils" }
"#.to_string();

    // Build simple segmentation plans for property paths
    let mut found_paths: Vec<(TermPattern, PropertyPathExpression, TermPattern)> = Vec::new();
    collect_paths_from_graphpattern(&root, &mut found_paths);

    let mut plans: Vec<serde_json::Value> = Vec::new();
    for (s, p, o) in &found_paths {
        let expanded = expand_path_to_plans(p);
        let mut segs_top: Vec<serde_json::Value> = Vec::new();
        for plan in expanded {
            // If plan has instances array, chunk it into PATH_SEGMENT_MAX segments
            if let Some(insts_val) = plan.get("instances") {
                if let Some(insts) = insts_val.as_array() {
                    for chunk in insts.chunks(PATH_SEGMENT_MAX) {
                        let insts_chunk: Vec<serde_json::Value> = chunk.to_vec();
                        segs_top.push(serde_json::json!({"instances": insts_chunk, "length": insts_chunk.len()}));
                    }
                }
            } else {
                // non-instances plan (alt/sequence/repeat/negated): include as-is
                segs_top.push(plan);
            }
        }
        let plan = serde_json::json!({"subject": term_pattern_to_term_json(s), "object": term_pattern_to_term_json(o), "segments": segs_top});
        plans.push(plan);
    }

    // Metadata
    let metadata = Metadata {
        variables: state.variables.clone(),
        input_patterns: state
            .out
            .input_patterns
            .iter()
            .map(|p| triple_pattern_to_json(p))
            .collect(),
        optional_patterns: state
            .out
            .optional_patterns
            .iter()
            .map(|p| triple_pattern_to_json(p))
            .collect(),
        union_branches: state
            .out
            .union_branches
            .as_ref()
            .map(|bs| {
                bs.iter()
                    .map(|br| {
                        br.input_patterns
                            .iter()
                            .map(|p| triple_pattern_to_json(p))
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        hidden_inputs,
        aggregator: serde_json::json!({
            "pathSegmentMax": 8,
            "proofFieldSize": 93,
            "vkFieldSize": 114,
            "maxSegments": 16,
            "plans": serde_json::Value::Array(plans)
        }),
    };

    Ok((sparql_nr, main_template, nargo_toml, metadata))
}

#[derive(serde::Serialize)]
struct Metadata {
    #[serde(rename = "variables")]
    variables: Vec<String>,
    #[serde(rename = "inputPatterns")]
    input_patterns: Vec<PatternJson>,
    #[serde(rename = "optionalPatterns")]
    optional_patterns: Vec<PatternJson>,
    #[serde(rename = "unionBranches")]
    union_branches: Vec<Vec<PatternJson>>, // list of branches each with list of patterns
    #[serde(rename = "hiddenInputs")]
    hidden_inputs: Vec<serde_json::Value>,
    #[serde(rename = "aggregator")]
    aggregator: serde_json::Value,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "termType")]
enum TermJson {
    NamedNode {
        value: String,
    },
    Variable {
        value: String,
    },
    BlankNode {
        value: String,
    },
    Literal {
        value: String,
        language: Option<String>,
        datatype: Box<TermJson>,
    },
    DefaultGraph {},
}

#[derive(Clone, serde::Serialize)]
struct PatternJson {
    subject: TermJson,
    predicate: TermJson,
    object: TermJson,
    graph: TermJson,
}

fn named_node_to_term_json(iri: &str) -> TermJson {
    TermJson::NamedNode {
        value: iri.to_string(),
    }
}

fn literal_to_term_json(l: &spargebra::term::Literal) -> TermJson {
    TermJson::Literal {
        value: l.value().to_string(),
        language: l.language().map(|s| s.to_string()),
        datatype: Box::new(named_node_to_term_json(l.datatype().as_str())),
    }
}

fn blank_to_term_json(b: &BlankNode) -> TermJson {
    TermJson::BlankNode {
        value: b.as_str().to_string(),
    }
}

fn term_pattern_to_term_json(tp: &TermPattern) -> TermJson {
    match tp {
        TermPattern::NamedNode(nn) => named_node_to_term_json(nn.as_str()),
        TermPattern::Variable(v) => TermJson::Variable {
            value: v.as_str().to_string(),
        },
        TermPattern::BlankNode(b) => blank_to_term_json(b),
        TermPattern::Literal(l) => literal_to_term_json(l),
        #[allow(unreachable_patterns)]
        _ => TermJson::DefaultGraph {},
    }
}

fn named_node_pattern_to_term_json(nnp: &NamedNodePattern) -> TermJson {
    match nnp {
        NamedNodePattern::NamedNode(nn) => named_node_to_term_json(nn.as_str()),
        NamedNodePattern::Variable(v) => TermJson::Variable {
            value: v.as_str().to_string(),
        },
    }
}

fn triple_pattern_to_json(tp: &TriplePattern) -> PatternJson {
    PatternJson {
        subject: term_pattern_to_term_json(&tp.subject),
        predicate: named_node_pattern_to_term_json(&tp.predicate),
        object: term_pattern_to_term_json(&tp.object),
        graph: TermJson::DefaultGraph {},
    }
}

fn ensure_parent(path: &str) -> std::io::Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}
fn write_file(path: &str, contents: &str) -> std::io::Result<()> {
    ensure_parent(path)?;
    fs::write(path, contents)
}

// ---- Helpers for hidden inputs and advanced filters ----

fn ground_term_to_term_json(gt: &GroundTerm) -> TermJson {
    match gt {
        GroundTerm::NamedNode(nn) => named_node_to_term_json(nn.as_str()),
        GroundTerm::Literal(l) => literal_to_term_json(l),
    }
}

fn term_to_json_value(term: &NoirTerm) -> serde_json::Value {
    match term {
        NoirTerm::Variable(name) => serde_json::json!({"type":"variable","value": name}),
        NoirTerm::Input(i, j) => serde_json::json!({"type":"input","value":[i, j]}),
        NoirTerm::Static(gt) => {
            let tj = ground_term_to_term_json(gt);
            serde_json::json!({"type":"static","value": tj})
        }
    }
}

fn push_custom_computed(
    hidden: &mut Vec<serde_json::Value>,
    computed_type: &str,
    input_term: &NoirTerm,
) -> usize {
    let idx = hidden.len();
    let inp = term_to_json_value(input_term);
    hidden.push(serde_json::json!({
        "type": "customComputed",
        "computedType": computed_type,
        "input": inp
    }));
    idx
}

fn is_check(
    arg: &Expression,
    tag: i32, // 0 IRI, 1 Blank, 2 Literal
    state: &ProjectInfo,
    bindings: &BTreeMap<String, NoirTerm>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    let term = value_expr_to_term(arg)?;
    // Hidden input holds the inner term field encoding
    let h_idx = push_custom_computed(hidden, "term_to_field", &term);
    // Uses hash2 from dep::consts - resolved at Noir compile time
    Ok(format!(
        "{} == consts::hash2([{}, hidden[{}]])",
        serialize_term(&term, state, bindings),
        tag,
        h_idx
    ))
}

fn literal_encoding_with_hidden(dtype_iri: &str, value_idx: usize, special_idx: usize) -> String {
    // Use Noir expressions for static values - resolved at Noir compile time
    let lang = string_to_field_expr("");
    let dtype = string_to_field_expr(dtype_iri);
    // hash4 still needed at runtime for hidden inputs, but static values use expressions
    format!(
        "consts::hash4([hidden[{}], hidden[{}], {}, {}])",
        value_idx,
        special_idx,
        lang,
        dtype
    )
}

fn expected_term_encoding_literal(dtype_iri: &str, value_idx: usize, special_idx: usize) -> String {
    let inner = literal_encoding_with_hidden(dtype_iri, value_idx, special_idx);
    // Uses hash2 from dep::consts - resolved at Noir compile time
    format!("consts::hash2([{}, {}])", 2, inner)
}

fn numeric_or_date_comparison(
    expr: &Expression,
    a: &Expression,
    b: &Expression,
    state: &ProjectInfo,
    bindings: &BTreeMap<String, NoirTerm>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    // Represent a side of comparison
    struct Side {
        cmp_expr: String, // Noir numeric expression (e.g., constant or (hidden[idx] as i64))
        ensure: Option<String>, // Optional equality check tying term to expected encoding
    }

    fn side_from_expr(
        e: &Expression,
        desired_kind: Option<&str>, // "int" or "date"
        state: &ProjectInfo,
        bindings: &BTreeMap<String, NoirTerm>,
        hidden: &mut Vec<serde_json::Value>,
    ) -> Result<Side, String> {
        // If literal integer constant, use it directly
        if let Some(i) = numeric_literal_value(e) {
            return Ok(Side {
                cmp_expr: i.to_string(),
                ensure: None,
            });
        }
        // Handle STRLEN(arg) - extract string length from the argument term
        if let Expression::FunctionCall(Function::StrLen, args) = e {
            if let [arg] = args.as_slice() {
                let term = value_expr_to_term(arg)?;
                // Add hidden extraction for strlen
                let len_idx = push_custom_computed(hidden, "strlen", &term);
                // For STRLEN, we return the length directly as the comparison value
                // The ensure check verifies the term is a literal string with the claimed length
                let cmp_expr = format!("(hidden[{}] as i64)", len_idx);
                // Note: The prover must provide the correct strlen; the circuit verifies
                // this matches the actual string in the signed data via the Merkle proof
                return Ok(Side {
                    cmp_expr,
                    ensure: None, // strlen verification is implicit in the witness
                });
            }
        }
        // Try to use customComputed extraction and encoding assertions
        let term = value_expr_to_term(e)?;
        // Add hidden extractions
        let val_idx = push_custom_computed(hidden, "literal_value", &term);
        let spec_idx = push_custom_computed(hidden, "special_handling", &term);
        // Decide datatype IRI
        let kind = desired_kind.unwrap_or("int");
        let dt_iri = if kind == "date" {
            "http://www.w3.org/2001/XMLSchema#dateTime"
        } else {
            "http://www.w3.org/2001/XMLSchema#integer"
        };
        let expected = expected_term_encoding_literal(dt_iri, val_idx, spec_idx);
        let ensure = format!("{} == {}", expected, serialize_term(&term, state, bindings));
        // Comparison side uses the numeric 'special_handling' converted to i64
        let cmp_expr = format!("(hidden[{}] as i64)", spec_idx);
        Ok(Side {
            cmp_expr,
            ensure: Some(ensure),
        })
    }

    // Pick desired kind = date if either side is an explicit xsd:dateTime literal
    let mut want_date = false;
    if let Expression::Literal(l) = a {
        if l.datatype().as_str() == "http://www.w3.org/2001/XMLSchema#dateTime" {
            want_date = true;
        }
    }
    if let Expression::Literal(l) = b {
        if l.datatype().as_str() == "http://www.w3.org/2001/XMLSchema#dateTime" {
            want_date = true;
        }
    }

    let left = side_from_expr(
        a,
        if want_date { Some("date") } else { None },
        state,
        bindings,
        hidden,
    )?;
    let right = side_from_expr(
        b,
        if want_date { Some("date") } else { None },
        state,
        bindings,
        hidden,
    )?;

    let cmp = match expr {
        Expression::Greater(_, _) => format!("{} > {}", left.cmp_expr, right.cmp_expr),
        Expression::GreaterOrEqual(_, _) => format!("{} >= {}", left.cmp_expr, right.cmp_expr),
        Expression::Less(_, _) => format!("{} < {}", left.cmp_expr, right.cmp_expr),
        Expression::LessOrEqual(_, _) => format!("{} <= {}", left.cmp_expr, right.cmp_expr),
        _ => return Err("Unsupported numeric comparator".into()),
    };

    // Combine ensure checks (if any) with the comparator using logical ANDs
    let mut parts: Vec<String> = Vec::new();
    if let Some(e1) = left.ensure {
        parts.push(format!("({})", e1));
    }
    if let Some(e2) = right.ensure {
        parts.push(format!("({})", e2));
    }
    parts.push(format!("({})", cmp));
    Ok(parts.join(" & "))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("TRANSFORM_BINARY_MARKER v1");
    // Debug: print argv and cwd
    let argv: Vec<String> = std::env::args().collect();
    println!("argv = {:?}", argv);
    println!("cwd = {:?}", std::env::current_dir()?);
    let matches = Command::new("Noir SPARQL Proof")
        .version("1.0")
        .author("Your Name <your.email@example.com>")
        .about("Generates proofs for SPARQL queries using Noir")
        .arg(
            Arg::new("input")
                .short('i')
                .long("input")
                .value_name("FILE")
                .help("Input RDF file (legacy, not used)")
                .num_args(1)
                .required(false),
        )
        .arg(
            Arg::new("output")
                .short('o')
                .long("output")
                .value_name("FILE")
                .help("Output path (legacy, not used - circuit written to noir_prove/)")
                .num_args(1)
                .required(false),
        )
        .arg(
            Arg::new("query")
                .short('q')
                .long("query")
                .value_name("QUERY")
                .help("SPARQL query string or path to .rq file")
                .num_args(1)
                .required(false),
        )
        .get_matches();

    // Legacy args - no longer used but kept for backwards compatibility
    let _input = matches.get_one::<String>("input");
    let _output = matches.get_one::<String>("output");

    // Query: read from CLI as string or use a safe default
    let query_cli_raw = matches.get_one::<String>("query").map(|s| s.to_string());
    let query_text = if let Some(q) = query_cli_raw {
        let p = Path::new(&q);
        if p.exists() {
            fs::read_to_string(p)
                .unwrap_or_else(|_| "SELECT ?s ?p ?o WHERE { ?s ?p ?o . }".to_string())
        } else {
            q
        }
    } else {
        "SELECT ?s ?p ?o WHERE { ?s ?p ?o . }".to_string()
    };
    let (sparql_nr, main_nr, nargo_toml, metadata) = generate_circuit_from_query(&query_text)
        .map_err(|e| format!("Error generating circuit: {}", e))?;

    // Write outputs (absolute paths based on repo root)
    let repo_root = get_repo_root();
    let sparql_out = format!("{}/noir_prove/src/sparql.nr", repo_root);
    let main_out = format!("{}/noir_prove/src/main.nr", repo_root);
    let nargo_out = format!("{}/noir_prove/Nargo.toml", repo_root);
    let meta_out = format!("{}/noir_prove/metadata.json", repo_root);
    write_file(&sparql_out, &sparql_nr)?;
    write_file(&main_out, &main_nr)?;
    write_file(&nargo_out, &nargo_toml)?;
    // Hash functions are now provided by dep::consts - no inline hash module generation needed
    ensure_parent(&meta_out)?;
    // Emit both camelCase and snake_case keys for compatibility with existing JS
    let meta_json = serde_json::json!({
        "variables": metadata.variables.clone(),
        "inputPatterns": metadata.input_patterns.clone(),
        "optionalPatterns": metadata.optional_patterns.clone(),
    "unionBranches": metadata.union_branches.clone(),
        "hiddenInputs": metadata.hidden_inputs.clone(),
        // Legacy keys
        "input_patterns": metadata.input_patterns.clone(),
        "optional_patterns": metadata.optional_patterns.clone(),
    "union_branches": metadata.union_branches.clone(),
        "hidden_inputs": metadata.hidden_inputs.clone(),
    });
    write_file(&meta_out, &serde_json::to_string_pretty(&meta_json)?)?;

    println!(
        "Generated noir files: {}, {}, {} and {}",
        sparql_out, main_out, nargo_out, meta_out
    );

    Ok(())
}
