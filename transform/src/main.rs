//! SPARQL to Noir Circuit Transformer
//!
//! This tool parses a SPARQL SELECT query and generates Noir circuit code
//! that verifies the query results without revealing the underlying data.
//!
//! # Architecture
//!
//! 1. Parse SPARQL query using spargebra
//! 2. Extract triple patterns, bindings, and filters
//! 3. Generate Noir assertions that verify:
//!    - Variable bindings match between patterns
//!    - Static terms match expected encodings
//!    - Filter conditions are satisfied
//!
//! # Output Files
//!
//! - `sparql.nr`: Query-specific constraint checking function
//! - `main.nr`: Entry point with signature verification
//! - `Nargo.toml`: Package manifest with dependencies
//! - `metadata.json`: Pattern information for the prover

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use clap::{Arg, Command};
use spargebra::algebra::{Expression, Function, GraphPattern, PropertyPathExpression};
use spargebra::term::{GroundTerm, NamedNodePattern, TermPattern, TriplePattern, Variable};
use spargebra::{Query, SparqlParser};

use std::sync::atomic::{AtomicUsize, Ordering};

// =============================================================================
// DATA TYPES
// =============================================================================

/// Represents a term in the generated Noir circuit.
/// This is the intermediate representation between SPARQL terms and Noir code.
#[derive(Clone, Debug)]
enum Term {
    /// A SPARQL variable (e.g., ?x)
    Variable(String),
    /// A reference to a BGP triple input: bgp[triple_idx].terms[term_idx]
    Input(usize, usize),
    /// A static ground term (IRI or literal)
    Static(GroundTerm),
}

/// An equality assertion between two terms.
/// Generated when patterns require terms to match.
#[derive(Clone, Debug)]
struct Assertion(Term, Term);

/// A variable binding constraint.
/// Records that a variable should be bound to a specific term.
#[derive(Clone, Debug)]
struct Binding {
    variable: String,
    term: Term,
}

/// Collected information from processing a graph pattern.
#[derive(Clone, Debug)]
struct PatternInfo {
    /// Triple patterns that must be provided as BGP inputs
    patterns: Vec<TriplePattern>,
    /// Variable bindings discovered during pattern processing
    bindings: Vec<Binding>,
    /// Equality assertions between terms
    assertions: Vec<Assertion>,
    /// FILTER expressions to be converted to Noir
    filters: Vec<Expression>,
    /// For UNION: alternative branches (each with its own PatternInfo)
    union_branches: Option<Vec<PatternInfo>>,
}

impl PatternInfo {
    fn new() -> Self {
        Self {
            patterns: Vec::new(),
            bindings: Vec::new(),
            assertions: Vec::new(),
            filters: Vec::new(),
            union_branches: None,
        }
    }
}

/// Top-level query information including projected variables.
#[derive(Clone, Debug)]
struct QueryInfo {
    /// Variables projected in the SELECT clause
    variables: Vec<String>,
    /// Pattern information from the WHERE clause
    pattern: PatternInfo,
}

// =============================================================================
// NOIR CODE GENERATION HELPERS
// =============================================================================

