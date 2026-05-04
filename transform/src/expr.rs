//! SPARQL expression conversion to Noir circuit code.
//!
//! Owns:
//! - IEEE 754 float-handling primitives (constant-folding for `xsd:float` /
//!   `xsd:double` literals).
//! - Term serialisation: turning [`Term`]s and [`GroundTerm`]s into the
//!   inline Noir source they are referenced as inside `checkBinding`.
//! - XSD type-casting expansion (`xsd:integer(?v)`, `xsd:double(?v)` …).
//! - Filter / expression rewriting: numeric / string / boolean / dateTime
//!   comparisons, EBV evaluation, function calls (LANG, STR, DATATYPE,
//!   isIRI, LANGMATCHES, ABS, ROUND, YEAR …).
//! - The `hidden[]` push helpers used to thread auxiliary inputs through
//!   to the verifier.

use std::collections::BTreeMap;

use spargebra::algebra::{Expression, Function};
use spargebra::term::GroundTerm;

use crate::metadata::ground_term_to_json;
use crate::{QueryInfo, Term};

// =============================================================================
// CONSTANTS
// =============================================================================

const XSD: &str = "http://www.w3.org/2001/XMLSchema#";

// =============================================================================
// IEEE 754 FLOAT HANDLING
// =============================================================================

/// A constant-folded IEEE 754 literal. The `Normal` variant stores the
/// IEEE 754 bit pattern as an unsigned integer at the operand's
/// natural width — `u32` for `xsd:float` (binary32), `u64` for
/// `xsd:double` (binary64). Specials carry their sign explicitly so
/// the comparator does not need to inspect bit patterns.
///
/// Width is preserved because IEEE 754 ordering depends on the width:
/// the bit pattern `0x40000000` is `+2.0f32`, but `0x40000000` as f64
/// is the subnormal `1.99e-308`. Conflating widths makes constant-
/// folding subtly wrong (audit item 6, sparql_noir #37 row).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FloatSpecial {
    /// `xsd:float` (binary32) bit pattern.
    NormalF32(u32),
    /// `xsd:double` (binary64) bit pattern.
    NormalF64(u64),
    NaN,
    PositiveInf,
    NegativeInf,
    PositiveZero,
    NegativeZero,
}

/// Parse a `xsd:float` / `xsd:double` literal into a [`FloatSpecial`],
/// dispatching on `datatype` so `xsd:float` is rounded to f32
/// precision (binary32) and `xsd:double` stays at f64 precision
/// (binary64). Other datatypes default to f64 — callers are expected
/// to gate on `datatype.ends_with("float" | "double")` before calling.
fn parse_float_special(value: &str, datatype: &str) -> FloatSpecial {
    let v = value.trim();
    if v == "NaN" {
        return FloatSpecial::NaN;
    }
    if v == "INF" || v == "+INF" {
        return FloatSpecial::PositiveInf;
    }
    if v == "-INF" {
        return FloatSpecial::NegativeInf;
    }
    // The `+0` / `-0` lexical forms are special-cased so the
    // signed-zero distinction survives constant folding.
    if v == "0" || v == "0.0" || v == "+0" || v == "+0.0" {
        return FloatSpecial::PositiveZero;
    }
    if v == "-0" || v == "-0.0" {
        return FloatSpecial::NegativeZero;
    }

    let is_float = datatype.ends_with("float");
    if is_float {
        match v.parse::<f32>() {
            Ok(f) if f.is_nan() => FloatSpecial::NaN,
            Ok(f) if f.is_infinite() => {
                if f.is_sign_positive() {
                    FloatSpecial::PositiveInf
                } else {
                    FloatSpecial::NegativeInf
                }
            }
            Ok(f) if f == 0.0_f32 => {
                if f.is_sign_negative() {
                    FloatSpecial::NegativeZero
                } else {
                    FloatSpecial::PositiveZero
                }
            }
            Ok(f) => FloatSpecial::NormalF32(f.to_bits()),
            Err(_) => FloatSpecial::NaN,
        }
    } else {
        // Default + xsd:double path — binary64.
        match v.parse::<f64>() {
            Ok(f) if f.is_nan() => FloatSpecial::NaN,
            Ok(f) if f.is_infinite() => {
                if f.is_sign_positive() {
                    FloatSpecial::PositiveInf
                } else {
                    FloatSpecial::NegativeInf
                }
            }
            Ok(f) if f == 0.0_f64 => {
                if f.is_sign_negative() {
                    FloatSpecial::NegativeZero
                } else {
                    FloatSpecial::PositiveZero
                }
            }
            Ok(f) => FloatSpecial::NormalF64(f.to_bits()),
            Err(_) => FloatSpecial::NaN,
        }
    }
}

/// Sign-aware IEEE 754 magnitude comparator for two same-width
/// `Normal*` values. Returns `Some(true)` iff the first operand is
/// strictly less than the second under standard IEEE 754 ordering
/// (where `-x < -y` iff `|x| > |y|`).
///
/// The trick is that bit patterns aren't a total order: positive
/// values sort by ascending bit pattern, negative values by
/// descending bit pattern (sign-magnitude). Comparing as signed
/// integers (the previous implementation) is wrong because
/// `bits(-2.0)` as a signed integer is *less negative* than
/// `bits(-1.0)` (audit item 7, sparql_noir #37 row).
fn ieee754_normal_lt(a_bits_unsigned: u64, b_bits_unsigned: u64, sign_bit: u64) -> bool {
    let a_neg = (a_bits_unsigned & sign_bit) != 0;
    let b_neg = (b_bits_unsigned & sign_bit) != 0;
    match (a_neg, b_neg) {
        (false, false) => a_bits_unsigned < b_bits_unsigned,
        (true, true) => a_bits_unsigned > b_bits_unsigned,
        (true, false) => true,  // any negative < any positive
        (false, true) => false, // any positive >= any negative
    }
}

