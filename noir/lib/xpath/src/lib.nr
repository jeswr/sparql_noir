//! XPath Functions Wrapper for SPARQL
//!
//! This module re-exports XPath 2.0 functions from noir_XPath library
//! for use in SPARQL query circuits.
//!
//! Available function categories:
//! - Numeric: abs, round, ceil, floor, arithmetic operations
//! - String: string_length, starts_with, ends_with, contains
//! - DateTime: year, month, day, hours, minutes, seconds, timezone
//! - Duration: duration operations and datetime arithmetic
//! - Boolean: logical operations
//! - Comparison: value comparisons across types

use dep::consts;

// Re-export all XPath functions from noir_xpath
pub use dep::noir_xpath::*;

// =============================================================================
// HELPER FUNCTIONS FOR SPARQL INTEGRATION
// =============================================================================

/// Encode a datatype IRI to its Field representation
/// This computes: hash2([0, encode_string(iri)])
/// where 0 is the type code for NamedNode
pub fn encode_datatype_iri<let N: u32>(iri: str<N>) -> Field {
    consts::hash2([0, consts::encode_string(iri)])
}

/// Check if a datatype is numeric (integer, decimal, float, double, or derived types)
pub fn is_numeric_type(datatype: Field) -> bool {
    // Primary numeric types
    let is_integer = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let is_decimal = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#decimal");
    let is_float = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#float");
    let is_double = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double");
    
    // Derived integer types
    let is_int = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#int");
    let is_long = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#long");
    let is_short = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#short");
    let is_byte = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#byte");
    
    // Unsigned integer types
    let is_unsigned_int = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedInt");
    let is_unsigned_long = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedLong");
    let is_unsigned_short = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedShort");
    let is_unsigned_byte = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedByte");
    
    // Constrained integer types
    let is_non_negative = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#nonNegativeInteger");
    let is_positive = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#positiveInteger");
    let is_negative = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#negativeInteger");
    let is_non_positive = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#nonPositiveInteger");
    
    is_integer | is_decimal | is_float | is_double
        | is_int | is_long | is_short | is_byte
        | is_unsigned_int | is_unsigned_long | is_unsigned_short | is_unsigned_byte
        | is_non_negative | is_positive | is_negative | is_non_positive
}

/// Check if a datatype is string type
pub fn is_string_type(datatype: Field) -> bool {
    datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#string")
}

/// Check if a datatype is dateTime type
pub fn is_datetime_type(datatype: Field) -> bool {
    datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#dateTime")
}

/// Check if a datatype is date type
pub fn is_date_type(datatype: Field) -> bool {
    datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#date")
}

// =============================================================================
// TESTS
// =============================================================================

#[test]
fn test_encode_datatype() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    assert(int_type != 0);
}

#[test]
fn test_is_numeric_type_integer() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    assert(is_numeric_type(int_type));
}

#[test]
fn test_is_numeric_type_double() {
    let double_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double");
    assert(is_numeric_type(double_type));
}

#[test]
fn test_is_string_type() {
    let string_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#string");
    assert(is_string_type(string_type));
}

#[test]
fn test_is_datetime_type() {
    let datetime_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#dateTime");
    assert(is_datetime_type(datetime_type));
}

#[test]
fn test_not_numeric() {
    let string_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#string");
    assert(!is_numeric_type(string_type));
}