/// Generate Noir expression to encode a string as a Field.
/// Uses utils::encode_string from the Noir library.
fn encode_string_expr(s: &str) -> String {
    format!(
        "utils::encode_string(\"{}\")",
        s.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

/// Generate Noir expression for a literal's value encoding.
/// Handles special cases for boolean and integer datatypes.
fn literal_value_expr(lit: &spargebra::term::Literal) -> String {
    let datatype = lit.datatype().as_str();
    let value = lit.value();

    // Boolean literals: encode as 0 or 1
    if datatype == "http://www.w3.org/2001/XMLSchema#boolean" {
        let lower = value.to_ascii_lowercase();
        if lower == "true" || value == "1" {
            return "1".to_string();
        }
        if lower == "false" || value == "0" {
            return "0".to_string();
        }
    }

    // Integer literals: use numeric value directly
    if datatype == "http://www.w3.org/2001/XMLSchema#integer" {
        if value.parse::<i128>().is_ok() {
            return value.to_string();
        }
    }

    // Default: encode as string
    encode_string_expr(value)
}

/// Generate Noir expression for the inner field encoding of a term.
/// This is the value before the type prefix is applied.
fn term_inner_expr(term: &GroundTerm) -> String {
    match term {
        GroundTerm::NamedNode(nn) => encode_string_expr(nn.as_str()),
        GroundTerm::Literal(lit) => {
            let value = encode_string_expr(lit.value());
            let special = literal_value_expr(lit);
            let lang = lit
                .language()
                .map(|l| encode_string_expr(l))
                .unwrap_or_else(|| encode_string_expr(""));
            let datatype = encode_string_expr(lit.datatype().as_str());
            format!(
                "consts::hash4([{}, {}, {}, {}])",
                value, special, lang, datatype
            )
        }
    }
}

/// Generate Noir expression for the full term encoding.
/// Format: hash2([type_code, inner_encoding])
fn term_encoding_expr(term: &GroundTerm) -> String {
    let type_code = match term {
        GroundTerm::NamedNode(_) => 0,
        GroundTerm::Literal(_) => 2,
    };
    format!("consts::hash2([{}, {}])", type_code, term_inner_expr(term))
}

// =============================================================================
// TERM SERIALIZATION
// =============================================================================

/// Serialize a Term to a Noir expression string.
fn serialize_term(term: &Term, query: &QueryInfo, bindings: &BTreeMap<String, Term>) -> String {
    match term {
        Term::Static(gt) => term_encoding_expr(gt),
        Term::Variable(name) => {
            // If projected, reference the variables struct
            if query.variables.iter().any(|v| v == name) {
                format!("variables.{}", name)
            } else if let Some(bound) = bindings.get(name) {
                // If bound to another term, follow the binding
                serialize_term(bound, query, bindings)
            } else {
                // Fallback (should not happen in valid queries)
                format!("variables.{}", name)
            }
        }
        Term::Input(i, j) => format!("bgp[{}].terms[{}]", i, j),
    }
}

// =============================================================================
// EXPRESSION CONVERSION
// =============================================================================

/// Convert a SPARQL expression to a Term.
fn expr_to_term(expr: &Expression) -> Result<Term, String> {
    match expr {
        Expression::NamedNode(nn) => Ok(Term::Static(GroundTerm::NamedNode(nn.clone()))),
        Expression::Literal(l) => Ok(Term::Static(GroundTerm::Literal(l.clone()))),
        Expression::Variable(v) => Ok(Term::Variable(v.as_str().to_string())),
        _ => Err(format!("Unsupported expression type: {:?}", expr)),
    }
}

/// Check if two ground terms are equal (for constant folding).
fn ground_terms_equal(a: &GroundTerm, b: &GroundTerm) -> bool {
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

// =============================================================================
// COMPARISON TYPE DETECTION
// =============================================================================

/// XSD namespace prefix for datatype IRIs.
const XSD: &str = "http://www.w3.org/2001/XMLSchema#";

/// Comparison types supported by SPARQL 1.1.
#[derive(Debug, Clone, PartialEq)]
enum ComparisonType {
    Numeric,   // xsd:integer, xsd:decimal, xsd:float, xsd:double
    String,    // xsd:string, simple literal (no type/lang), plain literal with lang
    Boolean,   // xsd:boolean
    DateTime,  // xsd:dateTime
    Unknown,   // Cannot be determined at compile time
}

// =============================================================================
// IEEE 754 SPECIAL VALUE HANDLING
// =============================================================================

/// IEEE 754 special values for float/double comparison.
#[derive(Debug, Clone, Copy, PartialEq)]
enum FloatSpecial {
    NaN,           // Not-a-Number
    PositiveInf,   // +INF
    NegativeInf,   // -INF
    PositiveZero,  // +0.0
    NegativeZero,  // -0.0
    Normal(i128),  // Scaled fixed-point value for normal numbers
}

/// Detect IEEE 754 special values from a literal value string.
/// Returns None if the literal is not a float/double type.
fn detect_float_special(literal: &spargebra::term::Literal) -> Option<FloatSpecial> {
    let dt = literal.datatype().as_str();
    // Only handle float and double types for IEEE 754 special values
    if dt != format!("{}float", XSD) && dt != format!("{}double", XSD) {
        return None;
    }
    
    let val = literal.value().trim();
    
    // Check for NaN (case-insensitive per XML Schema)
    if val.eq_ignore_ascii_case("nan") {
        return Some(FloatSpecial::NaN);
    }
    
    // Check for INF (case-insensitive per XML Schema)
    if val.eq_ignore_ascii_case("inf") || val.eq_ignore_ascii_case("+inf") || val.eq_ignore_ascii_case("infinity") {
        return Some(FloatSpecial::PositiveInf);
    }
    if val.eq_ignore_ascii_case("-inf") || val.eq_ignore_ascii_case("-infinity") {
        return Some(FloatSpecial::NegativeInf);
    }
    
    // Try to parse as f64
    if let Ok(f) = val.parse::<f64>() {
        // Check for NaN (handles edge cases like parsing produces NaN)
        if f.is_nan() {
            return Some(FloatSpecial::NaN);
        }
        
        // Check for infinities
        if f.is_infinite() {
            return Some(if f.is_sign_positive() {
                FloatSpecial::PositiveInf
            } else {
                FloatSpecial::NegativeInf
            });
        }
        
        // Check for signed zeros (-0.0 vs +0.0)
        // Use 1.0/f to distinguish: 1.0/+0.0 = +INF, 1.0/-0.0 = -INF
        if f == 0.0 {
            return Some(if f.is_sign_positive() {
                FloatSpecial::PositiveZero
            } else {
                FloatSpecial::NegativeZero
            });
        }
        
        // Normal number - scale to fixed-point (1e18 scale factor)
        let scaled = (f * 1e18) as i128;
        return Some(FloatSpecial::Normal(scaled));
    }
    
    None
}

/// IEEE 754 comparison for op:numeric-less-than.
/// Returns None if result is undefined, Some(true/false) otherwise.
/// Per IEEE 754-2008: if either operand is NaN, return false.
fn ieee754_less_than(a: FloatSpecial, b: FloatSpecial) -> Option<bool> {
    use FloatSpecial::*;
    
    // If either operand is NaN, comparison returns false
    if matches!(a, NaN) || matches!(b, NaN) {
        return Some(false);
    }
    
    Some(match (a, b) {
        // -INF < everything except -INF
        (NegativeInf, NegativeInf) => false,
        (NegativeInf, _) => true,
        (_, NegativeInf) => false,
        
        // +INF > everything except +INF  
        (PositiveInf, _) => false,
        (_, PositiveInf) => true,
        
        // Zero comparisons: +0 == -0, so neither is less than the other
        (PositiveZero, NegativeZero) | (NegativeZero, PositiveZero) => false,
        (PositiveZero, PositiveZero) | (NegativeZero, NegativeZero) => false,
        
        // Zero vs normal numbers
        (PositiveZero, Normal(n)) | (NegativeZero, Normal(n)) => 0 < n,
        (Normal(n), PositiveZero) | (Normal(n), NegativeZero) => n < 0,
        
        // Normal number comparisons
        (Normal(x), Normal(y)) => x < y,
        
        // NaN cases already handled above
        (NaN, _) | (_, NaN) => unreachable!(),
    })
}

/// IEEE 754 comparison for op:numeric-equal.
/// Per IEEE 754-2008: NaN != NaN, +0 == -0.
fn ieee754_equal(a: FloatSpecial, b: FloatSpecial) -> Option<bool> {
    use FloatSpecial::*;
    
    // NaN is not equal to anything, including itself
    if matches!(a, NaN) || matches!(b, NaN) {
        return Some(false);
    }
    
    Some(match (a, b) {
        // Infinities equal to themselves
        (PositiveInf, PositiveInf) => true,
        (NegativeInf, NegativeInf) => true,
        (PositiveInf, _) | (_, PositiveInf) => false,
        (NegativeInf, _) | (_, NegativeInf) => false,
        
        // +0 == -0 per IEEE 754
        (PositiveZero, NegativeZero) | (NegativeZero, PositiveZero) => true,
        (PositiveZero, PositiveZero) | (NegativeZero, NegativeZero) => true,
        
        // Zero vs normal
        (PositiveZero, Normal(n)) | (NegativeZero, Normal(n)) |
        (Normal(n), PositiveZero) | (Normal(n), NegativeZero) => n == 0,
        
        // Normal numbers
        (Normal(x), Normal(y)) => x == y,
        
        // NaN already handled
        (NaN, _) | (_, NaN) => unreachable!(),
    })
}

/// Detect the comparison type from a literal's datatype IRI.
fn datatype_to_comparison_type(datatype: &str) -> ComparisonType {
    match datatype {
        s if s == format!("{}integer", XSD) => ComparisonType::Numeric,
        s if s == format!("{}decimal", XSD) => ComparisonType::Numeric,
        s if s == format!("{}float", XSD) => ComparisonType::Numeric,
        s if s == format!("{}double", XSD) => ComparisonType::Numeric,
        s if s == format!("{}string", XSD) => ComparisonType::String,
        s if s == format!("{}boolean", XSD) => ComparisonType::Boolean,
        s if s == format!("{}dateTime", XSD) => ComparisonType::DateTime,
        _ => ComparisonType::Unknown,
    }
}

/// Detect comparison type from an expression.
fn expr_comparison_type(expr: &Expression) -> ComparisonType {
    match expr {
        Expression::Literal(l) => {
            // Simple literals (no datatype, default to xsd:string)
            let dt = l.datatype().as_str();
            if dt == format!("{}string", XSD) || l.language().is_some() {
                return ComparisonType::String;
            }
            datatype_to_comparison_type(dt)
        }
        // For variables, we can't determine type at compile time
        Expression::Variable(_) => ComparisonType::Unknown,
        // STRLEN returns integer
        Expression::FunctionCall(Function::StrLen, _) => ComparisonType::Numeric,
        _ => ComparisonType::Unknown,
    }
}

/// Determine comparison type from two operands (SPARQL type promotion).
fn determine_comparison_type(a: &Expression, b: &Expression) -> ComparisonType {
    let type_a = expr_comparison_type(a);
    let type_b = expr_comparison_type(b);

    // If both are known and same, use that type
    if type_a == type_b && type_a != ComparisonType::Unknown {
        return type_a;
    }

    // If one is known and other unknown, use the known type
    if type_a != ComparisonType::Unknown && type_b == ComparisonType::Unknown {
        return type_a;
    }
    if type_b != ComparisonType::Unknown && type_a == ComparisonType::Unknown {
        return type_b;
    }

    // Both numeric types promote to numeric
    if type_a == ComparisonType::Numeric || type_b == ComparisonType::Numeric {
        return ComparisonType::Numeric;
    }

    // Default to numeric for backward compatibility
    ComparisonType::Numeric
}

/// Convert a FILTER expression to a Noir boolean expression.
fn filter_to_noir(
    expr: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    match expr {
        // Logical operators
        Expression::And(a, b) => Ok(format!(
            "({}) & ({})",
            filter_to_noir(a, query, bindings, hidden)?,
            filter_to_noir(b, query, bindings, hidden)?
        )),
        Expression::Or(a, b) => Ok(format!(
            "({}) | ({})",
            filter_to_noir(a, query, bindings, hidden)?,
            filter_to_noir(b, query, bindings, hidden)?
        )),
        Expression::Not(inner) => Ok(format!(
            "({}) == false",
            filter_to_noir(inner, query, bindings, hidden)?
        )),

        // Term comparison
        Expression::SameTerm(a, b) => Ok(format!(
            "({}) == ({})",
            filter_to_noir(a, query, bindings, hidden)?,
            filter_to_noir(b, query, bindings, hidden)?
        )),
        Expression::Equal(a, b) => {
            // IEEE 754 handling for float/double: NaN != NaN, +0 == -0
            if let (Expression::Literal(lit_a), Expression::Literal(lit_b)) = (a.as_ref(), b.as_ref()) {
                let special_a = detect_float_special(lit_a);
                let special_b = detect_float_special(lit_b);
                
                // If both are float/double, apply IEEE 754 equality rules
                if let (Some(fa), Some(fb)) = (special_a, special_b) {
                    if let Some(result) = ieee754_equal(fa, fb) {
                        return Ok(if result { "true" } else { "false" }.into());
                    }
                }
                
                // If one is NaN, equality is always false
                if matches!(special_a, Some(FloatSpecial::NaN)) || 
                   matches!(special_b, Some(FloatSpecial::NaN)) {
                    return Ok("false".into());
                }
            }
            
            // Constant folding: if both sides are static, evaluate at compile time
            if let (Ok(Term::Static(la)), Ok(Term::Static(lb))) = (expr_to_term(a), expr_to_term(b))
            {
                return Ok(if ground_terms_equal(&la, &lb) {
                    "true"
                } else {
                    "false"
                }
                .into());
            }
            let left = expr_to_term(a)?;
            let right = expr_to_term(b)?;
            Ok(format!(
                "{} == {}",
                serialize_term(&left, query, bindings),
                serialize_term(&right, query, bindings)
            ))
        }

        // Ordered comparisons - dispatch based on operand types
        Expression::Greater(a, b)
        | Expression::GreaterOrEqual(a, b)
        | Expression::Less(a, b)
        | Expression::LessOrEqual(a, b) => {
            let cmp_type = determine_comparison_type(a, b);
            match cmp_type {
                ComparisonType::Numeric => numeric_comparison(expr, a, b, query, bindings, hidden),
                ComparisonType::String => string_comparison(expr, a, b, query, bindings, hidden),
                ComparisonType::Boolean => boolean_comparison(expr, a, b, query, bindings, hidden),
                ComparisonType::DateTime => datetime_comparison(expr, a, b, query, bindings, hidden),
                ComparisonType::Unknown => {
                    // Default to numeric for backward compatibility
                    numeric_comparison(expr, a, b, query, bindings, hidden)
                }
            }
        }

        // IN operator: checks if value is in a list
        Expression::In(value, list) => {
            if list.is_empty() {
                return Ok("false".into());
            }
            // Generate disjunction: (value == list[0]) | (value == list[1]) | ...
            let val_term = expr_to_term(value)?;
            let val_serialized = serialize_term(&val_term, query, bindings);
            let checks: Vec<String> = list
                .iter()
                .filter_map(|item| {
                    let item_term = expr_to_term(item).ok()?;
                    Some(format!(
                        "({} == {})",
                        val_serialized,
                        serialize_term(&item_term, query, bindings)
                    ))
                })
                .collect();
            if checks.is_empty() {
                return Ok("false".into());
            }
            Ok(checks.join(" | "))
        }

        // BOUND check
        Expression::Bound(v) => {
            let name = v.as_str();
            let is_bound =
                query.variables.iter().any(|s| s == name) || bindings.contains_key(name);
            Ok(if is_bound { "true" } else { "false" }.into())
        }

        // IF expression: IF(condition, then_value, else_value)
        Expression::If(cond, then_expr, else_expr) => {
            let cond_result = filter_to_noir(cond, query, bindings, hidden)?;
            let then_result = filter_to_noir(then_expr, query, bindings, hidden)?;
            let else_result = filter_to_noir(else_expr, query, bindings, hidden)?;
            // In Noir, we use conditional selection via multiplication
            // result = cond * then_value + (1 - cond) * else_value
            // But for boolean conditions we can use: (cond & then) | (!cond & else)
            Ok(format!(
                "if ({}) {{ {} }} else {{ {} }}",
                cond_result, then_result, else_result
            ))
        }

        // COALESCE: returns first non-error value
        Expression::Coalesce(exprs) => {
            if exprs.is_empty() {
                return Err("COALESCE requires at least one argument".into());
            }
            // For ZK circuits, we can't truly handle errors dynamically.
            // We'll assume all expressions are valid and return the first one.
            // A more complete implementation would use hidden inputs to indicate validity.
            if exprs.len() == 1 {
                return filter_to_noir(&exprs[0], query, bindings, hidden);
            }
            // Generate nested conditionals: if valid(e1) then e1 else if valid(e2) then e2...
            // For now, just return the first expression (simplification)
            filter_to_noir(&exprs[0], query, bindings, hidden)
        }

        // Type checking functions
        Expression::FunctionCall(func, args) => match (func, args.as_slice()) {
            (Function::IsIri, [arg]) => type_check(arg, 0, query, bindings, hidden),
            (Function::IsBlank, [arg]) => type_check(arg, 1, query, bindings, hidden),
            (Function::IsLiteral, [arg]) => type_check(arg, 2, query, bindings, hidden),
            _ => Err(format!("Unsupported function: {:?}", func)),
        },

        // Variables and literals as boolean expressions
        Expression::Variable(v) => Ok(format!("variables.{}", v.as_str())),
        Expression::NamedNode(nn) => Ok(term_encoding_expr(&GroundTerm::NamedNode(nn.clone()))),
        Expression::Literal(l) => Ok(term_encoding_expr(&GroundTerm::Literal(l.clone()))),

        _ => Err(format!("Unsupported filter expression: {:?}", expr)),
    }
}
/// Generate type checking assertion (isIRI, isBlank, isLiteral).
fn type_check(
    arg: &Expression,
    type_code: i32,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    let term = expr_to_term(arg)?;
    let idx = push_hidden(hidden, "term_to_field", &term);
    Ok(format!(
        "{} == consts::hash2([{}, hidden[{}]])",
        serialize_term(&term, query, bindings),
        type_code,
        idx
    ))
}

/// Generate numeric comparison with hidden inputs for dynamic values.
/// For float/double types, uses IEEE 754-2008 semantics:
/// - NaN comparisons always return false (including NaN != NaN for equality)
/// - +0.0 equals -0.0 for equality comparisons  
/// - +INF > all finite values, -INF < all finite values
fn numeric_comparison(
    expr: &Expression,
    a: &Expression,
    b: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    // Check if both operands are float/double literals - apply IEEE 754 constant folding
    if let (Expression::Literal(lit_a), Expression::Literal(lit_b)) = (a, b) {
        let special_a = detect_float_special(lit_a);
        let special_b = detect_float_special(lit_b);
        
        // If both are float/double, apply IEEE 754 comparison rules
        if let (Some(fa), Some(fb)) = (special_a, special_b) {
            let result = match expr {
                Expression::Less(_, _) => ieee754_less_than(fa, fb),
                Expression::LessOrEqual(_, _) => {
                    // a <= b iff a < b or a == b
                    let lt = ieee754_less_than(fa, fb);
                    let eq = ieee754_equal(fa, fb);
                    match (lt, eq) {
                        (Some(false), Some(false)) => Some(false),
                        (Some(true), _) | (_, Some(true)) => Some(true),
                        _ => None,
                    }
                }
                Expression::Greater(_, _) => ieee754_less_than(fb, fa),
                Expression::GreaterOrEqual(_, _) => {
                    // a >= b iff b < a or a == b
                    let gt = ieee754_less_than(fb, fa);
                    let eq = ieee754_equal(fa, fb);
                    match (gt, eq) {
                        (Some(false), Some(false)) => Some(false),
                        (Some(true), _) | (_, Some(true)) => Some(true),
                        _ => None,
                    }
                }
                _ => None,
            };
            
            if let Some(r) = result {
                return Ok(if r { "true" } else { "false" }.into());
            }
        }
    }
    
    /// Helper struct for comparison operands
    struct Operand {
        cmp_expr: String,
        ensure: Option<String>,
        special: Option<FloatSpecial>,
    }

    /// Extract numeric value from literal for constant folding
    fn extract_numeric(e: &Expression) -> Option<(i128, String)> {
        if let Expression::Literal(l) = e {
            let dt = l.datatype().as_str();
            
            // Support all numeric XSD types
            if dt == format!("{}integer", XSD)
                || dt == format!("{}decimal", XSD)
                || dt == format!("{}float", XSD)
                || dt == format!("{}double", XSD)
                || dt == format!("{}int", XSD)
                || dt == format!("{}long", XSD)
                || dt == format!("{}short", XSD)
                || dt == format!("{}byte", XSD)
            {
                // For integers, parse directly
                if let Ok(n) = l.value().parse::<i128>() {
                    return Some((n, dt.to_string()));
                }
                // For decimal/float/double, scale to fixed-point
                // Use 1e18 scale factor for 18 decimal places precision
                if let Ok(f) = l.value().parse::<f64>() {
                    // Skip NaN/INF - these need special handling
                    if f.is_nan() || f.is_infinite() {
                        return None;
                    }
                    let scaled = (f * 1e18) as i128;
                    return Some((scaled, dt.to_string()));
                }
            }
        }
        None
    }

    /// Extract operand from expression
    fn extract_operand(
        e: &Expression,
        datatype: Option<&str>,
        query: &QueryInfo,
        bindings: &BTreeMap<String, Term>,
        hidden: &mut Vec<serde_json::Value>,
    ) -> Result<Operand, String> {
        // Check for float/double special values first
        if let Expression::Literal(l) = e {
            if let Some(special) = detect_float_special(l) {
                // For NaN/INF, we need special handling
                match special {
                    FloatSpecial::NaN | FloatSpecial::PositiveInf | FloatSpecial::NegativeInf => {
                        return Ok(Operand {
                            cmp_expr: String::new(), // Will use special handling
                            ensure: None,
                            special: Some(special),
                        });
                    }
                    FloatSpecial::PositiveZero | FloatSpecial::NegativeZero => {
                        return Ok(Operand {
                            cmp_expr: "0i128".into(),
                            ensure: None,
                            special: Some(special),
                        });
                    }
                    FloatSpecial::Normal(n) => {
                        return Ok(Operand {
                            cmp_expr: format!("{}i128", n),
                            ensure: None,
                            special: Some(special),
                        });
                    }
                }
            }
        }
        
        // Numeric constant: use directly (with scaling for float/decimal)
        if let Some((n, _dt)) = extract_numeric(e) {
            return Ok(Operand {
                cmp_expr: format!("{}i128", n),
                ensure: None,
                special: None,
            });
        }

        // STRLEN function returns integer
        if let Expression::FunctionCall(Function::StrLen, args) = e {
            if let [arg] = args.as_slice() {
                let term = expr_to_term(arg)?;
                let idx = push_hidden(hidden, "strlen", &term);
                return Ok(Operand {
                    cmp_expr: format!("(hidden[{}] as i128)", idx),
                    ensure: None,
                    special: None,
                });
            }
        }

        // Variable or other expression: use hidden inputs
        let term = expr_to_term(e)?;
        let val_idx = push_hidden(hidden, "literal_value", &term);
        let spec_idx = push_hidden(hidden, "special_handling", &term);

        // Default to integer datatype if not specified
        let default_dt = format!("{}integer", XSD);
        let dt_iri = datatype.unwrap_or(&default_dt);
        
        let expected = format!(
            "consts::hash2([2, consts::hash4([hidden[{}], hidden[{}], {}, {}])])",
            val_idx,
            spec_idx,
            encode_string_expr(""),
            encode_string_expr(dt_iri)
        );
        let ensure = format!("{} == {}", expected, serialize_term(&term, query, bindings));

        Ok(Operand {
            cmp_expr: format!("(hidden[{}] as i128)", spec_idx),
            ensure: Some(ensure),
            special: None,
        })
    }

    // Determine datatype from literal operands for type enforcement
    let datatype = [a, b].iter().find_map(|e| {
        if let Expression::Literal(l) = e {
            let dt = l.datatype().as_str();
            // Accept all numeric types
            if dt == format!("{}integer", XSD)
                || dt == format!("{}decimal", XSD)
                || dt == format!("{}float", XSD)
                || dt == format!("{}double", XSD)
            {
                return Some(dt);
            }
        }
        None
    });

    let left = extract_operand(a, datatype, query, bindings, hidden)?;
    let right = extract_operand(b, datatype, query, bindings, hidden)?;

    // Handle IEEE 754 special cases when one operand is special
    if left.special.is_some() || right.special.is_some() {
        // If either operand is NaN, comparisons return false (except != handled elsewhere)
        if matches!(left.special, Some(FloatSpecial::NaN)) || 
           matches!(right.special, Some(FloatSpecial::NaN)) {
            return Ok("false".into());
        }
        
        // Handle +INF and -INF with known values
        match (&left.special, &right.special) {
            // +INF comparisons
            (Some(FloatSpecial::PositiveInf), Some(FloatSpecial::PositiveInf)) => {
                return Ok(match expr {
                    Expression::Less(_, _) | Expression::Greater(_, _) => "false",
                    Expression::LessOrEqual(_, _) | Expression::GreaterOrEqual(_, _) => "true",
                    _ => "false",
                }.into());
            }
            (Some(FloatSpecial::PositiveInf), _) => {
                // +INF > everything (except +INF already handled)
                return Ok(match expr {
                    Expression::Greater(_, _) | Expression::GreaterOrEqual(_, _) => "true",
                    Expression::Less(_, _) | Expression::LessOrEqual(_, _) => "false",
                    _ => "false",
                }.into());
            }
            (_, Some(FloatSpecial::PositiveInf)) => {
                // everything < +INF (except +INF already handled)
                return Ok(match expr {
                    Expression::Less(_, _) | Expression::LessOrEqual(_, _) => "true",
                    Expression::Greater(_, _) | Expression::GreaterOrEqual(_, _) => "false",
                    _ => "false",
                }.into());
            }
            
            // -INF comparisons
            (Some(FloatSpecial::NegativeInf), Some(FloatSpecial::NegativeInf)) => {
                return Ok(match expr {
                    Expression::Less(_, _) | Expression::Greater(_, _) => "false",
                    Expression::LessOrEqual(_, _) | Expression::GreaterOrEqual(_, _) => "true",
                    _ => "false",
                }.into());
            }
            (Some(FloatSpecial::NegativeInf), _) => {
                // -INF < everything (except -INF already handled)
                return Ok(match expr {
                    Expression::Less(_, _) | Expression::LessOrEqual(_, _) => "true",
                    Expression::Greater(_, _) | Expression::GreaterOrEqual(_, _) => "false",
                    _ => "false",
                }.into());
            }
            (_, Some(FloatSpecial::NegativeInf)) => {
                // everything > -INF (except -INF already handled)
                return Ok(match expr {
                    Expression::Greater(_, _) | Expression::GreaterOrEqual(_, _) => "true",
                    Expression::Less(_, _) | Expression::LessOrEqual(_, _) => "false",
                    _ => "false",
                }.into());
            }
            
            _ => {} // Continue with normal comparison for zero/normal values
        }
    }

    let cmp = match expr {
        Expression::Greater(_, _) => format!("{} > {}", left.cmp_expr, right.cmp_expr),
        Expression::GreaterOrEqual(_, _) => format!("{} >= {}", left.cmp_expr, right.cmp_expr),
        Expression::Less(_, _) => format!("{} < {}", left.cmp_expr, right.cmp_expr),
        Expression::LessOrEqual(_, _) => format!("{} <= {}", left.cmp_expr, right.cmp_expr),
        _ => return Err("Invalid comparison operator".into()),
    };

    // Combine type checks with comparison
    let mut parts: Vec<String> = Vec::new();
    if let Some(e) = left.ensure {
        parts.push(format!("({})", e));
    }
    if let Some(e) = right.ensure {
        parts.push(format!("({})", e));
    }
    parts.push(format!("({})", cmp));
    Ok(parts.join(" & "))
}

/// Generate string comparison with hidden inputs.
/// Uses fn:compare semantics: codepoint-by-codepoint comparison returning -1/0/1.
fn string_comparison(
    expr: &Expression,
    a: &Expression,
    b: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    // Extract string value and comparison result from hidden inputs
    let left = expr_to_term(a)?;
    let right = expr_to_term(b)?;

    // Request the string comparison result: -1 (less), 0 (equal), 1 (greater)
    let cmp_idx = push_hidden_comparison(hidden, "string_compare", &left, &right);

    // Generate constraint based on operator
    let constraint = match expr {
        Expression::Less(_, _) => format!("hidden[{}] == -1", cmp_idx),
        Expression::LessOrEqual(_, _) => format!("(hidden[{}] == -1) | (hidden[{}] == 0)", cmp_idx, cmp_idx),
        Expression::Greater(_, _) => format!("hidden[{}] == 1", cmp_idx),
        Expression::GreaterOrEqual(_, _) => format!("(hidden[{}] == 1) | (hidden[{}] == 0)", cmp_idx, cmp_idx),
        _ => return Err("Invalid comparison operator".into()),
    };

    // Add verification that the comparison result matches the actual strings
    // The prover provides string bytes and the circuit verifies codepoint ordering
    let verify = format!(
        "verify_string_compare({}, {}, hidden[{}])",
        serialize_term(&left, query, bindings),
        serialize_term(&right, query, bindings),
        cmp_idx
    );

    Ok(format!("({}) & ({})", verify, constraint))
}

/// Generate boolean comparison.
/// SPARQL 1.1 semantics: false < true (false=0, true=1).
fn boolean_comparison(
    expr: &Expression,
    a: &Expression,
    b: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    // Helper to extract boolean value from literal
    fn extract_bool(e: &Expression) -> Option<bool> {
        if let Expression::Literal(l) = e {
            let dt = l.datatype().as_str();
            if dt == format!("{}boolean", XSD) {
                return match l.value() {
                    "true" | "1" => Some(true),
                    "false" | "0" => Some(false),
                    _ => None,
                };
            }
        }
        None
    }

    // Try constant folding for literal booleans
    if let (Some(left_val), Some(right_val)) = (extract_bool(a), extract_bool(b)) {
        let result = match expr {
            Expression::Less(_, _) => !left_val && right_val,  // false < true
            Expression::LessOrEqual(_, _) => !left_val || right_val,
            Expression::Greater(_, _) => left_val && !right_val,  // true > false
            Expression::GreaterOrEqual(_, _) => left_val || !right_val,
            _ => return Err("Invalid comparison operator".into()),
        };
        return Ok(if result { "true" } else { "false" }.into());
    }

    // For variables, use hidden inputs for the boolean value (0 or 1)
    let left = expr_to_term(a)?;
    let right = expr_to_term(b)?;

    // Request boolean_value hidden inputs which provide 0 or 1
    let left_val_idx = push_hidden(hidden, "literal_value", &left);
    let left_spec_idx = push_hidden(hidden, "boolean_value", &left);
    let right_val_idx = push_hidden(hidden, "literal_value", &right);
    let right_spec_idx = push_hidden(hidden, "boolean_value", &right);

    let bool_dt = format!("{}boolean", XSD);

    // Verify that the hidden values correctly encode boolean literals
    let left_verify = format!(
        "{} == consts::hash2([2, consts::hash4([hidden[{}], hidden[{}], {}, {}])])",
        serialize_term(&left, query, bindings),
        left_val_idx, left_spec_idx,
        encode_string_expr(""),
        encode_string_expr(&bool_dt)
    );
    let right_verify = format!(
        "{} == consts::hash2([2, consts::hash4([hidden[{}], hidden[{}], {}, {}])])",
        serialize_term(&right, query, bindings),
        right_val_idx, right_spec_idx,
        encode_string_expr(""),
        encode_string_expr(&bool_dt)
    );

    // Generate constraint using i64 comparison (0 for false, 1 for true)
    let cmp = match expr {
        Expression::Less(_, _) => format!("(hidden[{}] as i64) < (hidden[{}] as i64)", left_spec_idx, right_spec_idx),
        Expression::LessOrEqual(_, _) => format!("(hidden[{}] as i64) <= (hidden[{}] as i64)", left_spec_idx, right_spec_idx),
        Expression::Greater(_, _) => format!("(hidden[{}] as i64) > (hidden[{}] as i64)", left_spec_idx, right_spec_idx),
        Expression::GreaterOrEqual(_, _) => format!("(hidden[{}] as i64) >= (hidden[{}] as i64)", left_spec_idx, right_spec_idx),
        _ => return Err("Invalid comparison operator".into()),
    };

    Ok(format!("({}) & ({}) & ({})", left_verify, right_verify, cmp))
}

/// Generate datetime comparison with hidden inputs.
/// Uses Unix epoch milliseconds for ordering (per spec/encoding.md).
fn datetime_comparison(
    expr: &Expression,
    a: &Expression,
    b: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    // DateTime uses special_handling which stores Unix epoch milliseconds
    // This is the same approach as numeric_comparison but with dateTime datatype
    let dt_iri = format!("{}dateTime", XSD);

    let left = expr_to_term(a)?;
    let right = expr_to_term(b)?;

    let left_val_idx = push_hidden(hidden, "literal_value", &left);
    let left_spec_idx = push_hidden(hidden, "special_handling", &left);
    let right_val_idx = push_hidden(hidden, "literal_value", &right);
    let right_spec_idx = push_hidden(hidden, "special_handling", &right);

    // Verify that the hidden values encode the correct dateTime terms
    let left_expected = format!(
        "consts::hash2([2, consts::hash4([hidden[{}], hidden[{}], {}, {}])])",
        left_val_idx, left_spec_idx,
        encode_string_expr(""),
        encode_string_expr(&dt_iri)
    );
    let right_expected = format!(
        "consts::hash2([2, consts::hash4([hidden[{}], hidden[{}], {}, {}])])",
        right_val_idx, right_spec_idx,
        encode_string_expr(""),
        encode_string_expr(&dt_iri)
    );

    let left_verify = format!("{} == {}", left_expected, serialize_term(&left, query, bindings));
    let right_verify = format!("{} == {}", right_expected, serialize_term(&right, query, bindings));

    // Compare using the special_handling (epoch milliseconds)
    let cmp = match expr {
        Expression::Less(_, _) => format!("(hidden[{}] as i64) < (hidden[{}] as i64)", left_spec_idx, right_spec_idx),
        Expression::LessOrEqual(_, _) => format!("(hidden[{}] as i64) <= (hidden[{}] as i64)", left_spec_idx, right_spec_idx),
        Expression::Greater(_, _) => format!("(hidden[{}] as i64) > (hidden[{}] as i64)", left_spec_idx, right_spec_idx),
        Expression::GreaterOrEqual(_, _) => format!("(hidden[{}] as i64) >= (hidden[{}] as i64)", left_spec_idx, right_spec_idx),
        _ => return Err("Invalid comparison operator".into()),
    };

    Ok(format!("({}) & ({}) & ({})", left_verify, right_verify, cmp))
}

/// Add a hidden input requirement and return its index.
fn push_hidden(hidden: &mut Vec<serde_json::Value>, kind: &str, term: &Term) -> usize {
    let idx = hidden.len();
    let term_json = match term {
        Term::Variable(name) => serde_json::json!({"type": "variable", "value": name}),
        Term::Input(i, j) => serde_json::json!({"type": "input", "value": [i, j]}),
        Term::Static(gt) => serde_json::json!({"type": "static", "value": ground_term_to_json(gt)}),
    };
    hidden.push(serde_json::json!({
        "type": "customComputed",
        "computedType": kind,
        "input": term_json
    }));
    idx
}

/// Add a hidden input for comparing two terms and return its index.
/// Used for string comparisons where the result is -1, 0, or 1.
fn push_hidden_comparison(hidden: &mut Vec<serde_json::Value>, kind: &str, left: &Term, right: &Term) -> usize {
    let idx = hidden.len();
    let left_json = match left {
        Term::Variable(name) => serde_json::json!({"type": "variable", "value": name}),
        Term::Input(i, j) => serde_json::json!({"type": "input", "value": [i, j]}),
        Term::Static(gt) => serde_json::json!({"type": "static", "value": ground_term_to_json(gt)}),
    };
    let right_json = match right {
        Term::Variable(name) => serde_json::json!({"type": "variable", "value": name}),
        Term::Input(i, j) => serde_json::json!({"type": "input", "value": [i, j]}),
        Term::Static(gt) => serde_json::json!({"type": "static", "value": ground_term_to_json(gt)}),
    };
    hidden.push(serde_json::json!({
        "type": "customComputed",
        "computedType": kind,
        "inputs": [left_json, right_json]
    }));
    idx
}

// =============================================================================
// PATTERN PROCESSING
// =============================================================================

/// Counter for generating fresh variable names.
static VAR_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn fresh_variable() -> TermPattern {
    let id = VAR_COUNTER.fetch_add(1, Ordering::SeqCst);
    TermPattern::Variable(Variable::new_unchecked(format!("__v{}", id)))
}

/// Process a list of triple patterns, extracting bindings and assertions.
fn process_patterns(patterns: &[TriplePattern]) -> Result<PatternInfo, String> {
    let mut info = PatternInfo::new();
    let mut seen_vars: BTreeSet<String> = BTreeSet::new();

    for (i, pattern) in patterns.iter().enumerate() {
        info.patterns.push(pattern.clone());

        // Process subject (position 0)
        match &pattern.subject {
            TermPattern::NamedNode(nn) => {
                info.assertions.push(Assertion(
                    Term::Static(GroundTerm::NamedNode(nn.clone())),
                    Term::Input(i, 0),
                ));
            }
            TermPattern::Variable(v) => {
                let name = v.as_str().to_string();
                if seen_vars.contains(&name) {
                    info.assertions
                        .push(Assertion(Term::Variable(name.clone()), Term::Input(i, 0)));
                } else {
                    info.bindings.push(Binding {
                        variable: name.clone(),
                        term: Term::Input(i, 0),
                    });
                    seen_vars.insert(name);
                }
            }
            TermPattern::BlankNode(_) => return Err("Blank nodes not supported".into()),
            TermPattern::Literal(_) => return Err("Literal in subject position".into()),
        }

        // Process predicate (position 1)
        match &pattern.predicate {
            NamedNodePattern::NamedNode(nn) => {
                info.assertions.push(Assertion(
                    Term::Static(GroundTerm::NamedNode(nn.clone())),
                    Term::Input(i, 1),
                ));
            }
            NamedNodePattern::Variable(v) => {
                let name = v.as_str().to_string();
                if seen_vars.contains(&name) {
                    info.assertions
                        .push(Assertion(Term::Variable(name.clone()), Term::Input(i, 1)));
                } else {
                    info.bindings.push(Binding {
                        variable: name.clone(),
                        term: Term::Input(i, 1),
                    });
                    seen_vars.insert(name);
                }
            }
        }

        // Process object (position 2)
        match &pattern.object {
            TermPattern::NamedNode(nn) => {
                info.assertions.push(Assertion(
                    Term::Static(GroundTerm::NamedNode(nn.clone())),
                    Term::Input(i, 2),
                ));
            }
            TermPattern::Literal(l) => {
                info.assertions.push(Assertion(
                    Term::Static(GroundTerm::Literal(l.clone())),
                    Term::Input(i, 2),
                ));
            }
            TermPattern::Variable(v) => {
                let name = v.as_str().to_string();
                if seen_vars.contains(&name) {
                    info.assertions
                        .push(Assertion(Term::Variable(name.clone()), Term::Input(i, 2)));
                } else {
                    info.bindings.push(Binding {
                        variable: name.clone(),
                        term: Term::Input(i, 2),
                    });
                    seen_vars.insert(name);
                }
            }
            _ => return Err("Unsupported object term type".into()),
        }
    }

    Ok(info)
}

/// Expand a property path to an equivalent graph pattern.
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
                Err(format!("Unsupported reverse path: {:?}", path))
            }
        }
        PropertyPathExpression::Sequence(a, b) => {
            let mid = fresh_variable();
            let left = expand_path(subject, a, &mid)?;
            let right = expand_path(&mid, b, object)?;
            Ok(GraphPattern::Join {
                left: Box::new(left),
                right: Box::new(right),
            })
        }
        PropertyPathExpression::Alternative(a, b) => {
            let left = expand_path(subject, a, object)?;
            let right = expand_path(subject, b, object)?;
            Ok(GraphPattern::Union {
                left: Box::new(left),
                right: Box::new(right),
            })
        }
        PropertyPathExpression::ZeroOrOne(inner) => {
            let one = expand_path(subject, inner, object)?;
            // Zero step: bind subject = object
            let zero = if let TermPattern::Variable(sv) = subject {
                GraphPattern::Extend {
                    inner: Box::new(GraphPattern::Bgp { patterns: vec![] }),
                    variable: sv.clone(),
                    expression: match object {
                        TermPattern::Variable(v) => Expression::Variable(v.clone()),
                        TermPattern::NamedNode(nn) => Expression::NamedNode(nn.clone()),
                        TermPattern::Literal(l) => Expression::Literal(l.clone()),
                        _ => return Err("Unsupported zero-or-one term".into()),
                    },
                }
            } else if let TermPattern::Variable(ov) = object {
                GraphPattern::Extend {
                    inner: Box::new(GraphPattern::Bgp { patterns: vec![] }),
                    variable: ov.clone(),
                    expression: match subject {
                        TermPattern::Variable(v) => Expression::Variable(v.clone()),
                        TermPattern::NamedNode(nn) => Expression::NamedNode(nn.clone()),
                        TermPattern::Literal(l) => Expression::Literal(l.clone()),
                        _ => return Err("Unsupported zero-or-one term".into()),
                    },
                }
            } else if subject == object {
                GraphPattern::Bgp { patterns: vec![] }
            } else {
                GraphPattern::Bgp { patterns: vec![] }
            };
            Ok(GraphPattern::Union {
                left: Box::new(one),
                right: Box::new(zero),
            })
        }
        _ => Err(format!("Unsupported path expression: {:?}", path)),
    }
}