fn float_normal_lt(a: FloatSpecial, b: FloatSpecial) -> Option<bool> {
    match (a, b) {
        (FloatSpecial::NormalF32(x), FloatSpecial::NormalF32(y)) => {
            Some(ieee754_normal_lt(x as u64, y as u64, 0x8000_0000))
        }
        (FloatSpecial::NormalF64(x), FloatSpecial::NormalF64(y)) => {
            Some(ieee754_normal_lt(x, y, 0x8000_0000_0000_0000))
        }
        // Mixed widths shouldn't be hit because the caller gates on
        // both operands having the same datatype, but if it ever is,
        // promote the f32 to f64 and recompare.
        (FloatSpecial::NormalF32(x), FloatSpecial::NormalF64(y)) => {
            let x_f64 = f32::from_bits(x) as f64;
            Some(ieee754_normal_lt(x_f64.to_bits(), y, 0x8000_0000_0000_0000))
        }
        (FloatSpecial::NormalF64(x), FloatSpecial::NormalF32(y)) => {
            let y_f64 = f32::from_bits(y) as f64;
            Some(ieee754_normal_lt(x, y_f64.to_bits(), 0x8000_0000_0000_0000))
        }
        _ => None,
    }
}

fn float_is_negative_normal(a: FloatSpecial) -> bool {
    match a {
        FloatSpecial::NormalF32(x) => (x & 0x8000_0000) != 0,
        FloatSpecial::NormalF64(x) => (x & 0x8000_0000_0000_0000) != 0,
        _ => false,
    }
}

fn float_normal_eq_zero(a: FloatSpecial) -> bool {
    matches!(a, FloatSpecial::NormalF32(0) | FloatSpecial::NormalF32(0x8000_0000)
        | FloatSpecial::NormalF64(0) | FloatSpecial::NormalF64(0x8000_0000_0000_0000))
}

pub fn ieee754_less_than(a: FloatSpecial, b: FloatSpecial) -> Option<bool> {
    use FloatSpecial::*;
    match (a, b) {
        (NaN, _) | (_, NaN) => Some(false),
        (NegativeInf, NegativeInf) => Some(false),
        (NegativeInf, _) => Some(true),
        (_, NegativeInf) => Some(false),
        (PositiveInf, PositiveInf) => Some(false),
        (PositiveInf, _) => Some(false),
        (_, PositiveInf) => Some(true),
        // SPARQL value-equality treats +0 and -0 as equal, so neither
        // is strictly less than the other.
        (PositiveZero, NegativeZero) | (NegativeZero, PositiveZero) => Some(false),
        (PositiveZero, PositiveZero) | (NegativeZero, NegativeZero) => Some(false),
        (NormalF32(_) | NormalF64(_), NormalF32(_) | NormalF64(_)) => float_normal_lt(a, b),
        // Zero vs Normal — Normal is not zero, so the comparison
        // reduces to whether `b` is positive (a < b) or `a` is
        // negative (a < b).
        (PositiveZero | NegativeZero, NormalF32(_) | NormalF64(_)) => {
            // a == 0 < b iff b is positive (and not zero, which
            // can't happen for a Normal pattern of non-zero value).
            // Note: `NormalF32(0)` would represent `+0.0` lexically;
            // the parser routes those to PositiveZero, but a malformed
            // input could land here. Treat such patterns as equal-
            // to-zero, hence not strictly greater.
            if float_normal_eq_zero(b) {
                Some(false)
            } else {
                Some(!float_is_negative_normal(b))
            }
        }
        (NormalF32(_) | NormalF64(_), PositiveZero | NegativeZero) => {
            if float_normal_eq_zero(a) {
                Some(false)
            } else {
                Some(float_is_negative_normal(a))
            }
        }
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
        // SPARQL value-equality: +0 == -0.
        (PositiveZero, NegativeZero) | (NegativeZero, PositiveZero) => Some(true),
        (PositiveZero, PositiveZero) | (NegativeZero, NegativeZero) => Some(true),
        (NormalF32(x), NormalF32(y)) => Some(x == y),
        (NormalF64(x), NormalF64(y)) => Some(x == y),
        // Mixed widths — promote f32 to f64 (lossless) and compare.
        (NormalF32(x), NormalF64(y)) => Some((f32::from_bits(x) as f64).to_bits() == y),
        (NormalF64(x), NormalF32(y)) => Some(x == (f32::from_bits(y) as f64).to_bits()),
        (PositiveZero | NegativeZero, NormalF32(_) | NormalF64(_)) => Some(float_normal_eq_zero(b)),
        (NormalF32(_) | NormalF64(_), PositiveZero | NegativeZero) => Some(float_normal_eq_zero(a)),
    }
}

#[cfg(test)]
mod ieee754_tests {
    use super::*;

    #[test]
    fn parse_xsd_float_uses_binary32() {
        // 0.1 + 0.2 in f32 vs f64 differ. The bit pattern of 0.1f32
        // is 0x3DCCCCCD; the bit pattern of 0.1f64 is 0x3FB999999999999A.
        let f = parse_float_special("0.1", "http://www.w3.org/2001/XMLSchema#float");
        let d = parse_float_special("0.1", "http://www.w3.org/2001/XMLSchema#double");
        match (f, d) {
            (FloatSpecial::NormalF32(fb), FloatSpecial::NormalF64(db)) => {
                assert_eq!(fb, 0.1_f32.to_bits(), "xsd:float must round to binary32");
                assert_eq!(db, 0.1_f64.to_bits(), "xsd:double must stay binary64");
                // Distinct bit patterns prove the dispatch is real.
                assert_ne!(fb as u64, db, "f32 and f64 of 0.1 must differ");
            }
            _ => panic!("expected NormalF32 + NormalF64 from parse_float_special"),
        }
    }

