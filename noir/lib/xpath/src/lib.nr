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
//! - Casting: type conversions between integer, float, double

use dep::consts;

// Re-export types
pub use dep::noir_xpath::XsdDate;
pub use dep::noir_xpath::XsdDateTime;
pub use dep::noir_xpath::XsdDayTimeDuration;
pub use dep::noir_xpath::XsdFloat;
pub use dep::noir_xpath::XsdDouble;
pub use dep::noir_xpath::NumericType;

// Re-export boolean functions
pub use dep::noir_xpath::boolean_equal;
pub use dep::noir_xpath::boolean_ge;
pub use dep::noir_xpath::boolean_greater_than;
pub use dep::noir_xpath::boolean_le;
pub use dep::noir_xpath::boolean_less_than;
pub use dep::noir_xpath::fn_not;
pub use dep::noir_xpath::logical_and;
pub use dep::noir_xpath::logical_or;

// Re-export integer numeric functions
pub use dep::noir_xpath::abs_int;
pub use dep::noir_xpath::ceil_int;
pub use dep::noir_xpath::floor_int;
pub use dep::noir_xpath::round_int;
pub use dep::noir_xpath::max_int;
pub use dep::noir_xpath::min_int;
pub use dep::noir_xpath::numeric_add_int;
pub use dep::noir_xpath::numeric_subtract_int;
pub use dep::noir_xpath::numeric_multiply_int;
pub use dep::noir_xpath::numeric_divide_int;
pub use dep::noir_xpath::numeric_mod_int;
pub use dep::noir_xpath::numeric_equal_int;
pub use dep::noir_xpath::numeric_less_than_int;
pub use dep::noir_xpath::numeric_greater_than_int;
pub use dep::noir_xpath::numeric_le_int;
pub use dep::noir_xpath::numeric_ge_int;
pub use dep::noir_xpath::numeric_unary_minus_int;
pub use dep::noir_xpath::numeric_unary_plus_int;

// Re-export float arithmetic and comparison functions
pub use dep::noir_xpath::numeric_equal_float;
pub use dep::noir_xpath::numeric_less_than_float;
pub use dep::noir_xpath::numeric_greater_than_float;
pub use dep::noir_xpath::numeric_le_float;
pub use dep::noir_xpath::numeric_ge_float;
pub use dep::noir_xpath::numeric_add_float;
pub use dep::noir_xpath::numeric_subtract_float;
pub use dep::noir_xpath::numeric_multiply_float;
pub use dep::noir_xpath::numeric_divide_float;
pub use dep::noir_xpath::abs_float;
pub use dep::noir_xpath::round_float;
pub use dep::noir_xpath::ceil_float;
pub use dep::noir_xpath::floor_float;

// Re-export double arithmetic and comparison functions
pub use dep::noir_xpath::numeric_equal_double;
pub use dep::noir_xpath::numeric_less_than_double;
pub use dep::noir_xpath::numeric_greater_than_double;
pub use dep::noir_xpath::numeric_le_double;
pub use dep::noir_xpath::numeric_ge_double;
pub use dep::noir_xpath::numeric_add_double;
pub use dep::noir_xpath::numeric_subtract_double;
pub use dep::noir_xpath::numeric_multiply_double;
pub use dep::noir_xpath::numeric_divide_double;
pub use dep::noir_xpath::abs_double;
pub use dep::noir_xpath::round_double;
pub use dep::noir_xpath::ceil_double;
pub use dep::noir_xpath::floor_double;

// Re-export mixed type comparison functions
pub use dep::noir_xpath::compare_int_double_eq;
pub use dep::noir_xpath::compare_int_double_lt;
pub use dep::noir_xpath::compare_int_double_gt;
pub use dep::noir_xpath::compare_int_double_le;
pub use dep::noir_xpath::compare_int_double_ge;
pub use dep::noir_xpath::compare_double_int_eq;
pub use dep::noir_xpath::compare_double_int_lt;
pub use dep::noir_xpath::compare_double_int_gt;
pub use dep::noir_xpath::compare_double_int_le;
pub use dep::noir_xpath::compare_double_int_ge;
pub use dep::noir_xpath::compare_float_double_eq;
pub use dep::noir_xpath::compare_float_double_lt;
pub use dep::noir_xpath::compare_float_double_gt;
pub use dep::noir_xpath::compare_float_double_le;
pub use dep::noir_xpath::compare_float_double_ge;
pub use dep::noir_xpath::compare_double_float_eq;
pub use dep::noir_xpath::compare_double_float_lt;
pub use dep::noir_xpath::compare_double_float_gt;
pub use dep::noir_xpath::compare_double_float_le;
pub use dep::noir_xpath::compare_double_float_ge;
pub use dep::noir_xpath::compare_int_float_eq;
pub use dep::noir_xpath::compare_int_float_lt;
pub use dep::noir_xpath::compare_int_float_gt;
pub use dep::noir_xpath::compare_int_float_le;
pub use dep::noir_xpath::compare_int_float_ge;
pub use dep::noir_xpath::compare_float_int_eq;
pub use dep::noir_xpath::compare_float_int_lt;
pub use dep::noir_xpath::compare_float_int_gt;
pub use dep::noir_xpath::compare_float_int_le;
pub use dep::noir_xpath::compare_float_int_ge;
pub use dep::noir_xpath::get_common_type;

// Re-export type casting functions
pub use dep::noir_xpath::cast_integer_to_float;
pub use dep::noir_xpath::cast_integer_to_double;
pub use dep::noir_xpath::cast_float_to_integer;
pub use dep::noir_xpath::cast_double_to_integer;
pub use dep::noir_xpath::cast_double_to_float;

