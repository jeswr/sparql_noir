use dep::consts;

// =============================================================================
// DATATYPE CONSTANTS
// =============================================================================
// 
// These are the encoded datatype IRI fields that we need to recognize.
// The encoding uses: consts::hash2([0, consts::encode_string(iri)])
// where 0 is the type code for NamedNode.
//
// For efficiency, we precompute these at compile time by encoding the
// XSD namespace IRIs.

// Datatype categories for EBV evaluation:
// - BOOLEAN: xsd:boolean
// - STRING: xsd:string (note: simple literals without datatype are also treated as strings)
// - NUMERIC: xsd:integer, xsd:decimal, xsd:float, xsd:double, and derived types

// =============================================================================
// EBV RESULT TYPE
// =============================================================================

/// Result of EBV evaluation
/// In SPARQL, EBV can be true, false, or produce a type error.
/// We encode this as:
/// - success: true if evaluation succeeded
/// - value: the boolean result (only valid if success is true)
pub struct EBVResult {
    pub success: bool,
    pub value: bool,
}

impl EBVResult {
    /// Create a successful EBV result
    pub fn ok(value: bool) -> Self {
        EBVResult { success: true, value }
    }
    
    /// Create a type error result
    pub fn type_error() -> Self {
        EBVResult { success: false, value: false }
    }
    
    /// Check if this is a type error
    pub fn is_error(self) -> bool {
        !self.success
    }
    
    /// Get the boolean value, asserting no type error
    pub fn unwrap(self) -> bool {
        assert(self.success, "EBV type error");
        self.value
    }
    
    /// Get the boolean value, or a default if type error
    pub fn unwrap_or(self, default: bool) -> bool {
        if self.success { self.value } else { default }
    }
}

// =============================================================================
// DATATYPE ENCODING HELPERS
// =============================================================================

/// Encode a datatype IRI to its Field representation
/// This computes: hash2([0, encode_string(iri)])
/// where 0 is the type code for NamedNode
pub fn encode_datatype_iri<let N: u32>(iri: str<N>) -> Field {
    consts::hash2([0, consts::encode_string(iri)])
}

// =============================================================================
// DATATYPE CLASSIFICATION
// =============================================================================

/// Check if a datatype is xsd:boolean
pub fn is_boolean_datatype(datatype: Field) -> bool {
    // xsd:boolean
    datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#boolean")
}

/// Check if a datatype is xsd:string
pub fn is_string_datatype(datatype: Field) -> bool {
    // xsd:string
    datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#string")
}

/// Check if a datatype is a numeric type
/// This includes: xsd:integer, xsd:decimal, xsd:float, xsd:double
/// and derived integer types
pub fn is_numeric_datatype(datatype: Field) -> bool {
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

// =============================================================================
// SPECIAL VALUE CONSTANTS FOR NUMERIC TYPES
// =============================================================================

/// The special encoding for numeric zero (used in special_literal_handling)
/// Integer 0 is encoded as the Field value 0
global NUMERIC_ZERO: Field = 0;

// =============================================================================
// EBV EVALUATION
// =============================================================================

/// Evaluate the Effective Boolean Value (EBV) of a literal.
///
/// According to SPARQL 1.1 spec section 17.2.2:
///
/// 1. If the argument is xsd:boolean with valid lexical form, the EBV is the boolean value
/// 2. If the argument is a plain literal or xsd:string, EBV is false if zero length, else true
/// 3. If the argument is numeric with valid lexical form, EBV is false if NaN or 0, else true
/// 4. All other arguments produce a type error
///
/// Parameters:
/// - `value`: The Field representing the "special encoding" of the literal value
///            For boolean: 0 (false) or 1 (true)
///            For numeric: the numeric value as a Field
///            For string: the encoded string hash
/// - `datatype`: The Field representing the encoded datatype IRI
///
/// Returns:
/// - EBVResult with success=true and the boolean value, or success=false for type error
pub fn ebv(value: Field, datatype: Field) -> EBVResult {
    let is_bool = is_boolean_datatype(datatype);
    let is_str = is_string_datatype(datatype);
    let is_num = is_numeric_datatype(datatype);
    let empty_string_hash = consts::encode_string("");
    
    // Calculate results for each branch
    let bool_result_value = value == 1;
    let bool_valid = (value == 0) | (value == 1);
    
    let string_result_value = value != empty_string_hash;
    
    let numeric_result_value = value != NUMERIC_ZERO;
    
    // Determine success and value based on type
    let success = if is_bool {
        bool_valid
    } else if is_str {
        true
    } else if is_num {
        true
    } else {
        false
    };
    
    let result_value = if is_bool {
        bool_result_value
    } else if is_str {
        string_result_value
    } else if is_num {
        numeric_result_value
    } else {
        false
    };
    
    EBVResult { success, value: result_value }
}

/// Simplified EBV evaluation that asserts on type errors.
/// Use this when you expect the input to be a valid EBV-compatible type.
///
/// Parameters:
/// - `value`: The special encoding of the literal value
/// - `datatype`: The encoded datatype IRI
///
/// Returns:
/// - The boolean EBV result
///
/// Panics:
/// - If the datatype is not compatible with EBV evaluation
pub fn ebv_unchecked(value: Field, datatype: Field) -> bool {
    ebv(value, datatype).unwrap()
}

/// EBV evaluation with explicit handling for plain literals (no datatype).
/// In RDF 1.1, literals without an explicit datatype are implicitly xsd:string.
///
/// This function allows you to pass a flag indicating whether the literal
/// has a datatype or is a plain/simple literal.
///
/// Parameters:
/// - `value`: The special encoding of the literal value
/// - `datatype`: The encoded datatype IRI (ignored if is_plain is true)
/// - `is_plain`: True if this is a plain literal without datatype
///
/// Returns:
/// - EBVResult
pub fn ebv_with_plain(value: Field, datatype: Field, is_plain: bool) -> EBVResult {
    let empty_string_hash = consts::encode_string("");
    
    if is_plain {
        // Plain literals are treated as xsd:string for EBV
        let result_value = value != empty_string_hash;
        EBVResult { success: true, value: result_value }
    } else {
        ebv(value, datatype)
    }
}

// =============================================================================
// TESTS
// =============================================================================

#[test]
fn test_boolean_true() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#boolean");
    let result = ebv(1, datatype);
    assert(result.success);
    assert(result.value == true);
}

