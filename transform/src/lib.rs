//! SPARQL to Noir Circuit Transformer - Library
//!
//! This library provides the core transformation functionality that can be
//! compiled to WebAssembly for use in JavaScript/TypeScript environments.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::wasm_bindgen;

use std::collections::{BTreeMap, BTreeSet};

use spargebra::algebra::{Expression, Function, GraphPattern, PropertyPathExpression};
use spargebra::term::{GroundTerm, NamedNodePattern, TermPattern, TriplePattern, Variable};
use spargebra::{Query, SparqlParser};

use std::sync::atomic::{AtomicUsize, Ordering};

// Embed the template at compile time for WASM compatibility
const MAIN_TEMPLATE: &str = include_str!("../template/main-verify.template.nr");
const MAIN_TEMPLATE_SIMPLE: &str = include_str!("../template/main-simple.template.nr");

// Global counter for unique optional block IDs
static OPTIONAL_BLOCK_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn next_optional_id() -> usize {
    OPTIONAL_BLOCK_COUNTER.fetch_add(1, Ordering::SeqCst)
}

fn reset_optional_counter() {
    OPTIONAL_BLOCK_COUNTER.store(0, Ordering::SeqCst);
}

// =============================================================================
// DATA TYPES
// =============================================================================

/// Represents a term in the generated Noir circuit.
#[derive(Clone, Debug)]
pub enum Term {
    Variable(String),
    Input(usize, usize),
    Static(GroundTerm),
}

#[derive(Clone, Debug)]
pub struct Assertion(Term, Term);

#[derive(Clone, Debug)]
pub struct Binding {
    variable: String,
    term: Term,
}

#[derive(Clone, Debug)]
pub enum GraphContext {
    Default,
    NamedNode(String),
    Variable(String),
}

#[derive(Clone, Debug)]
pub struct ContextualizedTriple {
    pattern: TriplePattern,
    graph: GraphContext,
}

/// Represents an OPTIONAL block with its patterns, bindings, assertions, and filters
#[derive(Clone, Debug)]
pub struct OptionalBlock {
    /// Unique identifier for this optional block
    pub id: usize,
    /// Patterns in this optional block
    pub patterns: Vec<ContextualizedTriple>,
    /// Bindings in this optional block  
    pub bindings: Vec<Binding>,
    /// Assertions in this optional block
    pub assertions: Vec<Assertion>,
    /// Filters that apply when this optional is matched
    pub filters: Vec<Expression>,
    /// Nested optional blocks within this one
    pub nested_optionals: Vec<OptionalBlock>,
}

#[derive(Clone, Debug)]
pub struct PatternInfo {
    /// Required patterns (always present)
    patterns: Vec<ContextualizedTriple>,
    bindings: Vec<Binding>,
    assertions: Vec<Assertion>,
    filters: Vec<Expression>,
    union_branches: Option<Vec<PatternInfo>>,
    /// Optional blocks that may or may not be matched
    optional_blocks: Vec<OptionalBlock>,
}