/// Process a graph pattern recursively.
fn process_graph_pattern(gp: &GraphPattern) -> Result<PatternInfo, String> {
    match gp {
        GraphPattern::Bgp { patterns } => process_patterns(patterns),

        GraphPattern::Path {
            subject,
            path,
            object,
        } => {
            let expanded = expand_path(subject, path, object)?;
            process_graph_pattern(&expanded)
        }

        GraphPattern::Join { left, right } => {
            // Flatten into a single pattern list if possible
            let mut patterns: Vec<TriplePattern> = Vec::new();
            for side in [left.as_ref(), right.as_ref()] {
                match side {
                    GraphPattern::Bgp { patterns: p } => patterns.extend(p.clone()),
                    GraphPattern::Path {
                        subject,
                        path,
                        object,
                    } => match path {
                        PropertyPathExpression::NamedNode(nn) => {
                            patterns.push(TriplePattern {
                                subject: subject.clone(),
                                predicate: NamedNodePattern::NamedNode(nn.clone()),
                                object: object.clone(),
                            });
                        }
                        PropertyPathExpression::Reverse(inner) => {
                            if let PropertyPathExpression::NamedNode(nn) = inner.as_ref() {
                                patterns.push(TriplePattern {
                                    subject: object.clone(),
                                    predicate: NamedNodePattern::NamedNode(nn.clone()),
                                    object: subject.clone(),
                                });
                            } else {
                                return Err(format!(
                                    "Unsupported reverse path in join: {:?}",
                                    path
                                ));
                            }
                        }
                        _ => return Err(format!("Unsupported path in join: {:?}", path)),
                    },
                    GraphPattern::Extend {
                        inner,
                        variable,
                        expression,
                    } => {
                        let mut info = process_graph_pattern(inner)?;
                        let term = match expression {
                            Expression::Variable(v) => Term::Variable(v.as_str().to_string()),
                            Expression::NamedNode(nn) => {
                                Term::Static(GroundTerm::NamedNode(nn.clone()))
                            }
                            Expression::Literal(l) => Term::Static(GroundTerm::Literal(l.clone())),
                            _ => return Err("Unsupported BIND expression".into()),
                        };
                        info.bindings.push(Binding {
                            variable: variable.as_str().to_string(),
                            term,
                        });
                        return Ok(info);
                    }
                    _ => return Err(format!("Unsupported join side: {:?}", side)),
                }
            }
            process_patterns(&patterns)
        }

        GraphPattern::Filter { expr, inner } => {
            let mut info = process_graph_pattern(inner)?;
            info.filters.push(expr.clone());
            Ok(info)
        }

        GraphPattern::Extend {
            inner,
            variable,
            expression,
        } => {
            let mut info = process_graph_pattern(inner)?;
            let term = match expression {
                Expression::Variable(v) => Term::Variable(v.as_str().to_string()),
                Expression::NamedNode(nn) => Term::Static(GroundTerm::NamedNode(nn.clone())),
                Expression::Literal(l) => Term::Static(GroundTerm::Literal(l.clone())),
                _ => return Err("Unsupported BIND expression".into()),
            };
            info.bindings.push(Binding {
                variable: variable.as_str().to_string(),
                term,
            });
            Ok(info)
        }

        GraphPattern::LeftJoin {
            left, expression, ..
        } => {
            // OPTIONAL: process left side only (optional right side not enforced in circuit)
            let mut info = process_graph_pattern(left)?;
            if let Some(expr) = expression {
                info.filters.push(expr.clone());
            }
            Ok(info)
        }

        GraphPattern::Union { left, right } => {
            // Collect all branches
            fn collect_branches(
                gp: &GraphPattern,
                out: &mut Vec<PatternInfo>,
            ) -> Result<(), String> {
                match gp {
                    GraphPattern::Union { left, right } => {
                        collect_branches(left, out)?;
                        collect_branches(right, out)?;
                        Ok(())
                    }
                    _ => {
                        out.push(process_graph_pattern(gp)?);
                        Ok(())
                    }
                }
            }

            let mut branches: Vec<PatternInfo> = Vec::new();
            collect_branches(left, &mut branches)?;
            collect_branches(right, &mut branches)?;

            // Use patterns from the largest branch
            let patterns = branches
                .iter()
                .max_by_key(|b| b.patterns.len())
                .map(|b| b.patterns.clone())
                .unwrap_or_default();

            Ok(PatternInfo {
                patterns,
                bindings: Vec::new(),
                assertions: Vec::new(),
                filters: Vec::new(),
                union_branches: Some(branches),
            })
        }

        _ => Err(format!("Unsupported graph pattern: {:?}", gp)),
    }
}