#[test]
fn test_boolean_false() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#boolean");
    let result = ebv(0, datatype);
    assert(result.success);
    assert(result.value == false);
}

#[test]
fn test_string_non_empty() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#string");
    // Non-empty string should have non-zero hash (different from empty string hash)
    let value = consts::encode_string("hello");
    let result = ebv(value, datatype);
    assert(result.success);
    assert(result.value == true);
}

#[test]
fn test_string_empty() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#string");
    let value = consts::encode_string("");
    let result = ebv(value, datatype);
    assert(result.success);
    assert(result.value == false);
}

#[test]
fn test_integer_zero() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let result = ebv(0, datatype);
    assert(result.success);
    assert(result.value == false);
}

#[test]
fn test_integer_positive() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let result = ebv(42, datatype);
    assert(result.success);
    assert(result.value == true);
}

#[test]
fn test_double_zero() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double");
    let result = ebv(0, datatype);
    assert(result.success);
    assert(result.value == false);
}

#[test]
fn test_double_non_zero() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double");
    // Non-zero value
    let result = ebv(123, datatype);
    assert(result.success);
    assert(result.value == true);
}

#[test]
fn test_decimal_zero() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#decimal");
    let result = ebv(0, datatype);
    assert(result.success);
    assert(result.value == false);
}

#[test]
fn test_float_non_zero() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#float");
    let result = ebv(100, datatype);
    assert(result.success);
    assert(result.value == true);
}

#[test]
fn test_unknown_type_error() {
    // Using a made-up datatype that's not in our supported list
    let datatype = encode_datatype_iri("http://example.org/unknownType");
    let result = ebv(42, datatype);
    assert(result.is_error());
}

#[test]
fn test_ebv_unchecked_boolean() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#boolean");
    let result = ebv_unchecked(1, datatype);
    assert(result == true);
}

#[test]
fn test_plain_literal_non_empty() {
    let value = consts::encode_string("test");
    // datatype is ignored when is_plain is true
    let datatype: Field = 0; // arbitrary value
    let result = ebv_with_plain(value, datatype, true);
    assert(result.success);
    assert(result.value == true);
}

#[test]
fn test_plain_literal_empty() {
    let value = consts::encode_string("");
    let datatype: Field = 0;
    let result = ebv_with_plain(value, datatype, true);
    assert(result.success);
    assert(result.value == false);
}

// Test derived integer types
#[test]
fn test_long_non_zero() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#long");
    let result = ebv(999, datatype);
    assert(result.success);
    assert(result.value == true);
}

#[test]
fn test_unsigned_int_zero() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedInt");
    let result = ebv(0, datatype);
    assert(result.success);
    assert(result.value == false);
}

#[test]
fn test_positive_integer() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#positiveInteger");
    // Note: positiveInteger technically can't be 0, but we test the EBV logic
    let result = ebv(1, datatype);
    assert(result.success);
    assert(result.value == true);
}

// Test negative integers (should be truthy since they're non-zero)
#[test]
fn test_integer_negative() {
    let datatype = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    // In Field arithmetic, -1 is a very large number (p-1 where p is the field modulus)
    // This tests that any non-zero value is truthy
    let neg_one: Field = 0 - 1;
    let result = ebv(neg_one, datatype);
    assert(result.success);
    assert(result.value == true);
}

// Test datatype classification functions
#[test]
fn test_is_boolean_datatype() {
    let bool_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#boolean");
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    
    assert(is_boolean_datatype(bool_type));
    assert(!is_boolean_datatype(int_type));
}

#[test]
fn test_is_string_datatype() {
    let str_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#string");
    let bool_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#boolean");
    
    assert(is_string_datatype(str_type));
    assert(!is_string_datatype(bool_type));
}

#[test]
fn test_is_numeric_datatype() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let float_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#float");
    let str_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#string");
    
    assert(is_numeric_datatype(int_type));
    assert(is_numeric_datatype(float_type));
    assert(!is_numeric_datatype(str_type));
}

// Test EBVResult methods
#[test]
fn test_ebv_result_unwrap_or() {
    let success_result = EBVResult::ok(true);
    let error_result = EBVResult::type_error();
    
    assert(success_result.unwrap_or(false) == true);
    assert(error_result.unwrap_or(true) == true);
    assert(error_result.unwrap_or(false) == false);
}