    #[test]
    fn negative_normals_compare_by_magnitude() {
        // -2.0 < -1.0 must be true (the previous signed-i64 path
        // returned the wrong answer here — audit item 7).
        let neg2 = parse_float_special("-2.0", "http://www.w3.org/2001/XMLSchema#double");
        let neg1 = parse_float_special("-1.0", "http://www.w3.org/2001/XMLSchema#double");
        assert_eq!(ieee754_less_than(neg2, neg1), Some(true), "-2.0 < -1.0");
        assert_eq!(ieee754_less_than(neg1, neg2), Some(false), "!(-1.0 < -2.0)");
    }

    #[test]
    fn negative_normal_less_than_positive_normal() {
        let neg = parse_float_special("-1.5", "http://www.w3.org/2001/XMLSchema#double");
        let pos = parse_float_special("1.5", "http://www.w3.org/2001/XMLSchema#double");
        assert_eq!(ieee754_less_than(neg, pos), Some(true));
        assert_eq!(ieee754_less_than(pos, neg), Some(false));
    }

    #[test]
    fn signed_zeros_compare_equal() {
        let pz = parse_float_special("+0.0", "http://www.w3.org/2001/XMLSchema#double");
        let nz = parse_float_special("-0.0", "http://www.w3.org/2001/XMLSchema#double");
        assert_eq!(ieee754_equal(pz, nz), Some(true));
        assert_eq!(ieee754_less_than(pz, nz), Some(false));
        assert_eq!(ieee754_less_than(nz, pz), Some(false));
    }

    #[test]
    fn nan_is_unordered() {
        let nan = parse_float_special("NaN", "http://www.w3.org/2001/XMLSchema#double");
        let one = parse_float_special("1.0", "http://www.w3.org/2001/XMLSchema#double");
        assert_eq!(ieee754_less_than(nan, one), Some(false));
        assert_eq!(ieee754_less_than(one, nan), Some(false));
        assert_eq!(ieee754_equal(nan, one), Some(false));
        assert_eq!(ieee754_equal(nan, nan), Some(false));
    }

    #[test]
    fn infinity_orders_at_extremes() {
        let pinf = parse_float_special("INF", "http://www.w3.org/2001/XMLSchema#double");
        let ninf = parse_float_special("-INF", "http://www.w3.org/2001/XMLSchema#double");
        let one = parse_float_special("1.0", "http://www.w3.org/2001/XMLSchema#double");
        assert_eq!(ieee754_less_than(ninf, one), Some(true));
        assert_eq!(ieee754_less_than(one, pinf), Some(true));
        assert_eq!(ieee754_less_than(ninf, pinf), Some(true));
        assert_eq!(ieee754_less_than(pinf, ninf), Some(false));
    }

    #[test]
    fn float_subnormals_round_to_binary32() {
        // 1e-50 is representable in f64 but underflows to 0 in f32.
        let f = parse_float_special("1e-50", "http://www.w3.org/2001/XMLSchema#float");
        // After f32 rounding 1e-50 becomes 0.0, which the parser
        // then routes to PositiveZero.
        assert_eq!(f, FloatSpecial::PositiveZero);
    }
}

// =============================================================================
// TERM SERIALIZATION
// =============================================================================

fn encode_string_expr(s: &str) -> String {
    // Use consts::encode_string since consts is always available (even in skip-signing mode)
    format!("consts::encode_string(\"{}\")", s.replace('\\', "\\\\").replace('"', "\\\""))
}

pub(crate) fn serialize_term(term: &Term, query: &QueryInfo, bindings: &BTreeMap<String, Term>) -> String {
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
            // The bounded byte-array witness redesign means each term
            // slot is now a `TermWitness { hash, bytes, length }`. BGP
            // matching / FILTER equality only ever needs the term's
            // identity, which is the `hash` field -- see
            // `spec/encoding.md` sec.6.6 (compatibility) for the rationale.
            format!("bgp[{}].terms[{}].hash", triple_idx, term_idx)
        }
        Term::Static(gt) => serialize_ground_term(gt),
        // Default graph term — must hash with term-type tag `4` to
        // match the signer's `getTermEncodingString` for
        // `quad.graph: DefaultGraph` (`src/encode.ts:11`). Encoding it
        // as a `NamedNode("")` would land at term-type tag `0` and
        // create the soundness mismatch flagged by roborev:
        // a default-graph quad present in the dataset could be
        // proven absent because the circuit's absent-hash uses tag 0
        // while the signer's leaf hash uses tag 4. The empty-string
        // payload mirrors RDF.js's `DefaultGraph.value === ""`.
        Term::DefaultGraph => format!("consts::hash2([4, {}])", encode_string_expr("")),
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
// XSD TYPE CASTING
// =============================================================================