impl PatternInfo {
    fn new() -> Self {
        Self {
            patterns: Vec::new(),
            bindings: Vec::new(),
            assertions: Vec::new(),
            filters: Vec::new(),
            union_branches: None,
            optional_blocks: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct QueryInfo {
    variables: Vec<String>,
    pattern: PatternInfo,
}

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
// CONSTANTS
// =============================================================================

const XSD: &str = "http://www.w3.org/2001/XMLSchema#";

// =============================================================================
// IEEE 754 FLOAT HANDLING
// =============================================================================

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FloatSpecial {
    Normal(i64),
    NaN,
    PositiveInf,
    NegativeInf,
    PositiveZero,
    NegativeZero,
}

fn parse_float_special(value: &str, _datatype: &str) -> FloatSpecial {
    let v = value.trim();
    if v == "NaN" {
        FloatSpecial::NaN
    } else if v == "INF" || v == "+INF" {
        FloatSpecial::PositiveInf
    } else if v == "-INF" {
        FloatSpecial::NegativeInf
    } else if v == "0" || v == "0.0" || v == "+0" || v == "+0.0" {
        FloatSpecial::PositiveZero
    } else if v == "-0" || v == "-0.0" {
        FloatSpecial::NegativeZero
    } else {
        // Parse as i64 bits for normal values
        if let Ok(f) = v.parse::<f64>() {
            FloatSpecial::Normal(f.to_bits() as i64)
        } else {
            FloatSpecial::NaN
        }
    }
}

pub fn ieee754_less_than(a: FloatSpecial, b: FloatSpecial) -> Option<bool> {
    use FloatSpecial::*;
    match (a, b) {
        (NaN, _) | (_, NaN) => Some(false),
        (NegativeInf, NegativeInf) => Some(false),
        (NegativeInf, _) => Some(true),
        (_, NegativeInf) => Some(false),
        (PositiveInf, _) => Some(false),
        (_, PositiveInf) => Some(true),
        (PositiveZero, NegativeZero) | (NegativeZero, PositiveZero) => Some(false),
        (PositiveZero, PositiveZero) | (NegativeZero, NegativeZero) => Some(false),
        (Normal(x), Normal(y)) => Some(x < y),
        (PositiveZero, Normal(y)) | (NegativeZero, Normal(y)) => Some(0 < y),
        (Normal(x), PositiveZero) | (Normal(x), NegativeZero) => Some(x < 0),
    }
}

pub fn ieee754_equal(a: FloatSpecial, b: FloatSpecial) -> Option<bool> {
    use FloatSpecial::*;
    match (a, b) {
        (NaN, _) | (_, NaN) => Some(false),
        (PositiveInf, PositiveInf) => Some(true),
        (NegativeInf, NegativeInf) => Some(true),
        (PositiveInf, _) | (_, PositiveInf) => Some(false),
        (NegativeInf, _) | (_, NegativeInf) => Some(false),
        (PositiveZero, NegativeZero) | (NegativeZero, PositiveZero) => Some(true),
        (PositiveZero, PositiveZero) | (NegativeZero, NegativeZero) => Some(true),
        (Normal(x), Normal(y)) => Some(x == y),
        (PositiveZero, Normal(y)) | (NegativeZero, Normal(y)) => Some(0 == y),
        (Normal(x), PositiveZero) | (Normal(x), NegativeZero) => Some(x == 0),
    }
}

// =============================================================================
// TERM SERIALIZATION
// =============================================================================

fn encode_string_expr(s: &str) -> String {
    // Use consts::encode_string since consts is always available (even in skip-signing mode)
    format!("consts::encode_string(\"{}\")", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn serialize_term(term: &Term, query: &QueryInfo, bindings: &BTreeMap<String, Term>) -> String {
    match term {
        Term::Variable(name) => {
            if query.variables.contains(name) {
                format!("variables.{}", name)
            } else if let Some(bound) = bindings.get(name) {
                serialize_term(bound, query, bindings)
            } else {
                format!("variables.{}", name)
            }
        }
        Term::Input(triple_idx, term_idx) => {
            format!("bgp[{}].terms[{}]", triple_idx, term_idx)
        }
        Term::Static(gt) => serialize_ground_term(gt),
    }
}

/// Compute the special literal encoding for the second field of hash4.
/// This must match the TypeScript specialLiteralHandling function in encode.ts.
/// Uses oxsdatatypes for robust parsing of XSD typed literals.
fn special_literal_handling(value: &str, datatype: &str) -> String {
    use oxsdatatypes::{Boolean, Integer, DateTime, Double};
    
    // XSD namespace prefix
    const XSD_PREFIX: &str = "http://www.w3.org/2001/XMLSchema#";
    
    // Check if this is an XSD datatype
    if !datatype.starts_with(XSD_PREFIX) {
        return encode_string_expr(value);
    }
    
    let local_name = &datatype[XSD_PREFIX.len()..];
    
    match local_name {
        // Boolean: true/1 → 1, false/0 → 0
        "boolean" => {
            if let Ok(b) = value.parse::<Boolean>() {
                return if bool::from(b) { "1" } else { "0" }.to_string();
            }
            encode_string_expr(value)
        }
        
        // All integer types use oxsdatatypes::Integer parsing
        "integer" | "int" | "long" | "short" | "byte" 
        | "nonNegativeInteger" | "positiveInteger" | "negativeInteger" | "nonPositiveInteger"
        | "unsignedInt" | "unsignedLong" | "unsignedShort" | "unsignedByte" => {
            if let Ok(i) = value.parse::<Integer>() {
                return i64::from(i).to_string();
            }
            encode_string_expr(value)
        }
        
        // DateTime: convert to epoch milliseconds
        "dateTime" => {
            if let Ok(dt) = value.parse::<DateTime>() {
                // Parse Unix epoch: 1970-01-01T00:00:00Z
                if let Ok(epoch) = "1970-01-01T00:00:00Z".parse::<DateTime>() {
                    // Subtract epoch from parsed datetime to get duration
                    if let Some(duration) = dt.checked_sub(epoch) {
                        // Get total seconds as Decimal, convert to Double (f64)
                        let total_seconds: f64 = Double::from(duration.as_seconds()).into();
                        let epoch_ms = (total_seconds * 1000.0) as i64;
                        return epoch_ms.to_string();
                    }
                }
            }
            encode_string_expr(value)
        }
        
        // Default: encode as string
        _ => encode_string_expr(value)
    }
}

fn serialize_ground_term(gt: &GroundTerm) -> String {
    match gt {
        GroundTerm::NamedNode(nn) => {
            format!("consts::hash2([0, {}])", encode_string_expr(nn.as_str()))
        }
        GroundTerm::Literal(l) => {
            let value = l.value();
            let datatype = l.datatype().as_str();
            let lang = l.language().unwrap_or("");
            let special_encoding = special_literal_handling(value, datatype);
            format!(
                "consts::hash2([2, consts::hash4([{}, {}, {}, {}])])",
                encode_string_expr(value),
                special_encoding,
                encode_string_expr(lang),
                encode_string_expr(datatype)
            )
        }
    }
}

// =============================================================================
// EXPRESSION CONVERSION
// =============================================================================

fn expr_to_term(expr: &Expression) -> Result<Term, String> {
    match expr {
        Expression::Variable(v) => Ok(Term::Variable(v.as_str().to_string())),
        Expression::NamedNode(nn) => Ok(Term::Static(GroundTerm::NamedNode(nn.clone()))),
        Expression::Literal(l) => Ok(Term::Static(GroundTerm::Literal(l.clone()))),
        _ => Err(format!("Cannot convert expression to term: {:?}", expr)),
    }
}

/// Convert an expression to Noir code string
/// This handles function calls and other complex expressions that cannot be converted to terms
fn expr_to_noir_code(
    expr: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    match expr {
        // Simple cases that can be converted to terms
        Expression::Variable(v) => {
            let term = Term::Variable(v.as_str().to_string());
            let idx = push_hidden(hidden, "expr_value", &term);
            Ok(format!("hidden[{}]", idx))
        }
        Expression::Literal(l) => {
            let term = Term::Static(GroundTerm::Literal(l.clone()));
            let idx = push_hidden(hidden, "expr_value", &term);
            Ok(format!("hidden[{}]", idx))
        }
        Expression::NamedNode(nn) => {
            let term = Term::Static(GroundTerm::NamedNode(nn.clone()));
            let idx = push_hidden(hidden, "expr_value", &term);
            Ok(format!("hidden[{}]", idx))
        }
        
        // Function calls
        Expression::FunctionCall(func, args) => {
            match func {
                // Numeric functions
                Function::Abs => {
                    if args.len() != 1 { return Err("ABS requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::abs_int({} as i64) as Field", arg_code))
                }
                Function::Round => {
                    if args.len() != 1 { return Err("ROUND requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::round_int({} as i64) as Field", arg_code))
                }
                Function::Ceil => {
                    if args.len() != 1 { return Err("CEIL requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::ceil_int({} as i64) as Field", arg_code))
                }
                Function::Floor => {
                    if args.len() != 1 { return Err("FLOOR requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::floor_int({} as i64) as Field", arg_code))
                }
                
                // DateTime functions
                Function::Year => {
                    if args.len() != 1 { return Err("YEAR requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::year_from_datetime(xpath::datetime_from_epoch_microseconds({} as i128)) as Field", arg_code))
                }
                Function::Month => {
                    if args.len() != 1 { return Err("MONTH requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::month_from_datetime(xpath::datetime_from_epoch_microseconds({} as i128)) as Field", arg_code))
                }
                Function::Day => {
                    if args.len() != 1 { return Err("DAY requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::day_from_datetime(xpath::datetime_from_epoch_microseconds({} as i128)) as Field", arg_code))
                }
                Function::Hours => {
                    if args.len() != 1 { return Err("HOURS requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::hours_from_datetime(xpath::datetime_from_epoch_microseconds({} as i128)) as Field", arg_code))
                }
                Function::Minutes => {
                    if args.len() != 1 { return Err("MINUTES requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::minutes_from_datetime(xpath::datetime_from_epoch_microseconds({} as i128)) as Field", arg_code))
                }
                Function::Seconds => {
                    if args.len() != 1 { return Err("SECONDS requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::seconds_from_datetime(xpath::datetime_from_epoch_microseconds({} as i128)) as Field", arg_code))
                }
                
                _ => Err(format!("Unsupported function in expression: {:?}", func)),
            }
        }
        
        _ => Err(format!("Cannot convert complex expression to Noir code: {:?}", expr)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ComparisonType {
    Numeric,
    String,
    Boolean,
    DateTime,
    Unknown,
}

fn datatype_to_comparison_type(datatype: &str) -> ComparisonType {
    if datatype.starts_with(XSD) {
        let local = &datatype[XSD.len()..];
        match local {
            "integer" | "decimal" | "float" | "double" | "int" | "long" | "short" | "byte"
            | "nonNegativeInteger" | "positiveInteger" | "negativeInteger" | "nonPositiveInteger"
            | "unsignedInt" | "unsignedLong" | "unsignedShort" | "unsignedByte" => ComparisonType::Numeric,
            "string" | "normalizedString" | "token" | "language" | "Name" | "NCName" | "NMTOKEN" => ComparisonType::String,
            "boolean" => ComparisonType::Boolean,
            "dateTime" | "date" | "time" => ComparisonType::DateTime,
            _ => ComparisonType::Unknown,
        }
    } else {
        ComparisonType::Unknown
    }
}

fn expr_comparison_type(expr: &Expression) -> ComparisonType {
    match expr {
        Expression::Literal(l) => datatype_to_comparison_type(l.datatype().as_str()),
        _ => ComparisonType::Unknown,
    }
}

fn determine_comparison_type(a: &Expression, b: &Expression) -> ComparisonType {
    let ta = expr_comparison_type(a);
    let tb = expr_comparison_type(b);
    if ta != ComparisonType::Unknown {
        ta
    } else {
        tb
    }
}

/// Handle equality comparisons involving SPARQL accessor functions (LANG, STR, DATATYPE).
/// Returns Some(noir_code) if the comparison was handled, None otherwise.
fn handle_function_equality(
    func_expr: &Expression,
    other_expr: &Expression,
    _query: &QueryInfo,
    _bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<Option<String>, String> {
    if let Expression::FunctionCall(func, args) = func_expr {
        match func {
            Function::Lang => {
                // LANG(?x) = "en" -> compare language tag
                if args.len() != 1 {
                    return Err("LANG requires 1 argument".into());
                }
                let term = expr_to_term(&args[0])?;
                let idx = push_hidden(hidden, "lang", &term);
                
                // Get the comparison value
                let cmp_value = match other_expr {
                    Expression::Literal(lit) => lit.value().to_string(),
                    _ => return Err("LANG comparison requires a string literal".into()),
                };
                
                Ok(Some(format!(
                    "hidden[{}] == consts::encode_string(\"{}\")",
                    idx, cmp_value
                )))
            }
            Function::Str => {
                // STR(?x) = "hello" -> compare lexical form
                if args.len() != 1 {
                    return Err("STR requires 1 argument".into());
                }
                let term = expr_to_term(&args[0])?;
                let idx = push_hidden(hidden, "str", &term);
                
                // Get the comparison value
                let cmp_value = match other_expr {
                    Expression::Literal(lit) => lit.value().to_string(),
                    Expression::NamedNode(nn) => nn.as_str().to_string(),
                    _ => return Err("STR comparison requires a literal or IRI".into()),
                };
                
                Ok(Some(format!(
                    "hidden[{}] == consts::encode_string(\"{}\")",
                    idx, cmp_value.replace('\\', "\\\\").replace('"', "\\\"")
                )))
            }
            Function::Datatype => {
                // DATATYPE(?x) = xsd:integer -> compare datatype IRI
                if args.len() != 1 {
                    return Err("DATATYPE requires 1 argument".into());
                }
                let term = expr_to_term(&args[0])?;
                let idx = push_hidden(hidden, "datatype", &term);
                
                // Get the comparison value (should be a named node / IRI)
                let cmp_value = match other_expr {
                    Expression::NamedNode(nn) => nn.as_str().to_string(),
                    Expression::Literal(lit) => lit.value().to_string(), // Allow string literal with IRI
                    _ => return Err("DATATYPE comparison requires an IRI".into()),
                };
                
                Ok(Some(format!(
                    "hidden[{}] == consts::encode_string(\"{}\")",
                    idx, cmp_value.replace('\\', "\\\\").replace('"', "\\\"")
                )))
            }
            _ => Ok(None), // Not a handled function
        }
    } else {
        Ok(None) // Not a function call
    }
}

fn filter_to_noir(
    expr: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    match expr {
        Expression::Equal(a, b) => {
            // Handle function call comparisons (e.g., LANG(?x) = "en")
            if let Some(result) = handle_function_equality(a, b, query, bindings, hidden)? {
                return Ok(result);
            }
            if let Some(result) = handle_function_equality(b, a, query, bindings, hidden)? {
                return Ok(result);
            }
            
            // Try to use expr_to_noir_code for complex expressions (like function calls)
            let left_code = match expr_to_noir_code(a, query, bindings, hidden) {
                Ok(code) => code,
                Err(_) => {
                    // Fallback to term-based approach
                    let left = expr_to_term(a)?;
                    let idx = push_hidden(hidden, "expr_value", &left);
                    format!("hidden[{}]", idx)
                }
            };
            
            let right_code = match expr_to_noir_code(b, query, bindings, hidden) {
                Ok(code) => code,
                Err(_) => {
                    // Fallback to term-based approach
                    let right = expr_to_term(b)?;
                    let idx = push_hidden(hidden, "expr_value", &right);
                    format!("hidden[{}]", idx)
                }
            };
            
            // IEEE 754 constant folding for float/double literals
            if let (Expression::Literal(lit_a), Expression::Literal(lit_b)) = (a.as_ref(), b.as_ref()) {
                let dt_a = lit_a.datatype().as_str();
                let dt_b = lit_b.datatype().as_str();
                if (dt_a.ends_with("float") || dt_a.ends_with("double")) &&
                   (dt_b.ends_with("float") || dt_b.ends_with("double")) {
                    let fa = parse_float_special(lit_a.value(), dt_a);
                    let fb = parse_float_special(lit_b.value(), dt_b);
                    if let Some(result) = ieee754_equal(fa, fb) {
                        return Ok(if result { "true" } else { "false" }.into());
                    }
                }
            }
            
            Ok(format!("{} == {}", left_code, right_code))
        }

        // Note: spargebra doesn't have NotEqual, inequality is typically !(a = b)
        // This case handles if we manually construct such an expression
        Expression::Not(inner) => {
            let inner_expr = filter_to_noir(inner, query, bindings, hidden)?;
            Ok(format!("!({})", inner_expr))
        }

        Expression::Greater(a, b) | Expression::GreaterOrEqual(a, b) |
        Expression::Less(a, b) | Expression::LessOrEqual(a, b) => {
            let cmp_type = determine_comparison_type(a, b);
            match cmp_type {
                ComparisonType::Numeric => numeric_comparison(expr, a, b, query, bindings, hidden),
                ComparisonType::String => string_comparison(expr, a, b, query, bindings, hidden),
                ComparisonType::Boolean => boolean_comparison(expr, a, b, query, bindings, hidden),
                ComparisonType::DateTime => datetime_comparison(expr, a, b, query, bindings, hidden),
                ComparisonType::Unknown => numeric_comparison(expr, a, b, query, bindings, hidden),
            }
        }

        Expression::And(a, b) => {
            let left = filter_to_noir(a, query, bindings, hidden)?;
            let right = filter_to_noir(b, query, bindings, hidden)?;
            Ok(format!("({}) & ({})", left, right))
        }

        Expression::Or(a, b) => {
            let left = filter_to_noir(a, query, bindings, hidden)?;
            let right = filter_to_noir(b, query, bindings, hidden)?;
            Ok(format!("({}) | ({})", left, right))
        }

        Expression::Bound(v) => {
            let var_name = v.as_str();
            if query.variables.contains(&var_name.to_string()) || bindings.contains_key(var_name) {
                Ok("true".into())
            } else {
                Ok("false".into())
            }
        }

        Expression::SameTerm(a, b) => {
            let left = expr_to_term(a)?;
            let right = expr_to_term(b)?;
            Ok(format!(
                "{} == {}",
                serialize_term(&left, query, bindings),
                serialize_term(&right, query, bindings)
            ))
        }

        Expression::FunctionCall(func, args) => {
            match func {
                Function::IsIri => {
                    if args.len() != 1 { return Err("isIRI requires 1 argument".into()); }
                    type_check(&args[0], 0, query, bindings, hidden)
                }
                Function::IsBlank => {
                    if args.len() != 1 { return Err("isBlank requires 1 argument".into()); }
                    type_check(&args[0], 1, query, bindings, hidden)
                }
                Function::IsLiteral => {
                    if args.len() != 1 { return Err("isLiteral requires 1 argument".into()); }
                    type_check(&args[0], 2, query, bindings, hidden)
                }
                Function::LangMatches => {
                    // LANGMATCHES(LANG(?x), "en") or LANGMATCHES(?lang, "*")
                    if args.len() != 2 {
                        return Err("LANGMATCHES requires 2 arguments".into());
                    }
                    
                    // First arg is usually LANG(?x), extract the variable
                    let lang_term = if let Expression::FunctionCall(Function::Lang, lang_args) = &args[0] {
                        if lang_args.len() != 1 {
                            return Err("LANG requires 1 argument".into());
                        }
                        expr_to_term(&lang_args[0])?
                    } else {
                        expr_to_term(&args[0])?
                    };
                    
                    // Second arg is the language pattern
                    let pattern = match &args[1] {
                        Expression::Literal(lit) => lit.value().to_string(),
                        _ => return Err("LANGMATCHES requires a string pattern".into()),
                    };
                    
                    let idx = push_hidden(hidden, "lang", &lang_term);
                    
                    // Handle the "*" wildcard (matches any non-empty language tag)
                    if pattern == "*" {
                        // Language tag is non-empty (not the empty string)
                        Ok(format!(
                            "hidden[{}] != consts::encode_string(\"\")",
                            idx
                        ))
                    } else {
                        // Exact match or prefix match for primary subtag
                        // For simplicity, we do exact match on the primary subtag
                        let primary = pattern.split('-').next().unwrap_or(&pattern).to_lowercase();
                        Ok(format!(
                            "hidden[{}] == consts::encode_string(\"{}\")",
                            idx, primary
                        ))
                    }
                }
                
                // Numeric functions
                Function::Abs => {
                    if args.len() != 1 { return Err("ABS requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let value_idx = push_hidden(hidden, "abs_value", &term);
                    let _datatype_idx = push_hidden(hidden, "abs_datatype", &term);
                    // Use xpath::abs_int for integer types
                    // The generated code should check numeric type and call appropriate function
                    Ok(format!("xpath::abs_int(hidden[{}] as i64) as Field", value_idx))
                }
                Function::Round => {
                    if args.len() != 1 { return Err("ROUND requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let value_idx = push_hidden(hidden, "round_value", &term);
                    Ok(format!("xpath::round_int(hidden[{}] as i64) as Field", value_idx))
                }
                Function::Ceil => {
                    if args.len() != 1 { return Err("CEIL requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let value_idx = push_hidden(hidden, "ceil_value", &term);
                    Ok(format!("xpath::ceil_int(hidden[{}] as i64) as Field", value_idx))
                }
                Function::Floor => {
                    if args.len() != 1 { return Err("FLOOR requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let value_idx = push_hidden(hidden, "floor_value", &term);
                    Ok(format!("xpath::floor_int(hidden[{}] as i64) as Field", value_idx))
                }
                
                // String functions (return numeric/boolean values only)
                Function::StrLen => {
                    if args.len() != 1 { return Err("STRLEN requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let str_idx = push_hidden(hidden, "strlen_str", &term);
                    // Note: We need to pass the actual string, not the hash
                    // For now, generate a placeholder that assumes string value is available
                    Ok(format!("hidden[{}]", str_idx))
                }
                Function::Contains => {
                    if args.len() != 2 { return Err("CONTAINS requires 2 arguments".into()); }
                    let str1_term = expr_to_term(&args[0])?;
                    let str2_term = expr_to_term(&args[1])?;
                    let str1_idx = push_hidden(hidden, "contains_str1", &str1_term);
                    let _str2_idx = push_hidden(hidden, "contains_str2", &str2_term);
                    // Generate placeholder - actual implementation needs string handling
                    Ok(format!("(hidden[{}] != 0)", str1_idx))
                }
                Function::StrStarts => {
                    if args.len() != 2 { return Err("STRSTARTS requires 2 arguments".into()); }
                    let str1_term = expr_to_term(&args[0])?;
                    let str2_term = expr_to_term(&args[1])?;
                    let str1_idx = push_hidden(hidden, "strstarts_str1", &str1_term);
                    let _str2_idx = push_hidden(hidden, "strstarts_str2", &str2_term);
                    Ok(format!("(hidden[{}] != 0)", str1_idx))
                }
                Function::StrEnds => {
                    if args.len() != 2 { return Err("STRENDS requires 2 arguments".into()); }
                    let str1_term = expr_to_term(&args[0])?;
                    let str2_term = expr_to_term(&args[1])?;
                    let str1_idx = push_hidden(hidden, "strends_str1", &str1_term);
                    let _str2_idx = push_hidden(hidden, "strends_str2", &str2_term);
                    Ok(format!("(hidden[{}] != 0)", str1_idx))
                }
                
                // DateTime functions
                Function::Year => {
                    if args.len() != 1 { return Err("YEAR requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let dt_idx = push_hidden(hidden, "year_datetime", &term);
                    // Generate call to xpath datetime function
                    // Assuming datetime is stored as epoch microseconds
                    Ok(format!("xpath::year_from_datetime(xpath::datetime_from_epoch_microseconds(hidden[{}] as i128))", dt_idx))
                }
                Function::Month => {
                    if args.len() != 1 { return Err("MONTH requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let dt_idx = push_hidden(hidden, "month_datetime", &term);
                    Ok(format!("xpath::month_from_datetime(xpath::datetime_from_epoch_microseconds(hidden[{}] as i128))", dt_idx))
                }
                Function::Day => {
                    if args.len() != 1 { return Err("DAY requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let dt_idx = push_hidden(hidden, "day_datetime", &term);
                    Ok(format!("xpath::day_from_datetime(xpath::datetime_from_epoch_microseconds(hidden[{}] as i128))", dt_idx))
                }
                Function::Hours => {
                    if args.len() != 1 { return Err("HOURS requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let dt_idx = push_hidden(hidden, "hours_datetime", &term);
                    Ok(format!("xpath::hours_from_datetime(xpath::datetime_from_epoch_microseconds(hidden[{}] as i128))", dt_idx))
                }
                Function::Minutes => {
                    if args.len() != 1 { return Err("MINUTES requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let dt_idx = push_hidden(hidden, "minutes_datetime", &term);
                    Ok(format!("xpath::minutes_from_datetime(xpath::datetime_from_epoch_microseconds(hidden[{}] as i128))", dt_idx))
                }
                Function::Seconds => {
                    if args.len() != 1 { return Err("SECONDS requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let dt_idx = push_hidden(hidden, "seconds_datetime", &term);
                    Ok(format!("xpath::seconds_from_datetime(xpath::datetime_from_epoch_microseconds(hidden[{}] as i128))", dt_idx))
                }
                Function::Timezone => {
                    if args.len() != 1 { return Err("TIMEZONE requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let dt_idx = push_hidden(hidden, "timezone_datetime", &term);
                    // Returns a duration representing the timezone offset
                    Ok(format!("xpath::duration_to_microseconds(xpath::timezone_from_datetime(xpath::datetime_from_epoch_microseconds(hidden[{}] as i128)))", dt_idx))
                }
                
                _ => Err(format!("Unsupported function: {:?}", func)),
            }
        }

        // EBV evaluation for bare variables: FILTER(?x)
        // This evaluates the Effective Boolean Value of the variable's binding
        Expression::Variable(v) => {
            let term = Term::Variable(v.as_str().to_string());
            let value_idx = push_hidden(hidden, "ebv_value", &term);
            let datatype_idx = push_hidden(hidden, "ebv_datatype", &term);
            Ok(format!(
                "ebv::ebv_unchecked(hidden[{}], hidden[{}])",
                value_idx, datatype_idx
            ))
        }

        // EBV evaluation for bare literals: FILTER("true"^^xsd:boolean)
        // This evaluates the Effective Boolean Value of the literal
        Expression::Literal(l) => {
            let dt = l.datatype().as_str();
            // Constant fold for boolean literals
            if dt.ends_with("boolean") {
                let val = match l.value() {
                    "true" | "1" => true,
                    "false" | "0" => false,
                    _ => return Err(format!("Invalid boolean literal: {}", l.value())),
                };
                return Ok(if val { "true" } else { "false" }.into());
            }
            // Constant fold for string literals (EBV is true for non-empty strings)
            if dt.ends_with("string") || dt == "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString" {
                let val = !l.value().is_empty();
                return Ok(if val { "true" } else { "false" }.into());
            }
            // Constant fold for numeric literals
            if dt.ends_with("integer") || dt.ends_with("decimal") || 
               dt.ends_with("float") || dt.ends_with("double") ||
               dt.ends_with("int") || dt.ends_with("long") || dt.ends_with("short") || dt.ends_with("byte") ||
               dt.ends_with("unsignedInt") || dt.ends_with("unsignedLong") || dt.ends_with("unsignedShort") || dt.ends_with("unsignedByte") ||
               dt.ends_with("positiveInteger") || dt.ends_with("negativeInteger") ||
               dt.ends_with("nonPositiveInteger") || dt.ends_with("nonNegativeInteger") {
                // For numeric types, parse and check if non-zero and non-NaN
                if let Ok(num) = l.value().parse::<f64>() {
                    let val = num != 0.0 && !num.is_nan();
                    return Ok(if val { "true" } else { "false" }.into());
                }
            }
            // For other datatypes, EBV is a type error - but we generate circuit code anyway
            // that will fail at runtime with a proper assertion
            let term = Term::Static(GroundTerm::Literal(l.clone()));
            let value_idx = push_hidden(hidden, "ebv_value", &term);
            let datatype_idx = push_hidden(hidden, "ebv_datatype", &term);
            Ok(format!(
                "ebv::ebv_unchecked(hidden[{}], hidden[{}])",
                value_idx, datatype_idx
            ))
        }

        _ => Err(format!("Unsupported filter expression: {:?}", expr)),
    }
}

fn type_check(
    arg: &Expression,
    type_code: i32,
    _query: &QueryInfo,
    _bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    let term = expr_to_term(arg)?;
    let idx = push_hidden(hidden, "term_to_field", &term);
    Ok(format!(
        "hidden[{}] == {}",
        idx, type_code
    ))
}

fn numeric_comparison(
    expr: &Expression,
    a: &Expression,
    b: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    // IEEE 754 constant folding for float/double literals
    if let (Expression::Literal(lit_a), Expression::Literal(lit_b)) = (a, b) {
        let dt_a = lit_a.datatype().as_str();
        let dt_b = lit_b.datatype().as_str();
        if (dt_a.ends_with("float") || dt_a.ends_with("double")) &&
           (dt_b.ends_with("float") || dt_b.ends_with("double")) {
            let fa = parse_float_special(lit_a.value(), dt_a);
            let fb = parse_float_special(lit_b.value(), dt_b);
            
            let result = match expr {
                Expression::Less(_, _) => ieee754_less_than(fa, fb),
                Expression::LessOrEqual(_, _) => {
                    match (ieee754_less_than(fa, fb), ieee754_equal(fa, fb)) {
                        (Some(lt), Some(eq)) => Some(lt || eq),
                        _ => None,
                    }
                }
                Expression::Greater(_, _) => ieee754_less_than(fb, fa),
                Expression::GreaterOrEqual(_, _) => {
                    match (ieee754_less_than(fb, fa), ieee754_equal(fa, fb)) {
                        (Some(gt), Some(eq)) => Some(gt || eq),
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

    // Try to convert to Noir code (handles function calls)
    let left_code = expr_to_noir_code(a, query, bindings, hidden)?;
    let right_code = expr_to_noir_code(b, query, bindings, hidden)?;

    let cmp = match expr {
        Expression::Greater(_, _) => format!("({} as i64) > ({} as i64)", left_code, right_code),
        Expression::GreaterOrEqual(_, _) => format!("({} as i64) >= ({} as i64)", left_code, right_code),
        Expression::Less(_, _) => format!("({} as i64) < ({} as i64)", left_code, right_code),
        Expression::LessOrEqual(_, _) => format!("({} as i64) <= ({} as i64)", left_code, right_code),
        _ => return Err("Invalid comparison operator".into()),
    };

    Ok(cmp)
}

fn string_comparison(
    expr: &Expression,
    a: &Expression,
    b: &Expression,
    _query: &QueryInfo,
    _bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    let left = expr_to_term(a)?;
    let right = expr_to_term(b)?;
    let cmp_idx = push_hidden_comparison(hidden, "string_compare", &left, &right);

    let constraint = match expr {
        Expression::Less(_, _) => format!("hidden[{}] == -1", cmp_idx),
        Expression::LessOrEqual(_, _) => format!("(hidden[{}] == -1) | (hidden[{}] == 0)", cmp_idx, cmp_idx),
        Expression::Greater(_, _) => format!("hidden[{}] == 1", cmp_idx),
        Expression::GreaterOrEqual(_, _) => format!("(hidden[{}] == 1) | (hidden[{}] == 0)", cmp_idx, cmp_idx),
        _ => return Err("Invalid comparison operator".into()),
    };

    Ok(constraint)
}

fn boolean_comparison(
    expr: &Expression,
    a: &Expression,
    b: &Expression,
    _query: &QueryInfo,
    _bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    fn extract_bool(e: &Expression) -> Option<bool> {
        if let Expression::Literal(l) = e {
            if l.datatype().as_str().ends_with("boolean") {
                return match l.value() {
                    "true" | "1" => Some(true),
                    "false" | "0" => Some(false),
                    _ => None,
                };
            }
        }
        None
    }

    if let (Some(left_val), Some(right_val)) = (extract_bool(a), extract_bool(b)) {
        let result = match expr {
            Expression::Less(_, _) => !left_val && right_val,
            Expression::LessOrEqual(_, _) => !left_val || right_val,
            Expression::Greater(_, _) => left_val && !right_val,
            Expression::GreaterOrEqual(_, _) => left_val || !right_val,
            _ => return Err("Invalid comparison operator".into()),
        };
        return Ok(if result { "true" } else { "false" }.into());
    }

    let left = expr_to_term(a)?;
    let right = expr_to_term(b)?;
    let left_idx = push_hidden(hidden, "boolean_value", &left);
    let right_idx = push_hidden(hidden, "boolean_value", &right);

    let cmp = match expr {
        Expression::Less(_, _) => format!("(hidden[{}] as i64) < (hidden[{}] as i64)", left_idx, right_idx),
        Expression::LessOrEqual(_, _) => format!("(hidden[{}] as i64) <= (hidden[{}] as i64)", left_idx, right_idx),
        Expression::Greater(_, _) => format!("(hidden[{}] as i64) > (hidden[{}] as i64)", left_idx, right_idx),
        Expression::GreaterOrEqual(_, _) => format!("(hidden[{}] as i64) >= (hidden[{}] as i64)", left_idx, right_idx),
        _ => return Err("Invalid comparison operator".into()),
    };

    Ok(cmp)
}

fn datetime_comparison(
    expr: &Expression,
    a: &Expression,
    b: &Expression,
    _query: &QueryInfo,
    _bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    let left = expr_to_term(a)?;
    let right = expr_to_term(b)?;
    let left_idx = push_hidden(hidden, "datetime_value", &left);
    let right_idx = push_hidden(hidden, "datetime_value", &right);

    let cmp = match expr {
        Expression::Less(_, _) => format!("(hidden[{}] as i64) < (hidden[{}] as i64)", left_idx, right_idx),
        Expression::LessOrEqual(_, _) => format!("(hidden[{}] as i64) <= (hidden[{}] as i64)", left_idx, right_idx),
        Expression::Greater(_, _) => format!("(hidden[{}] as i64) > (hidden[{}] as i64)", left_idx, right_idx),
        Expression::GreaterOrEqual(_, _) => format!("(hidden[{}] as i64) >= (hidden[{}] as i64)", left_idx, right_idx),
        _ => return Err("Invalid comparison operator".into()),
    };

    Ok(cmp)
}

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

static VAR_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn fresh_variable() -> TermPattern {
    let id = VAR_COUNTER.fetch_add(1, Ordering::SeqCst);
    TermPattern::Variable(Variable::new_unchecked(format!("__v{}", id)))
}

fn process_patterns(patterns: &[TriplePattern]) -> Result<PatternInfo, String> {
    process_patterns_with_graph(patterns, GraphContext::Default)
}

fn process_patterns_with_graph(patterns: &[TriplePattern], graph: GraphContext) -> Result<PatternInfo, String> {
    let mut info = PatternInfo::new();
    let mut seen_vars: BTreeSet<String> = BTreeSet::new();

    for (i, pattern) in patterns.iter().enumerate() {
        info.patterns.push(ContextualizedTriple {
            pattern: pattern.clone(),
            graph: graph.clone(),
        });

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
                    // Already seen - add equality assertion
                    info.assertions.push(Assertion(
                        Term::Variable(name),
                        Term::Input(i, 0),
                    ));
                } else {
                    seen_vars.insert(name.clone());
                    info.bindings.push(Binding {
                        variable: name,
                        term: Term::Input(i, 0),
                    });
                }
            }
            TermPattern::BlankNode(bn) => {
                // Treat blank nodes as internal variables (not projected)
                // Use a special prefix to distinguish from user variables
                let name = format!("__blank_{}", bn.as_str());
                if seen_vars.contains(&name) {
                    // Already seen - need to assert this position equals the first binding
                    info.assertions.push(Assertion(
                        Term::Variable(name),
                        Term::Input(i, 0),
                    ));
                } else {
                    seen_vars.insert(name.clone());
                    info.bindings.push(Binding {
                        variable: name,
                        term: Term::Input(i, 0),
                    });
                }
            }
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
                if !seen_vars.contains(&name) {
                    seen_vars.insert(name.clone());
                    info.bindings.push(Binding {
                        variable: name,
                        term: Term::Input(i, 1),
                    });
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
                    // Already seen - add equality assertion
                    info.assertions.push(Assertion(
                        Term::Variable(name),
                        Term::Input(i, 2),
                    ));
                } else {
                    seen_vars.insert(name.clone());
                    info.bindings.push(Binding {
                        variable: name,
                        term: Term::Input(i, 2),
                    });
                }
            }
            TermPattern::BlankNode(bn) => {
                // Treat blank nodes as internal variables (not projected)
                let name = format!("__blank_{}", bn.as_str());
                if seen_vars.contains(&name) {
                    // Already seen - need to assert this position equals the first binding
                    info.assertions.push(Assertion(
                        Term::Variable(name),
                        Term::Input(i, 2),
                    ));
                } else {
                    seen_vars.insert(name.clone());
                    info.bindings.push(Binding {
                        variable: name,
                        term: Term::Input(i, 2),
                    });
                }
            }
        }
    }

    Ok(info)
}

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
            let zero = if let TermPattern::Variable(sv) = subject {
                GraphPattern::Extend {
                    inner: Box::new(GraphPattern::Bgp { patterns: vec![] }),
                    variable: sv.clone(),
                    expression: if let TermPattern::Variable(ov) = object {
                        Expression::Variable(ov.clone())
                    } else {
                        return Err("ZeroOrOne requires variable object".into());
                    },
                }
            } else if let TermPattern::Variable(ov) = object {
                GraphPattern::Extend {
                    inner: Box::new(GraphPattern::Bgp { patterns: vec![] }),
                    variable: ov.clone(),
                    expression: if let TermPattern::NamedNode(nn) = subject {
                        Expression::NamedNode(nn.clone())
                    } else {
                        return Err("ZeroOrOne requires named node subject".into());
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

/// Helper to adjust input indices in an optional block by an offset
fn adjust_optional_block_indices(block: &mut OptionalBlock, offset: usize) {
    // Adjust bindings
    for binding in &mut block.bindings {
        if let Term::Input(i, j) = &binding.term {
            binding.term = Term::Input(*i + offset, *j);
        }
    }
    
    // Adjust assertions
    for assertion in &mut block.assertions {
        if let Term::Input(i, j) = &assertion.0 {
            assertion.0 = Term::Input(*i + offset, *j);
        }
        if let Term::Input(i, j) = &assertion.1 {
            assertion.1 = Term::Input(*i + offset, *j);
        }
    }
    
    // Recursively adjust nested optionals
    for nested in &mut block.nested_optionals {
        adjust_optional_block_indices(nested, offset);
    }
}

fn process_graph_pattern(gp: &GraphPattern) -> Result<PatternInfo, String> {
    match gp {
        GraphPattern::Bgp { patterns } => process_patterns(patterns),

        GraphPattern::Path { subject, path, object } => {
            let expanded = expand_path(subject, path, object)?;
            process_graph_pattern(&expanded)
        }

        GraphPattern::Join { left, right } => {
            let left_info = process_graph_pattern(left)?;
            let right_info = process_graph_pattern(right)?;
            
            let offset = left_info.patterns.len();
            let mut merged = PatternInfo::new();
            
            merged.patterns.extend(left_info.patterns);
            merged.patterns.extend(right_info.patterns);
            
            merged.bindings.extend(left_info.bindings);
            for binding in right_info.bindings {
                let adjusted_term = match binding.term {
                    Term::Input(i, j) => Term::Input(i + offset, j),
                    other => other,
                };
                merged.bindings.push(Binding {
                    variable: binding.variable,
                    term: adjusted_term,
                });
            }
            
            merged.assertions.extend(left_info.assertions);
            for assertion in right_info.assertions {
                let adj_left = match assertion.0 {
                    Term::Input(i, j) => Term::Input(i + offset, j),
                    other => other,
                };
                let adj_right = match assertion.1 {
                    Term::Input(i, j) => Term::Input(i + offset, j),
                    other => other,
                };
                merged.assertions.push(Assertion(adj_left, adj_right));
            }
            
            merged.filters.extend(left_info.filters);
            merged.filters.extend(right_info.filters);
            
            if left_info.union_branches.is_some() || right_info.union_branches.is_some() {
                merged.union_branches = left_info.union_branches.or(right_info.union_branches);
            }
            
            // Merge optional blocks, adjusting indices for the right side's blocks
            merged.optional_blocks.extend(left_info.optional_blocks);
            for mut opt_block in right_info.optional_blocks {
                adjust_optional_block_indices(&mut opt_block, offset);
                merged.optional_blocks.push(opt_block);
            }
            
            Ok(merged)
        }

        GraphPattern::Filter { expr, inner } => {
            let mut info = process_graph_pattern(inner)?;
            info.filters.push(expr.clone());
            Ok(info)
        }

        GraphPattern::Extend { inner, variable, expression } => {
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

        GraphPattern::LeftJoin { left, right, expression } => {
            // Process the left (required) side
            let mut left_info = process_graph_pattern(left)?;
            // Process the right (optional) side
            let right_info = process_graph_pattern(right)?;
            
            // Calculate the offset for adjusting input indices in the optional block
            let offset = left_info.patterns.len();
            
            // Create an OptionalBlock for the right side
            let optional_id = next_optional_id();
            
            // Adjust input indices in the right side's bindings and assertions
            let adjusted_bindings: Vec<Binding> = right_info.bindings.into_iter().map(|b| {
                Binding {
                    variable: b.variable,
                    term: match b.term {
                        Term::Input(i, j) => Term::Input(i + offset, j),
                        other => other,
                    },
                }
            }).collect();
            
            let adjusted_assertions: Vec<Assertion> = right_info.assertions.into_iter().map(|a| {
                let adj_l = match a.0 {
                    Term::Input(i, j) => Term::Input(i + offset, j),
                    other => other,
                };
                let adj_r = match a.1 {
                    Term::Input(i, j) => Term::Input(i + offset, j),
                    other => other,
                };
                Assertion(adj_l, adj_r)
            }).collect();
            
            // Include the optional filter expression if present
            let mut optional_filters = right_info.filters;
            if let Some(expr) = expression {
                optional_filters.push(expr.clone());
            }
            
            // Adjust nested optional blocks from the right side
            let adjusted_nested = right_info.optional_blocks.into_iter().map(|mut ob| {
                adjust_optional_block_indices(&mut ob, offset);
                ob
            }).collect();
            
            let optional_block = OptionalBlock {
                id: optional_id,
                patterns: right_info.patterns,
                bindings: adjusted_bindings,
                assertions: adjusted_assertions,
                filters: optional_filters,
                nested_optionals: adjusted_nested,
            };
            
            // Add the optional block to the left side's info
            left_info.optional_blocks.push(optional_block);
            
            // Also inherit any optional blocks from the left side
            // (they're already at the right indices)
            
            Ok(left_info)
        }

        GraphPattern::Union { left, right } => {
            fn collect_branches(gp: &GraphPattern, out: &mut Vec<PatternInfo>) -> Result<(), String> {
                match gp {
                    GraphPattern::Union { left, right } => {
                        collect_branches(left, out)?;
                        collect_branches(right, out)?;
                    }
                    _ => {
                        out.push(process_graph_pattern(gp)?);
                    }
                }
                Ok(())
            }

            let mut branches: Vec<PatternInfo> = Vec::new();
            collect_branches(left, &mut branches)?;
            collect_branches(right, &mut branches)?;

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
                optional_blocks: Vec::new(),
            })
        }

        GraphPattern::Graph { name, inner } => {
            let mut info = process_graph_pattern(inner)?;
            
            let graph_context = match name {
                NamedNodePattern::NamedNode(nn) => GraphContext::NamedNode(nn.as_str().to_string()),
                NamedNodePattern::Variable(v) => GraphContext::Variable(v.as_str().to_string()),
            };
            
            for pattern in &mut info.patterns {
                pattern.graph = graph_context.clone();
            }
            
            match name {
                NamedNodePattern::NamedNode(nn) => {
                    for i in 0..info.patterns.len() {
                        info.assertions.push(Assertion(
                            Term::Static(GroundTerm::NamedNode(nn.clone())),
                            Term::Input(i, 3),
                        ));
                    }
                }
                NamedNodePattern::Variable(v) => {
                    let var_name = v.as_str().to_string();
                    if !info.patterns.is_empty() {
                        info.bindings.push(Binding {
                            variable: var_name.clone(),
                            term: Term::Input(0, 3),
                        });
                        for i in 1..info.patterns.len() {
                            info.assertions.push(Assertion(
                                Term::Variable(var_name.clone()),
                                Term::Input(i, 3),
                            ));
                        }
                    }
                }
            }
            Ok(info)
        }

        // Post-processing modifiers - we accept them but don't enforce in circuit
        // These should be handled by the verifier/prover outside the ZK circuit
        GraphPattern::Distinct { inner } => {
            // DISTINCT: uniqueness can be verified by the verifier
            process_graph_pattern(inner)
        }

        GraphPattern::Reduced { inner } => {
            // REDUCED: similar to DISTINCT but allows duplicates
            process_graph_pattern(inner)
        }

        GraphPattern::OrderBy { inner, .. } => {
            // ORDER BY: sorting can be done after proof verification
            process_graph_pattern(inner)
        }

        GraphPattern::Slice { inner, .. } => {
            // LIMIT/OFFSET: can be applied to verified results
            process_graph_pattern(inner)
        }

        _ => Err(format!("Unsupported graph pattern: {:?}", gp)),
    }
}

fn process_query(gp: &GraphPattern) -> Result<QueryInfo, String> {
    // Unwrap post-processing modifiers (DISTINCT, ORDER BY, LIMIT/OFFSET)
    // These are accepted but not enforced in the circuit
    let mut inner = gp;
    loop {
        inner = match inner {
            GraphPattern::Distinct { inner: i } => i,
            GraphPattern::Reduced { inner: i } => i,
            GraphPattern::OrderBy { inner: i, .. } => i,
            GraphPattern::Slice { inner: i, .. } => i,
            _ => break,
        };
    }
    
    match inner {
        GraphPattern::Project { inner, variables } => {
            let vars: Vec<String> = variables.iter().map(|v| v.as_str().to_string()).collect();
            let pattern = process_graph_pattern(inner)?;
            Ok(QueryInfo { variables: vars, pattern })
        }
        // ASK queries don't have PROJECT - they just check if a pattern matches
        // For ASK, we treat it as projecting all variables in the pattern
        _ => {
            let pattern = process_graph_pattern(inner)?;
            // Collect all variables from bindings
            let mut vars: Vec<String> = pattern.bindings.iter()
                .map(|b| b.variable.clone())
                .collect();
            vars.sort();
            vars.dedup();
            Ok(QueryInfo { variables: vars, pattern })
        }
    }
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

fn contextualized_pattern_to_json(ct: &ContextualizedTriple) -> serde_json::Value {
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
) -> Result<(String, Vec<serde_json::Value>, bool), String> {
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
fn generate_sparql_nr_from_query_info(
    info: &QueryInfo,
    options: &TransformOptions,
) -> Result<(String, Vec<serde_json::Value>, bool), String> {
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

    Ok((sparql_nr, hidden, has_hidden))
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

    // Collect all optional blocks (flatten nested optionals for now)
    let all_optionals = collect_all_optional_blocks(&info.pattern.optional_blocks);
    let num_optionals = all_optionals.len();
    
    // Generate the base circuit (no optionals or all optionals matched based on strategy)
    // We'll generate the "all optionals matched" case as the primary circuit
    let (base_sparql_nr, base_hidden, has_hidden) = generate_circuit_for_optional_combination(
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
            
            let (circuit_sparql_nr, circuit_hidden, _) = generate_circuit_for_optional_combination(
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