// Re-export datetime functions
pub use dep::noir_xpath::datetime_equal;
pub use dep::noir_xpath::datetime_from_components;
pub use dep::noir_xpath::datetime_from_components_with_tz;
pub use dep::noir_xpath::datetime_from_epoch_microseconds;
pub use dep::noir_xpath::datetime_from_epoch_microseconds_with_tz;
pub use dep::noir_xpath::datetime_ge;
pub use dep::noir_xpath::datetime_greater_than;
pub use dep::noir_xpath::datetime_le;
pub use dep::noir_xpath::datetime_less_than;
pub use dep::noir_xpath::datetime_timezone_offset;
pub use dep::noir_xpath::datetime_to_epoch_microseconds;
pub use dep::noir_xpath::day_from_datetime;
pub use dep::noir_xpath::hours_from_datetime;
pub use dep::noir_xpath::microseconds_from_datetime;
pub use dep::noir_xpath::minutes_from_datetime;
pub use dep::noir_xpath::month_from_datetime;
pub use dep::noir_xpath::seconds_from_datetime;
pub use dep::noir_xpath::timezone_from_datetime;
pub use dep::noir_xpath::year_from_datetime;

// Re-export duration functions
pub use dep::noir_xpath::datetime_add_duration;
pub use dep::noir_xpath::datetime_difference;
pub use dep::noir_xpath::datetime_subtract_duration;
pub use dep::noir_xpath::days_from_duration;
pub use dep::noir_xpath::duration_add;
pub use dep::noir_xpath::duration_divide;
pub use dep::noir_xpath::duration_divide_by_duration;
pub use dep::noir_xpath::duration_equal;
pub use dep::noir_xpath::duration_from_components;
pub use dep::noir_xpath::duration_from_microseconds;
pub use dep::noir_xpath::duration_ge;
pub use dep::noir_xpath::duration_greater_than;
pub use dep::noir_xpath::duration_is_negative;
pub use dep::noir_xpath::duration_le;
pub use dep::noir_xpath::duration_less_than;
pub use dep::noir_xpath::duration_multiply;
pub use dep::noir_xpath::duration_negate;
pub use dep::noir_xpath::duration_subtract;
pub use dep::noir_xpath::duration_to_microseconds;
pub use dep::noir_xpath::duration_zero;
pub use dep::noir_xpath::hours_from_duration;
pub use dep::noir_xpath::minutes_from_duration;
pub use dep::noir_xpath::seconds_from_duration;

// Re-export date functions
pub use dep::noir_xpath::date_equal;
pub use dep::noir_xpath::date_from_components;
pub use dep::noir_xpath::date_from_components_with_tz;
pub use dep::noir_xpath::date_from_epoch_days;
pub use dep::noir_xpath::date_from_epoch_days_with_tz;
pub use dep::noir_xpath::date_ge;
pub use dep::noir_xpath::date_greater_than;
pub use dep::noir_xpath::date_le;
pub use dep::noir_xpath::date_less_than;
pub use dep::noir_xpath::day_from_date;
pub use dep::noir_xpath::month_from_date;
pub use dep::noir_xpath::timezone_from_date;
pub use dep::noir_xpath::year_from_date;

// Re-export sequence/aggregate functions
pub use dep::noir_xpath::all_true;
pub use dep::noir_xpath::any_true;
pub use dep::noir_xpath::avg_int;
pub use dep::noir_xpath::avg_int_partial;
pub use dep::noir_xpath::count;
pub use dep::noir_xpath::count_true;
pub use dep::noir_xpath::exists;
pub use dep::noir_xpath::is_empty;
pub use dep::noir_xpath::max_int_partial;
pub use dep::noir_xpath::max_int_seq;
pub use dep::noir_xpath::min_int_partial;
pub use dep::noir_xpath::min_int_seq;
pub use dep::noir_xpath::sum_int;
pub use dep::noir_xpath::sum_int_partial;

// Re-export comparison functions
pub use dep::noir_xpath::value_equal;
pub use dep::noir_xpath::value_ge;
pub use dep::noir_xpath::value_greater_than;
pub use dep::noir_xpath::value_le;
pub use dep::noir_xpath::value_less_than;

// Re-export string functions (only ones that return non-string values)
pub use dep::noir_xpath::contains;
pub use dep::noir_xpath::ends_with;
pub use dep::noir_xpath::starts_with;
pub use dep::noir_xpath::string_length;

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

// =============================================================================
// CASTING FUNCTION TESTS
// =============================================================================

#[test]
fn test_cast_integer_to_float() {
    // Cast integer 10 to float
    let f = cast_integer_to_float(10);
    // 10.0f has bits 0x41200000 = 1092616192
    assert(f.to_bits() == 1092616192);
}

#[test]
fn test_cast_integer_to_double() {
    // Cast integer 10 to double  
    let d = cast_integer_to_double(10);
    // 10.0 has bits 0x4024000000000000 = 4621819117588971520
    assert(d.to_bits() == 4621819117588971520);
}

#[test]
fn test_cast_float_to_integer() {
    // Cast float 5.0 to integer
    let f = XsdFloat::from_bits(0x40A00000); // 5.0f
    let result = cast_float_to_integer(f);
    assert(result.is_some());
    assert(result.unwrap() == 5);
}

#[test]
fn test_cast_double_to_integer() {
    // Cast double 5.0 to integer
    let d = XsdDouble::from_bits(0x4014000000000000); // 5.0
    let result = cast_double_to_integer(d);
    assert(result.is_some());
    assert(result.unwrap() == 5);
}

#[test]
fn test_cast_double_to_float() {
    // Cast double 1.0 to float
    let d = XsdDouble::from_bits(0x3FF0000000000000); // 1.0
    let f = cast_double_to_float(d);
    let expected = XsdFloat::from_bits(0x3F800000); // 1.0f
    assert(numeric_equal_float(f, expected));
}