/// Process a PROJECT pattern to extract the query info.
fn process_query(gp: &GraphPattern) -> Result<QueryInfo, String> {
    if let GraphPattern::Project { inner, variables } = gp {
        let vars: Vec<String> = variables.iter().map(|v| v.as_str().to_string()).collect();
        let pattern = process_graph_pattern(inner)?;
        Ok(QueryInfo {
            variables: vars,
            pattern,
        })
    } else {
        Err(format!("Expected PROJECT, got: {:?}", gp))
    }
}

// =============================================================================
// CODE GENERATION
// =============================================================================

/// Generate Noir circuit files from a SPARQL query.
fn generate_circuit(
    query_str: &str,
) -> Result<(String, String, String, serde_json::Value), String> {
    let query = SparqlParser::new()
        .parse_query(query_str)
        .map_err(|e| format!("Parse error: {}", e))?;

    let root = match &query {
        Query::Select { pattern, .. }
        | Query::Construct { pattern, .. }
        | Query::Describe { pattern, .. }
        | Query::Ask { pattern, .. } => pattern,
    };

    let info = process_query(root)?;

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
            // Branch-local bindings
            let mut branch_bindings = binding_map.clone();
            for b in &branch.bindings {
                if !info.variables.contains(&b.variable)
                    && !branch_bindings.contains_key(&b.variable)
                {
                    branch_bindings.insert(b.variable.clone(), b.term.clone());
                }
            }

            let mut branch_asserts: Vec<String> = Vec::new();

            // Binding assertions
            for b in &branch.bindings {
                let left = Term::Variable(b.variable.clone());
                branch_asserts.push(format!(
                    "{} == {}",
                    serialize_term(&left, &info, &branch_bindings),
                    serialize_term(&b.term, &info, &branch_bindings)
                ));
            }

            // Equality assertions
            for Assertion(l, r) in &branch.assertions {
                branch_asserts.push(format!(
                    "{} == {}",
                    serialize_term(l, &info, &branch_bindings),
                    serialize_term(r, &info, &branch_bindings)
                ));
            }

            // Filter assertions
            for f in &branch.filters {
                let expr = filter_to_noir(f, &info, &branch_bindings, &mut hidden)?;
                branch_asserts.push(expr);
            }

            union_assertions.push(branch_asserts);
        }
    } else {
        // Binding assertions
        for b in &info.pattern.bindings {
            let left = Term::Variable(b.variable.clone());
            assertions.push(format!(
                "{} == {}",
                serialize_term(&left, &info, &binding_map),
                serialize_term(&b.term, &info, &binding_map)
            ));
        }

        // Equality assertions
        for Assertion(l, r) in &info.pattern.assertions {
            assertions.push(format!(
                "{} == {}",
                serialize_term(l, &info, &binding_map),
                serialize_term(r, &info, &binding_map)
            ));
        }

        // Filter assertions
        for f in &info.pattern.filters {
            let expr = filter_to_noir(f, &info, &binding_map, &mut hidden)?;
            assertions.push(expr);
        }
    }

    // Generate sparql.nr
    let mut sparql_nr = String::new();
    sparql_nr.push_str("// Generated by sparql_noir transform\n");
    sparql_nr.push_str("use dep::consts;\n");
    sparql_nr.push_str("use dep::utils;\n");
    sparql_nr.push_str("use dep::types::Triple;\n\n");
    sparql_nr.push_str(&format!(
        "pub(crate) type BGP = [Triple; {}];\n",
        info.pattern.patterns.len()
    ));

    // Variables struct
    sparql_nr.push_str("pub(crate) struct Variables {\n");
    for v in &info.variables {
        sparql_nr.push_str(&format!("  pub(crate) {}: Field,\n", v));
    }
    sparql_nr.push_str("}\n\n");

    // Hidden type
    let has_hidden = !hidden.is_empty();
    if has_hidden {
        sparql_nr.push_str(&format!(
            "pub(crate) type Hidden = [Field; {}];\n",
            hidden.len()
        ));
    }

    // Check function
    sparql_nr.push_str(&format!(
        "pub(crate) fn checkBinding(bgp: BGP, variables: Variables{}) {{\n",
        if has_hidden { ", hidden: Hidden" } else { "" }
    ));

    if !union_assertions.is_empty() {
        // UNION: generate branch conditions
        for (idx, branch) in union_assertions.iter().enumerate() {
            let expr = if branch.is_empty() {
                "false".to_string()
            } else {
                branch
                    .iter()
                    .map(|s| format!("({})", s))
                    .collect::<Vec<_>>()
                    .join(" & ")
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

    // Load main.nr template
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let template_path = manifest_dir.join("template/main-verify.template.nr");
    let mut main_nr =
        fs::read_to_string(&template_path).map_err(|e| format!("Failed to read template: {}", e))?;

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

    // Nargo.toml
    let nargo_toml = r#"[package]
name = "sparql_proof"
type = "bin"
authors = [""]

[dependencies]
consts = { path = "../noir/lib/consts" }
types = { path = "../noir/lib/types" }
utils = { path = "../noir/lib/utils" }
"#
    .to_string();

    // Metadata
    let metadata = serde_json::json!({
        "variables": info.variables,
        "inputPatterns": info.pattern.patterns.iter().map(pattern_to_json).collect::<Vec<_>>(),
        "optionalPatterns": [],
        "unionBranches": info.pattern.union_branches.as_ref().map(|bs| {
            bs.iter().map(|b| b.patterns.iter().map(pattern_to_json).collect::<Vec<_>>()).collect::<Vec<_>>()
        }).unwrap_or_default(),
        "hiddenInputs": hidden,
        // Legacy snake_case keys for compatibility
        "input_patterns": info.pattern.patterns.iter().map(pattern_to_json).collect::<Vec<_>>(),
        "optional_patterns": [],
        "union_branches": info.pattern.union_branches.as_ref().map(|bs| {
            bs.iter().map(|b| b.patterns.iter().map(pattern_to_json).collect::<Vec<_>>()).collect::<Vec<_>>()
        }).unwrap_or_default(),
        "hidden_inputs": hidden,
    });

    Ok((sparql_nr, main_nr, nargo_toml, metadata))
}

// =============================================================================
// JSON SERIALIZATION
// =============================================================================

fn ground_term_to_json(gt: &GroundTerm) -> serde_json::Value {
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

fn term_pattern_to_json(tp: &TermPattern) -> serde_json::Value {
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

fn named_node_pattern_to_json(nnp: &NamedNodePattern) -> serde_json::Value {
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

fn pattern_to_json(tp: &TriplePattern) -> serde_json::Value {
    serde_json::json!({
        "subject": term_pattern_to_json(&tp.subject),
        "predicate": named_node_pattern_to_json(&tp.predicate),
        "object": term_pattern_to_json(&tp.object),
        "graph": {"termType": "DefaultGraph"}
    })
}

// =============================================================================
// FILE I/O
// =============================================================================

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

// =============================================================================
// MAIN
// =============================================================================

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

    let (sparql_nr, main_nr, nargo_toml, metadata) = generate_circuit(&query_text)?;

    // Write outputs
    let repo_root = get_repo_root();
    let sparql_out = format!("{}/noir_prove/src/sparql.nr", repo_root);
    let main_out = format!("{}/noir_prove/src/main.nr", repo_root);
    let nargo_out = format!("{}/noir_prove/Nargo.toml", repo_root);
    let meta_out = format!("{}/noir_prove/metadata.json", repo_root);

    write_file(&sparql_out, &sparql_nr)?;
    write_file(&main_out, &main_nr)?;
    write_file(&nargo_out, &nargo_toml)?;
    write_file(&meta_out, &serde_json::to_string_pretty(&metadata)?)?;

    println!(
        "Generated: {}, {}, {}, {}",
        sparql_out, main_out, nargo_out, meta_out
    );

    Ok(())
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Test IEEE 754 less-than semantics
    #[test]
    fn test_ieee754_less_than_nan() {
        // NaN comparisons always return false
        assert_eq!(ieee754_less_than(FloatSpecial::NaN, FloatSpecial::Normal(0)), Some(false));
        assert_eq!(ieee754_less_than(FloatSpecial::Normal(0), FloatSpecial::NaN), Some(false));
        assert_eq!(ieee754_less_than(FloatSpecial::NaN, FloatSpecial::NaN), Some(false));
        assert_eq!(ieee754_less_than(FloatSpecial::NaN, FloatSpecial::PositiveInf), Some(false));
        assert_eq!(ieee754_less_than(FloatSpecial::NegativeInf, FloatSpecial::NaN), Some(false));
    }

    #[test]
    fn test_ieee754_less_than_infinity() {
        // -INF < everything except -INF
        assert_eq!(ieee754_less_than(FloatSpecial::NegativeInf, FloatSpecial::Normal(0)), Some(true));
        assert_eq!(ieee754_less_than(FloatSpecial::NegativeInf, FloatSpecial::PositiveInf), Some(true));
        assert_eq!(ieee754_less_than(FloatSpecial::NegativeInf, FloatSpecial::NegativeInf), Some(false));
        
        // +INF > everything (so not less than anything)
        assert_eq!(ieee754_less_than(FloatSpecial::PositiveInf, FloatSpecial::Normal(1000)), Some(false));
        assert_eq!(ieee754_less_than(FloatSpecial::PositiveInf, FloatSpecial::NegativeInf), Some(false));
        assert_eq!(ieee754_less_than(FloatSpecial::PositiveInf, FloatSpecial::PositiveInf), Some(false));
        
        // Everything < +INF
        assert_eq!(ieee754_less_than(FloatSpecial::Normal(1000), FloatSpecial::PositiveInf), Some(true));
        assert_eq!(ieee754_less_than(FloatSpecial::NegativeInf, FloatSpecial::PositiveInf), Some(true));
    }

    #[test]
    fn test_ieee754_less_than_zero() {
        // +0 and -0 are equal, so neither is less than the other
        assert_eq!(ieee754_less_than(FloatSpecial::PositiveZero, FloatSpecial::NegativeZero), Some(false));
        assert_eq!(ieee754_less_than(FloatSpecial::NegativeZero, FloatSpecial::PositiveZero), Some(false));
    }

    /// Test IEEE 754 equality semantics
    #[test]
    fn test_ieee754_equal_nan() {
        // NaN != NaN (this is the key IEEE 754 behavior)
        assert_eq!(ieee754_equal(FloatSpecial::NaN, FloatSpecial::NaN), Some(false));
        assert_eq!(ieee754_equal(FloatSpecial::NaN, FloatSpecial::Normal(0)), Some(false));
        assert_eq!(ieee754_equal(FloatSpecial::Normal(0), FloatSpecial::NaN), Some(false));
    }

    #[test]
    fn test_ieee754_equal_infinity() {
        // INF == INF
        assert_eq!(ieee754_equal(FloatSpecial::PositiveInf, FloatSpecial::PositiveInf), Some(true));
        // -INF == -INF
        assert_eq!(ieee754_equal(FloatSpecial::NegativeInf, FloatSpecial::NegativeInf), Some(true));
        // INF != -INF
        assert_eq!(ieee754_equal(FloatSpecial::PositiveInf, FloatSpecial::NegativeInf), Some(false));
    }

    #[test]
    fn test_ieee754_equal_zero() {
        // +0 == -0 (key IEEE 754 behavior for equality)
        assert_eq!(ieee754_equal(FloatSpecial::PositiveZero, FloatSpecial::NegativeZero), Some(true));
        assert_eq!(ieee754_equal(FloatSpecial::NegativeZero, FloatSpecial::PositiveZero), Some(true));
        assert_eq!(ieee754_equal(FloatSpecial::PositiveZero, FloatSpecial::PositiveZero), Some(true));
    }

    /// Test SPARQL query generation with IEEE 754 special values
    #[test]
    fn test_filter_nan_comparison() {
        let query = r#"
            PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
            SELECT ?x WHERE {
                ?x ?p ?o .
                FILTER("NaN"^^xsd:float < "1.0"^^xsd:float)
            }
        "#;
        
        let result = generate_circuit(query);
        assert!(result.is_ok(), "Query should parse successfully");
        
        let (sparql_nr, _, _, _) = result.unwrap();
        // NaN < anything should be false - check that the generated code reflects this
        assert!(sparql_nr.contains("false"), "NaN < 1.0 should generate 'false' in output");
    }

    #[test]
    fn test_filter_nan_equality() {
        let query = r#"
            PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
            SELECT ?x WHERE {
                ?x ?p ?o .
                FILTER("NaN"^^xsd:double = "NaN"^^xsd:double)
            }
        "#;
        
        let result = generate_circuit(query);
        assert!(result.is_ok(), "Query should parse successfully");
        
        let (sparql_nr, _, _, _) = result.unwrap();
        // NaN == NaN should be false
        assert!(sparql_nr.contains("false"), "NaN == NaN should generate 'false' in output");
    }

    #[test]
    fn test_filter_infinity_comparison() {
        let query = r#"
            PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
            SELECT ?x WHERE {
                ?x ?p ?o .
                FILTER("INF"^^xsd:double > "1000000.0"^^xsd:double)
            }
        "#;
        
        let result = generate_circuit(query);
        assert!(result.is_ok(), "Query should parse successfully");
        
        let (sparql_nr, _, _, _) = result.unwrap();
        // INF > any_finite should be true
        assert!(sparql_nr.contains("true"), "INF > 1000000.0 should generate 'true' in output");
    }

    #[test]
    fn test_filter_negative_infinity() {
        let query = r#"
            PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
            SELECT ?x WHERE {
                ?x ?p ?o .
                FILTER("-INF"^^xsd:float < "-1000000.0"^^xsd:float)
            }
        "#;
        
        let result = generate_circuit(query);
        assert!(result.is_ok(), "Query should parse successfully");
        
        let (sparql_nr, _, _, _) = result.unwrap();
        // -INF < any_finite should be true
        assert!(sparql_nr.contains("true"), "-INF < -1000000.0 should generate 'true' in output");
    }

    #[test]
    fn test_filter_zero_equality() {
        let query = r#"
            PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
            SELECT ?x WHERE {
                ?x ?p ?o .
                FILTER("0.0"^^xsd:double = "-0.0"^^xsd:double)
            }
        "#;
        
        let result = generate_circuit(query);
        assert!(result.is_ok(), "Query should parse successfully");
        
        let (sparql_nr, _, _, _) = result.unwrap();
        // +0 == -0 should be true
        assert!(sparql_nr.contains("true"), "0.0 == -0.0 should generate 'true' in output");
    }

    // ==========================================================================
    // SNAPSHOT TESTS - Verify generated sparql.nr matches expected output
    // ==========================================================================
    // These tests ensure the transform generates correct Noir code and catches
    // regressions like:
    // - Variables struct containing non-projected variables
    // - Missing static term assertions (predicates, objects)
    // - Missing filter constraints
    // - IEEE 754 comparisons evaluated at Rust compile time instead of Noir runtime

    fn normalize_whitespace(s: &str) -> String {
        // Normalize line endings and trim trailing whitespace from each line
        s.lines()
            .map(|line| line.trim_end())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string()
    }

    /// Run a snapshot test: parse query, generate circuit, compare against expected output
    fn run_snapshot_test(test_name: &str) {
        let fixture_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("test")
            .join("fixtures")
            .join(test_name);
        
        let query_path = fixture_dir.join("query.rq");
        let expected_path = fixture_dir.join("expected.nr");
        
        let query = std::fs::read_to_string(&query_path)
            .unwrap_or_else(|e| panic!("Failed to read {}: {}", query_path.display(), e));
        let expected = std::fs::read_to_string(&expected_path)
            .unwrap_or_else(|e| panic!("Failed to read {}: {}", expected_path.display(), e));
        
        let result = generate_circuit(&query);
        assert!(result.is_ok(), "Query should parse successfully: {:?}", result.err());
        
        let (sparql_nr, _, _, _) = result.unwrap();
        
        let expected_normalized = normalize_whitespace(&expected);
        let actual_normalized = normalize_whitespace(&sparql_nr);
        
        if expected_normalized != actual_normalized {
            // Pretty-print the diff for debugging
            eprintln!("\n=== SNAPSHOT MISMATCH for {} ===", test_name);
            eprintln!("\n--- Expected ---\n{}", expected);
            eprintln!("\n--- Actual ---\n{}", sparql_nr);
            eprintln!("\n--- End ---\n");
            panic!("Generated sparql.nr does not match expected output for test '{}'", test_name);
        }
    }

    #[test]
    fn snapshot_basic_bgp() {
        run_snapshot_test("basic_bgp");
    }

    #[test]
    fn snapshot_static_predicate() {
        run_snapshot_test("static_predicate");
    }

    #[test]
    fn snapshot_filter_inequality() {
        run_snapshot_test("filter_inequality");
    }

    #[test]
    fn snapshot_filter_comparison() {
        run_snapshot_test("filter_comparison");
    }

    // ==========================================================================
    // ASSERTION TESTS - Verify specific behaviors without full snapshot matching
    // ==========================================================================

    #[test]
    fn test_variables_struct_only_projected() {
        // Ensure Variables struct only contains projected variables from SELECT
        let query = r#"
            PREFIX ex: <http://example.org/>
            SELECT ?s ?o WHERE { ?s ex:knows ?o . }
        "#;
        
        let result = generate_circuit(query);
        assert!(result.is_ok());
        let (sparql_nr, _, _, _) = result.unwrap();
        
        // Should contain s and o
        assert!(sparql_nr.contains("pub(crate) s: Field"), "Should contain projected var s");
        assert!(sparql_nr.contains("pub(crate) o: Field"), "Should contain projected var o");
        
        // Should NOT contain p (not in SELECT)
        assert!(!sparql_nr.contains("pub(crate) p: Field"), "Should NOT contain non-projected var p");
    }

    #[test]
    fn test_static_predicate_assertion() {
        // Ensure static predicates (NamedNodes in predicate position) generate assertions
        let query = r#"
            PREFIX ex: <http://example.org/>
            SELECT ?s ?o WHERE { ?s ex:knows ?o . }
        "#;
        
        let result = generate_circuit(query);
        assert!(result.is_ok());
        let (sparql_nr, _, _, _) = result.unwrap();
        
        // Should have an assertion for the predicate IRI
        assert!(sparql_nr.contains("http://example.org/knows"), 
            "Should contain assertion for static predicate IRI");
        assert!(sparql_nr.contains("hash2([0,") || sparql_nr.contains("hash2([0, "), 
            "Should encode predicate as NamedNode (type code 0)");
    }

    #[test]
    fn test_filter_inequality_generates_noir() {
        // Ensure FILTER(?s != ?o) generates Noir assertion, not Rust evaluation
        let query = r#"
            PREFIX ex: <http://example.org/>
            SELECT ?s ?o WHERE { ?s ex:knows ?o . FILTER(?s != ?o) }
        "#;
        
        let result = generate_circuit(query);
        assert!(result.is_ok());
        let (sparql_nr, _, _, _) = result.unwrap();
        
        // Should have inequality check in generated Noir
        assert!(sparql_nr.contains("== false") || sparql_nr.contains("!= "),
            "Should contain inequality constraint in Noir code");
        assert!(sparql_nr.contains("variables.s") && sparql_nr.contains("variables.o"),
            "Should reference variables in the inequality check");
    }

    #[test]
    fn test_filter_comparison_generates_noir() {
        // Ensure FILTER(?o > 3) generates Noir assertion with hidden inputs
        let query = r#"
            PREFIX ex: <http://example.org/>
            PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
            SELECT ?s ?o WHERE { ?s ex:knows ?o . FILTER(?o > "3"^^xsd:integer) }
        "#;
        
        let result = generate_circuit(query);
        assert!(result.is_ok());
        let (sparql_nr, _, _, _) = result.unwrap();
        
        // Should use hidden inputs for comparison
        assert!(sparql_nr.contains("Hidden"), "Should have Hidden type for variable comparisons");
        assert!(sparql_nr.contains("hidden"), "Should use hidden inputs in checkBinding");
        
        // Should have the comparison in Noir, not evaluated as constant
        assert!(sparql_nr.contains("> 3i128") || sparql_nr.contains("> 3 i128"),
            "Should contain Noir comparison against integer literal");
    }
}