/// Handle XSD type casting functions like xsd:integer(?v), xsd:float(?v), etc.
/// These map to xpath casting functions from noir_xpath library.
fn handle_xsd_cast(
    target_type: &str,
    args: &[Expression],
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    if args.len() != 1 {
        return Err(format!("xsd:{} cast requires exactly 1 argument", target_type));
    }
    
    // Get the source expression value
    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
    
    // Determine source type if we can (for choosing the right cast function)
    let source_type = infer_expression_type(&args[0]);
    
    match target_type {
        // Cast to xsd:integer
        "integer" | "int" | "long" | "short" | "byte" |
        "unsignedInt" | "unsignedLong" | "unsignedShort" | "unsignedByte" |
        "positiveInteger" | "negativeInteger" | "nonPositiveInteger" | "nonNegativeInteger" => {
            match source_type {
                Some(NumericSourceType::Float) => {
                    // cast_float_to_integer returns Option<i64>; assert success before unwrap
                    Ok(format!(
                        "{{ let tmp = xpath::cast_float_to_integer(xpath::XsdFloat::from_bits({} as u32)); assert(tmp.is_some()); tmp.unwrap() as Field }}",
                        arg_code
                    ))
                }
                Some(NumericSourceType::Double) => {
                    // cast_double_to_integer returns Option<i64>; assert success before unwrap
                    Ok(format!(
                        "{{ let tmp = xpath::cast_double_to_integer(xpath::XsdDouble::from_bits({} as u64)); assert(tmp.is_some()); tmp.unwrap() as Field }}",
                        arg_code
                    ))
                }
                Some(NumericSourceType::Integer) | None => {
                    // Already integer or unknown - just pass through as Field
                    Ok(format!("{} as Field", arg_code))
                }
            }
        }
        
        // Cast to xsd:float
        "float" => {
            match source_type {
                Some(NumericSourceType::Integer) => {
                    // cast_integer_to_float takes a signed integer (use i64 to avoid truncation)
                    // Convert to bits for Field representation
                    Ok(format!("xpath::cast_integer_to_float(({}) as i64).to_bits() as Field", arg_code))
                }
                Some(NumericSourceType::Double) => {
                    // cast_double_to_float
                    Ok(format!("xpath::cast_double_to_float(xpath::XsdDouble::from_bits({} as u64)).to_bits() as Field", arg_code))
                }
                Some(NumericSourceType::Float) | None => {
                    // Already float or unknown - pass through
                    Ok(format!("{}", arg_code))
                }
            }
        }
        
        // Cast to xsd:double
        "double" => {
            match source_type {
                Some(NumericSourceType::Integer) => {
                    // cast_integer_to_double takes i64 to avoid truncation
                    Ok(format!("xpath::cast_integer_to_double(({}) as i64).to_bits() as Field", arg_code))
                }
                Some(NumericSourceType::Float) => {
                    // XsdDouble::from_float for float to double
                    Ok(format!("xpath::XsdDouble::from_float(xpath::XsdFloat::from_bits({} as u32)).to_bits() as Field", arg_code))
                }
                Some(NumericSourceType::Double) | None => {
                    // Already double or unknown - pass through
                    Ok(format!("{}", arg_code))
                }
            }
        }
        
        // Cast to xsd:decimal - treat like double for now
        "decimal" => {
            match source_type {
                Some(NumericSourceType::Integer) => {
                    Ok(format!("xpath::cast_integer_to_double(({}) as i64).to_bits() as Field", arg_code))
                }
                _ => Ok(format!("{}", arg_code))
            }
        }
        
        // Cast to xsd:boolean
        "boolean" => {
            // XSD boolean cast from numerics only permits 0 and 1:
            // 0 -> false, 1 -> true. Other numeric values are invalid.
            // Generate Noir code that enforces this at runtime via an assertion.
            Ok(format!("{{ let v = {}; assert(v == 0 || v == 1); v == 1 }}", arg_code))
        }
        
        // Cast to xsd:string - returns the encoded string representation
        "string" | "normalizedString" | "token" => {
            // String cast preserves the lexical value.
            // For numeric types, proper lexical conversion (e.g., 42 -> "42")
            // is not implemented in the generated Noir circuits.
            // To avoid silently incorrect behavior, we reject numeric→string casts.
            match source_type {
                Some(_) => Err(
                    "Casting numeric types to xsd:string (or derived types) is not supported by the transformer"
                        .to_string(),
                ),
                None => Ok(format!("{}", arg_code)),
            }
        }
        
        // Cast to xsd:dateTime
        "dateTime" => {
            // DateTime values are typically epoch milliseconds
            // Assuming input is already in correct format
            Ok(format!("{}", arg_code))
        }
        
        // Cast to xsd:date
        "date" => {
            Ok(format!("{}", arg_code))
        }
        
        // Cast to xsd:time
        "time" => {
            Ok(format!("{}", arg_code))
        }
        
        // Unsupported cast target
        _ => Err(format!("Unsupported XSD cast target type: xsd:{}", target_type))
    }
}

/// Source type for determining which cast function to use
#[derive(Clone, Copy, Debug, PartialEq)]
enum NumericSourceType {
    Integer,
    Float,
    Double,
}

/// Infer the numeric type of an expression based on its structure.
///
/// Used by the type-promotion logic to choose the IEEE 754 / integer
/// path for arithmetic and comparisons (round 2 §6.2). Returns `None`
/// when the expression carries no static type signal — variables and
/// term references fall through to the integer path by default.
fn infer_expression_type(expr: &Expression) -> Option<NumericSourceType> {
    match expr {
        Expression::Literal(l) => {
            let dt = l.datatype().as_str();
            if dt.ends_with("float") {
                Some(NumericSourceType::Float)
            } else if dt.ends_with("double") {
                Some(NumericSourceType::Double)
            } else if dt.ends_with("decimal") {
                // SPARQL treats decimal as double for comparisons
                Some(NumericSourceType::Double)
            } else if dt.ends_with("integer") || dt.ends_with("int") ||
                      dt.ends_with("long") || dt.ends_with("short") || dt.ends_with("byte") {
                Some(NumericSourceType::Integer)
            } else {
                None
            }
        }
        // Arithmetic — result is the wider of the operand types
        // (SPARQL 1.1 §17.3 promotion).
        Expression::Add(a, b)
        | Expression::Subtract(a, b)
        | Expression::Multiply(a, b)
        | Expression::Divide(a, b) => {
            Some(promote_numeric_types(
                infer_expression_type(a),
                infer_expression_type(b),
            ))
        }
        Expression::UnaryPlus(a) | Expression::UnaryMinus(a) => infer_expression_type(a),
        // SPARQL numeric functions (ABS / ROUND / CEIL / FLOOR) preserve
        // the operand type per SPARQL 1.1 §17.4.
        Expression::FunctionCall(Function::Abs, args)
        | Expression::FunctionCall(Function::Round, args)
        | Expression::FunctionCall(Function::Ceil, args)
        | Expression::FunctionCall(Function::Floor, args) => {
            args.first().and_then(infer_expression_type)
        }
        // Handle XSD cast functions - they return the target type
        Expression::FunctionCall(Function::Custom(iri), _) => {
            let iri_str = iri.as_str();
            if iri_str.starts_with(XSD) {
                let local = &iri_str[XSD.len()..];
                match local {
                    "float" => Some(NumericSourceType::Float),
                    "double" | "decimal" => Some(NumericSourceType::Double),
                    "integer" | "int" | "long" | "short" | "byte" |
                    "unsignedInt" | "unsignedLong" | "unsignedShort" | "unsignedByte" |
                    "positiveInteger" | "negativeInteger" | "nonPositiveInteger" | "nonNegativeInteger" => {
                        Some(NumericSourceType::Integer)
                    }
                    _ => None,
                }
            } else {
                None
            }
        }
        _ => None
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
        // Numeric arithmetic — round 2 §6.2 wires these into FILTER
        // expressions via xpath::numeric_*_{int,float,double}.
        Expression::Add(a, b) => emit_numeric_binary("add", a, b, query, bindings, hidden),
        Expression::Subtract(a, b) => emit_numeric_binary("subtract", a, b, query, bindings, hidden),
        Expression::Multiply(a, b) => emit_numeric_binary("multiply", a, b, query, bindings, hidden),
        Expression::Divide(a, b) => emit_numeric_binary("divide", a, b, query, bindings, hidden),
        Expression::UnaryPlus(a) => emit_numeric_unary("plus", a, query, bindings, hidden),
        Expression::UnaryMinus(a) => emit_numeric_unary("minus", a, query, bindings, hidden),

        Expression::FunctionCall(func, args) => {
            match func {
                // Numeric functions — round 2 §6.2 makes these type-aware:
                // integer / decimal → xpath::*_int (decimal floor at the
                // prover's field-element width per Q7); xsd:float →
                // xpath::*_float (binary32); xsd:double → xpath::*_double
                // (binary64).
                Function::Abs => {
                    if args.len() != 1 { return Err("ABS requires 1 argument".into()); }
                    emit_numeric_unary_function("abs", &args[0], query, bindings, hidden)
                }
                Function::Round => {
                    if args.len() != 1 { return Err("ROUND requires 1 argument".into()); }
                    emit_numeric_unary_function("round", &args[0], query, bindings, hidden)
                }
                Function::Ceil => {
                    if args.len() != 1 { return Err("CEIL requires 1 argument".into()); }
                    emit_numeric_unary_function("ceil", &args[0], query, bindings, hidden)
                }
                Function::Floor => {
                    if args.len() != 1 { return Err("FLOOR requires 1 argument".into()); }
                    emit_numeric_unary_function("floor", &args[0], query, bindings, hidden)
                }

                // DateTime functions
                Function::Year => {
                    if args.len() != 1 { return Err("YEAR requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    // DateTime values are stored as epoch milliseconds, convert to microseconds for xpath
                    Ok(format!("xpath::year_from_datetime(xpath::datetime_from_epoch_microseconds(({} as i128) * 1000))", arg_code))
                }
                Function::Month => {
                    if args.len() != 1 { return Err("MONTH requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::month_from_datetime(xpath::datetime_from_epoch_microseconds(({} as i128) * 1000))", arg_code))
                }
                Function::Day => {
                    if args.len() != 1 { return Err("DAY requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::day_from_datetime(xpath::datetime_from_epoch_microseconds(({} as i128) * 1000))", arg_code))
                }
                Function::Hours => {
                    if args.len() != 1 { return Err("HOURS requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::hours_from_datetime(xpath::datetime_from_epoch_microseconds(({} as i128) * 1000))", arg_code))
                }
                Function::Minutes => {
                    if args.len() != 1 { return Err("MINUTES requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::minutes_from_datetime(xpath::datetime_from_epoch_microseconds(({} as i128) * 1000))", arg_code))
                }
                Function::Seconds => {
                    if args.len() != 1 { return Err("SECONDS requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    Ok(format!("xpath::seconds_from_datetime(xpath::datetime_from_epoch_microseconds(({} as i128) * 1000))", arg_code))
                }
                Function::Timezone => {
                    if args.len() != 1 { return Err("TIMEZONE requires 1 argument".into()); }
                    let arg_code = expr_to_noir_code(&args[0], query, bindings, hidden)?;
                    // Returns a duration representing the timezone offset
                    Ok(format!("xpath::duration_to_microseconds(xpath::timezone_from_datetime(xpath::datetime_from_epoch_microseconds(({} as i128) * 1000)))", arg_code))
                }
                
                // XSD type casting functions (Custom functions with XSD namespace)
                Function::Custom(iri) => {
                    let iri_str = iri.as_str();
                    if iri_str.starts_with(XSD) {
                        let local_name = &iri_str[XSD.len()..];
                        handle_xsd_cast(local_name, args, query, bindings, hidden)
                    } else {
                        Err(format!("Unsupported custom function: {}", iri_str))
                    }
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
        // Handle XSD cast functions - they return the target type
        Expression::FunctionCall(Function::Custom(iri), _) => {
            let iri_str = iri.as_str();
            if iri_str.starts_with(XSD) {
                let local = &iri_str[XSD.len()..];
                match local {
                    "integer" | "decimal" | "float" | "double" | "int" | "long" | "short" | "byte"
                    | "nonNegativeInteger" | "positiveInteger" | "negativeInteger" | "nonPositiveInteger"
                    | "unsignedInt" | "unsignedLong" | "unsignedShort" | "unsignedByte" => ComparisonType::Numeric,
                    "string" | "normalizedString" | "token" => ComparisonType::String,
                    "boolean" => ComparisonType::Boolean,
                    "dateTime" | "date" | "time" => ComparisonType::DateTime,
                    _ => ComparisonType::Unknown,
                }
            } else {
                ComparisonType::Unknown
            }
        }
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

pub(crate) fn filter_to_noir(
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
                
                // Numeric functions — type-aware per round 2 §6.2 (Q1
                // decision). The expression-conversion path
                // (`expr_to_noir_code`) does the type-dispatch; we
                // delegate so that nested forms like
                // `FILTER(ABS(xsd:double(?v)) > 5)` get the matching
                // IEEE 754 path.
                Function::Abs | Function::Round | Function::Ceil | Function::Floor => {
                    let expr = Expression::FunctionCall(func.clone(), args.clone());
                    expr_to_noir_code(&expr, query, bindings, hidden)
                }


                // String functions (return numeric/boolean values only)
                // Note: These are placeholder implementations that do not perform actual string operations
                Function::StrLen => {
                    if args.len() != 1 { return Err("STRLEN requires 1 argument".into()); }
                    let term = expr_to_term(&args[0])?;
                    let str_idx = push_hidden(hidden, "strlen_str", &term);
                    // STUB: Returns placeholder value, not actual string length
                    // TODO: Implement actual string length calculation when string values are available
                    Ok(format!("hidden[{}]", str_idx))
                }
                Function::Contains => {
                    if args.len() != 2 { return Err("CONTAINS requires 2 arguments".into()); }
                    let str1_term = expr_to_term(&args[0])?;
                    let str1_idx = push_hidden(hidden, "contains_str1", &str1_term);
                    // STUB: Second argument not used - placeholder implementation only
                    // TODO: Implement xpath::contains(str1, str2) when string values are available
                    Ok(format!("(hidden[{}] != 0)", str1_idx))
                }
                Function::StrStarts => {
                    if args.len() != 2 { return Err("STRSTARTS requires 2 arguments".into()); }
                    let str1_term = expr_to_term(&args[0])?;
                    let str1_idx = push_hidden(hidden, "strstarts_str1", &str1_term);
                    // STUB: Second argument not used - placeholder implementation only
                    // TODO: Implement xpath::starts_with(str1, str2) when string values are available
                    Ok(format!("(hidden[{}] != 0)", str1_idx))
                }
                Function::StrEnds => {
                    if args.len() != 2 { return Err("STRENDS requires 2 arguments".into()); }
                    let str1_term = expr_to_term(&args[0])?;
                    let str1_idx = push_hidden(hidden, "strends_str1", &str1_term);
                    // STUB: Second argument not used - placeholder implementation only
                    // TODO: Implement xpath::ends_with(str1, str2) when string values are available
                    Ok(format!("(hidden[{}] != 0)", str1_idx))
                }
                
                // DateTime functions - delegate to expr_to_noir_code to avoid duplication
                Function::Year | Function::Month | Function::Day | 
                Function::Hours | Function::Minutes | Function::Seconds | Function::Timezone => {
                    let expr = Expression::FunctionCall(func.clone(), args.clone());
                    expr_to_noir_code(&expr, query, bindings, hidden)
                }
                
                // XSD type casting functions (Custom functions with XSD namespace)
                Function::Custom(iri) => {
                    let iri_str = iri.as_str();
                    if iri_str.starts_with(XSD) {
                        let local_name = &iri_str[XSD.len()..];
                        handle_xsd_cast(local_name, args, query, bindings, hidden)
                    } else {
                        Err(format!("Unsupported custom function: {}", iri_str))
                    }
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
    // Determine the types of operands
    let type_a = infer_expression_type(a);
    let type_b = infer_expression_type(b);
    
    // IEEE 754 constant folding for float/double literals
    if let (Expression::Literal(lit_a), Expression::Literal(lit_b)) = (a, b) {
        let dt_a = lit_a.datatype().as_str();
        let dt_b = lit_b.datatype().as_str();
        // Only treat xsd:float and xsd:double as IEEE 754; xsd:decimal is arbitrary-precision
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

    // Determine if we need float/double comparisons
    // Promote to the widest type: double > float > integer
    let use_double = matches!(type_a, Some(NumericSourceType::Double)) || 
                     matches!(type_b, Some(NumericSourceType::Double));
    let use_float = !use_double && 
                    (matches!(type_a, Some(NumericSourceType::Float)) || 
                     matches!(type_b, Some(NumericSourceType::Float)));

    if use_double {
        // Use double comparison functions
        let left_double = match type_a {
            Some(NumericSourceType::Double) => left_code.clone(),
            Some(NumericSourceType::Float) => {
                format!("xpath::XsdDouble::from_float(xpath::XsdFloat::from_bits({} as u32))", left_code)
            }
            Some(NumericSourceType::Integer) | None => {
                format!("xpath::cast_integer_to_double(({}) as i64)", left_code)
            }
        };
        let right_double = match type_b {
            Some(NumericSourceType::Double) => right_code.clone(),
            Some(NumericSourceType::Float) => {
                format!("xpath::XsdDouble::from_float(xpath::XsdFloat::from_bits({} as u32))", right_code)
            }
            Some(NumericSourceType::Integer) | None => {
                format!("xpath::cast_integer_to_double(({}) as i64)", right_code)
            }
        };
        
        let cmp_func = match expr {
            Expression::Greater(_, _) => "xpath::numeric_greater_than_double",
            Expression::GreaterOrEqual(_, _) => "xpath::numeric_ge_double",
            Expression::Less(_, _) => "xpath::numeric_less_than_double",
            Expression::LessOrEqual(_, _) => "xpath::numeric_le_double",
            _ => return Err("Invalid comparison operator".into()),
        };
        
        // Need to extract XsdDouble from cast results for comparison
        let left_as_double = if matches!(type_a, Some(NumericSourceType::Double)) {
            format!("xpath::XsdDouble::from_bits({} as u64)", left_code)
        } else {
            left_double
        };
        let right_as_double = if matches!(type_b, Some(NumericSourceType::Double)) {
            format!("xpath::XsdDouble::from_bits({} as u64)", right_code)
        } else {
            right_double
        };
        
        Ok(format!("{}({}, {})", cmp_func, left_as_double, right_as_double))
    } else if use_float {
        // Use float comparison functions
        let left_float = match type_a {
            Some(NumericSourceType::Float) => format!("xpath::XsdFloat::from_bits({} as u32)", left_code),
            Some(NumericSourceType::Integer) | None => {
                format!("xpath::cast_integer_to_float(({}) as i64)", left_code)
            }
            Some(NumericSourceType::Double) => unreachable!("Double handled above"),
        };
        let right_float = match type_b {
            Some(NumericSourceType::Float) => format!("xpath::XsdFloat::from_bits({} as u32)", right_code),
            Some(NumericSourceType::Integer) | None => {
                format!("xpath::cast_integer_to_float(({}) as i64)", right_code)
            }
            Some(NumericSourceType::Double) => unreachable!("Double handled above"),
        };
        
        let cmp_func = match expr {
            Expression::Greater(_, _) => "xpath::numeric_greater_than_float",
            Expression::GreaterOrEqual(_, _) => "xpath::numeric_ge_float",
            Expression::Less(_, _) => "xpath::numeric_less_than_float",
            Expression::LessOrEqual(_, _) => "xpath::numeric_le_float",
            _ => return Err("Invalid comparison operator".into()),
        };
        
        Ok(format!("{}({}, {})", cmp_func, left_float, right_float))
    } else {
        // Integer comparison
        let cmp = match expr {
            Expression::Greater(_, _) => format!("({} as i64) > ({} as i64)", left_code, right_code),
            Expression::GreaterOrEqual(_, _) => format!("({} as i64) >= ({} as i64)", left_code, right_code),
            Expression::Less(_, _) => format!("({} as i64) < ({} as i64)", left_code, right_code),
            Expression::LessOrEqual(_, _) => format!("({} as i64) <= ({} as i64)", left_code, right_code),
            _ => return Err("Invalid comparison operator".into()),
        };
        Ok(cmp)
    }
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

fn term_to_hidden_json(term: &Term) -> serde_json::Value {
    match term {
        Term::Variable(name) => serde_json::json!({"type": "variable", "value": name}),
        Term::Input(i, j) => serde_json::json!({"type": "input", "value": [i, j]}),
        Term::Static(gt) => serde_json::json!({"type": "static", "value": ground_term_to_json(gt)}),
        // Default-graph term shouldn't normally appear in hidden
        // filter / comparison inputs (graph slots aren't compared
        // arithmetically). Surface it explicitly so a future code
        // path that does route a graph term through here doesn't
        // silently drop the term-type tag.
        Term::DefaultGraph => serde_json::json!({
            "type": "static",
            "value": { "termType": "DefaultGraph" },
        }),
    }
}

fn push_hidden(hidden: &mut Vec<serde_json::Value>, kind: &str, term: &Term) -> usize {
    let idx = hidden.len();
    hidden.push(serde_json::json!({
        "type": "customComputed",
        "computedType": kind,
        "input": term_to_hidden_json(term)
    }));
    idx
}

fn push_hidden_comparison(hidden: &mut Vec<serde_json::Value>, kind: &str, left: &Term, right: &Term) -> usize {
    let idx = hidden.len();
    hidden.push(serde_json::json!({
        "type": "customComputed",
        "computedType": kind,
        "inputs": [term_to_hidden_json(left), term_to_hidden_json(right)]
    }));
    idx
}

// =============================================================================
// NUMERIC ARITHMETIC — round 2 §6.2
// =============================================================================
//
// SPARQL 1.1 §17.3 numeric promotion: the result type is the widest of
// the operand types (integer < decimal < float < double). Here we:
// 1. infer each operand's static type via `infer_expression_type`,
// 2. promote both to the wider type,
// 3. emit the matching `xpath::numeric_*_{int,float,double}` call.
//
// Per Q7 decision (2026-05-03) `xsd:decimal` shares the integer code
// path — the precision floor is the prover's field-element width.

fn promote_numeric_types(
    a: Option<NumericSourceType>,
    b: Option<NumericSourceType>,
) -> NumericSourceType {
    use NumericSourceType::*;
    match (a, b) {
        (Some(Double), _) | (_, Some(Double)) => Double,
        (Some(Float), _) | (_, Some(Float)) => Float,
        _ => Integer,
    }
}

/// Coerce an operand to the result type's IEEE 754 wrapper. Integer
/// operands are routed through `xpath::cast_integer_to_*`; float
/// operands are widened to double when the result type is double.
fn coerce_numeric_operand(
    code: &str,
    from: Option<NumericSourceType>,
    to: NumericSourceType,
) -> String {
    use NumericSourceType::*;
    match (from, to) {
        (_, Integer) => format!("({}) as i64", code),
        (Some(Double), Double) => format!("xpath::XsdDouble::from_bits({} as u64)", code),
        (Some(Float), Double) => format!(
            "xpath::XsdDouble::from_float(xpath::XsdFloat::from_bits({} as u32))",
            code
        ),
        (Some(Integer), Double) | (None, Double) => {
            format!("xpath::cast_integer_to_double(({}) as i64)", code)
        }
        (Some(Float), Float) => format!("xpath::XsdFloat::from_bits({} as u32)", code),
        (Some(Integer), Float) | (None, Float) => {
            format!("xpath::cast_integer_to_float(({}) as i64)", code)
        }
        // Double → Float is a narrowing cast we don't expect to hit
        // because promotion always picks the wider; if it ever did we'd
        // truncate via cast_double_to_float.
        (Some(Double), Float) => format!(
            "xpath::cast_double_to_float(xpath::XsdDouble::from_bits({} as u64))",
            code
        ),
    }
}

/// Emit `?x ⊕ ?y` for ⊕ ∈ {add, subtract, multiply, divide}.
fn emit_numeric_binary(
    op: &str,
    a: &Expression,
    b: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    let left_code = expr_to_noir_code(a, query, bindings, hidden)?;
    let right_code = expr_to_noir_code(b, query, bindings, hidden)?;

    let type_a = infer_expression_type(a);
    let type_b = infer_expression_type(b);
    let result = promote_numeric_types(type_a, type_b);

    let left = coerce_numeric_operand(&left_code, type_a, result);
    let right = coerce_numeric_operand(&right_code, type_b, result);

    let (suffix, returns_field) = match result {
        NumericSourceType::Integer => ("int", true),
        NumericSourceType::Float => ("float", false),
        NumericSourceType::Double => ("double", false),
    };

    let inner = format!("xpath::numeric_{}_{}({}, {})", op, suffix, left, right);
    if returns_field {
        Ok(format!("(({}) as Field)", inner))
    } else {
        // Float / double: the SPARQL value is the IEEE 754 wrapper's
        // bit pattern, packed into a Field for downstream consumers.
        Ok(format!("(({}).to_bits() as Field)", inner))
    }
}

/// Emit `+?x` / `-?x` (unary plus / minus).
fn emit_numeric_unary(
    op: &str, // "plus" or "minus"
    a: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    let arg_code = expr_to_noir_code(a, query, bindings, hidden)?;
    let type_a = infer_expression_type(a);
    let inferred = type_a.unwrap_or(NumericSourceType::Integer);

    match inferred {
        NumericSourceType::Integer => {
            let inner = format!(
                "xpath::numeric_unary_{}_int(({}) as i64)",
                op, arg_code
            );
            Ok(format!("(({}) as Field)", inner))
        }
        NumericSourceType::Float | NumericSourceType::Double => {
            // noir_xpath does not currently expose `numeric_unary_*_float`
            // / `_double`; emulate via subtract from zero (matches the
            // pattern used in `arith::neg`).
            let zero_ctor = match inferred {
                NumericSourceType::Float => "xpath::cast_integer_to_float(0 as i8)",
                NumericSourceType::Double => "xpath::cast_integer_to_double(0 as i8)",
                _ => unreachable!(),
            };
            let wrap = match inferred {
                NumericSourceType::Float => format!(
                    "xpath::XsdFloat::from_bits({} as u32)", arg_code
                ),
                NumericSourceType::Double => format!(
                    "xpath::XsdDouble::from_bits({} as u64)", arg_code
                ),
                _ => unreachable!(),
            };
            match op {
                "plus" => Ok(format!("({}.to_bits() as Field)", wrap)),
                "minus" => {
                    let suffix = if matches!(inferred, NumericSourceType::Double) {
                        "double"
                    } else {
                        "float"
                    };
                    let inner = format!(
                        "xpath::numeric_subtract_{}({}, {})", suffix, zero_ctor, wrap
                    );
                    Ok(format!("(({}).to_bits() as Field)", inner))
                }
                _ => Err(format!("Unsupported unary op: {}", op)),
            }
        }
    }
}

/// Emit a unary numeric function `ABS(?x)` / `ROUND(?x)` / `CEIL(?x)` /
/// `FLOOR(?x)` with type-aware dispatch.
fn emit_numeric_unary_function(
    op: &str, // "abs" / "round" / "ceil" / "floor"
    a: &Expression,
    query: &QueryInfo,
    bindings: &BTreeMap<String, Term>,
    hidden: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
    let arg_code = expr_to_noir_code(a, query, bindings, hidden)?;
    let inferred = infer_expression_type(a).unwrap_or(NumericSourceType::Integer);

    match inferred {
        NumericSourceType::Integer => {
            // integer / decimal → integer path (decimal floor is field-
            // element width per Q7).
            Ok(format!(
                "(xpath::{}_int(({}) as i64) as Field)",
                op, arg_code
            ))
        }
        NumericSourceType::Float => {
            Ok(format!(
                "(xpath::{}_float(xpath::XsdFloat::from_bits({} as u32)).to_bits() as Field)",
                op, arg_code
            ))
        }
        NumericSourceType::Double => {
            Ok(format!(
                "(xpath::{}_double(xpath::XsdDouble::from_bits({} as u64)).to_bits() as Field)",
                op, arg_code
            ))
        }
    }
}
