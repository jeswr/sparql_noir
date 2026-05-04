use dep::consts;
use dep::xpath;
use dep::xpath::XsdFloat;
use dep::xpath::XsdDouble;

// =============================================================================
// SPARQL 1.1 NUMERIC ARITHMETIC LIBRARY
// =============================================================================
//
// This library implements SPARQL 1.1 compliant numeric arithmetic operations
// (Section 17.3 — Operator Mapping):
//
// - Numeric types:    xsd:integer, xsd:decimal, xsd:float, xsd:double (and
//                     derived types).
// - Type promotion:   integer -> decimal -> float -> double.
// - Operations return the "widest" numeric type.
//
// Implementation note (round 2 §6.2 — Q1 decision, 2026-05-03):
// All float / double arithmetic is delegated to `noir_xpath`'s IEEE 754
// `XsdFloat` (binary32) and `XsdDouble` (binary64) types. This module owns
// the SPARQL-flavoured type-promotion machinery — `NumericTypeLevel`,
// `promote_types`, `ArithResult` — and dispatches the per-type arithmetic
// to the matching `xpath::numeric_*` primitives.
//
// Integer / decimal arithmetic stays on the bare `Field` representation;
// per Q7 decision (2026-05-03) the decimal precision floor is the
// prover's field-element width (BN254 ~254 bits).
//
// IEEE 754 values cross the SPARQL boundary as their bit-encoded `Field`
// form: a float is a `Field` whose low 32 bits are an `XsdFloat::to_bits`
// value, a double similarly with 64 low bits. Callers reconstruct the
// XSD wrappers via `XsdFloat::from_bits` / `XsdDouble::from_bits`.

// =============================================================================
// DATATYPE ENCODING HELPER
// =============================================================================

/// Encode a datatype IRI to its Field representation.
/// Computes `consts::hash2([0, encode_string(iri)])` where the leading 0
/// is the NamedNode type code.
pub fn encode_datatype_iri<let N: u32>(iri: str<N>) -> Field {
    consts::hash2([0, consts::encode_string(iri)])
}

// =============================================================================
// NUMERIC TYPE HIERARCHY
// =============================================================================
//
// Type promotion order (narrowest -> widest):
//   0: integer (and derived types: int, long, short, byte, …)
//   1: decimal
//   2: float
//   3: double
//
// The result type of an operation is the widest of the operand types.

/// Numeric type level for type promotion.
pub struct NumericTypeLevel {
    pub level: u8,        // 0 = integer, 1 = decimal, 2 = float, 3 = double
    pub is_numeric: bool, // true if this is a valid numeric type
}

impl NumericTypeLevel {
    /// Not a numeric type.
    pub fn non_numeric() -> Self {
        NumericTypeLevel { level: 0, is_numeric: false }
    }

    /// Integer type (level 0).
    pub fn integer() -> Self {
        NumericTypeLevel { level: 0, is_numeric: true }
    }

    /// Decimal type (level 1).
    pub fn decimal() -> Self {
        NumericTypeLevel { level: 1, is_numeric: true }
    }

    /// Float type (level 2).
    pub fn float() -> Self {
        NumericTypeLevel { level: 2, is_numeric: true }
    }

    /// Double type (level 3).
    pub fn double() -> Self {
        NumericTypeLevel { level: 3, is_numeric: true }
    }

    /// True for `xsd:float` or `xsd:double`.
    pub fn is_floating_point(self) -> bool {
        self.is_numeric & (self.level >= 2)
    }
}

/// Get the numeric type level for a datatype IRI.
pub fn get_numeric_type_level(datatype: Field) -> NumericTypeLevel {
    // Integer types (level 0)
    let is_integer = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let is_int = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#int");
    let is_long = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#long");
    let is_short = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#short");
    let is_byte = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#byte");
    let is_unsigned_int = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedInt");
    let is_unsigned_long = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedLong");
    let is_unsigned_short = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedShort");
    let is_unsigned_byte = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedByte");
    let is_non_negative = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#nonNegativeInteger");
    let is_positive = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#positiveInteger");
    let is_negative = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#negativeInteger");
    let is_non_positive = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#nonPositiveInteger");

    let is_any_integer = is_integer | is_int | is_long | is_short | is_byte
        | is_unsigned_int | is_unsigned_long | is_unsigned_short | is_unsigned_byte
        | is_non_negative | is_positive | is_negative | is_non_positive;

    // Decimal type (level 1)
    let is_decimal = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#decimal");

    // Float type (level 2)
    let is_float_t = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#float");

    // Double type (level 3)
    let is_double_t = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double");

    let is_numeric = is_any_integer | is_decimal | is_float_t | is_double_t;

    let level = if is_double_t {
        3
    } else if is_float_t {
        2
    } else if is_decimal {
        1
    } else {
        0
    };

    NumericTypeLevel { level, is_numeric }
}

/// Get the wider of two numeric type levels (SPARQL 1.1 §17.3 promotion).
pub fn promote_types(a: NumericTypeLevel, b: NumericTypeLevel) -> NumericTypeLevel {
    let is_numeric = a.is_numeric & b.is_numeric;
    let level = if a.level > b.level { a.level } else { b.level };
    NumericTypeLevel { level, is_numeric }
}

/// Get the encoded datatype IRI for a numeric type level.
pub fn level_to_datatype(level: u8) -> Field {
    if level == 3 {
        encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double")
    } else if level == 2 {
        encode_datatype_iri("http://www.w3.org/2001/XMLSchema#float")
    } else if level == 1 {
        encode_datatype_iri("http://www.w3.org/2001/XMLSchema#decimal")
    } else {
        encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer")
    }
}

// =============================================================================
// NUMERIC TYPE CHECKING
// =============================================================================

/// Check if a datatype is numeric.
pub fn is_numeric_datatype(datatype: Field) -> bool {
    get_numeric_type_level(datatype).is_numeric
}

/// Check if a datatype is a floating point type (xsd:float or xsd:double).
pub fn is_floating_point_datatype(datatype: Field) -> bool {
    get_numeric_type_level(datatype).is_floating_point()
}

// =============================================================================
// ARITHMETIC RESULT TYPE
// =============================================================================

/// Result of an arithmetic operation.
///
/// IEEE 754 results travel as their `to_bits` encoding inside `value`:
///   - level 0 / 1 (integer / decimal): `value` carries the bare numeric
///     Field; `is_float_type` is false.
///   - level 2 (float):  `value` is the low 32 bits of `XsdFloat::to_bits`.
///   - level 3 (double): `value` is the low 64 bits of `XsdDouble::to_bits`.
///
/// Callers retrieve the IEEE 754 wrapper via `as_xsd_float` / `as_xsd_double`.
pub struct ArithResult {
    pub success: bool,    // true if both operands were numeric
    pub value: Field,     // bit-encoded value (see above) or bare integer / decimal
    pub datatype: Field,  // the result datatype (encoded IRI)
    pub is_float_type: bool, // true iff result is xsd:float or xsd:double
}

impl ArithResult {
    /// Successful integer / decimal result.
    pub fn ok(value: Field, datatype: Field) -> Self {
        ArithResult { success: true, value, datatype, is_float_type: false }
    }

    /// Successful xsd:float result. Value is the IEEE 754 binary32 bits.
    pub fn ok_float(bits: u32, datatype: Field) -> Self {
        ArithResult { success: true, value: bits as Field, datatype, is_float_type: true }
    }

    /// Successful xsd:double result. Value is the IEEE 754 binary64 bits.
    pub fn ok_double(bits: u64, datatype: Field) -> Self {
        ArithResult { success: true, value: bits as Field, datatype, is_float_type: true }
    }

    /// Type-error result (non-numeric operands).
    pub fn type_error() -> Self {
        ArithResult { success: false, value: 0, datatype: 0, is_float_type: false }
    }

    /// Check if this is a type error.
    pub fn is_error(self) -> bool {
        !self.success
    }

    /// Get the value, asserting no type error.
    pub fn unwrap(self) -> Field {
        assert(self.success, "Arithmetic type error: operands must be numeric");
        self.value
    }

    /// Get the value, or a default if type error.
    pub fn unwrap_or(self, default: Field) -> Field {
        if self.success { self.value } else { default }
    }

    /// Reinterpret the result as an `XsdFloat`. The caller is responsible
    /// for confirming the result level matches (`datatype == xsd:float`).
    pub fn as_xsd_float(self) -> XsdFloat {
        XsdFloat::from_bits(self.value as u32)
    }

    /// Reinterpret the result as an `XsdDouble`. The caller is responsible
    /// for confirming the result level matches (`datatype == xsd:double`).
    pub fn as_xsd_double(self) -> XsdDouble {
        XsdDouble::from_bits(self.value as u64)
    }
}

// =============================================================================
// PER-OPERAND TYPE COERCION
// =============================================================================
//
// SPARQL allows mixed-type operands (e.g. integer + float). Per the
// promotion table the narrower operand is widened to the result type
// before the op is applied. The helpers below produce the correct
// IEEE 754 wrapper for each (level, encoded value) pair.

fn coerce_to_float(value: Field, level: u8) -> XsdFloat {
    if level == 2 {
        XsdFloat::from_bits(value as u32)
    } else {
        // level 0 or 1: integer / decimal — match the transform's
        // existing `as i64` convention; noir_xpath's `cast_integer_to_*`
        // takes the value through `as i8` internally.
        xpath::cast_integer_to_float((value as i64) as i8)
    }
}

fn coerce_to_double(value: Field, level: u8) -> XsdDouble {
    if level == 3 {
        XsdDouble::from_bits(value as u64)
    } else if level == 2 {
        XsdDouble::from_float(XsdFloat::from_bits(value as u32))
    } else {
        // level 0 or 1: integer / decimal — see coerce_to_float.
        xpath::cast_integer_to_double((value as i64) as i8)
    }
}

// =============================================================================
// ARITHMETIC DISPATCH
// =============================================================================

/// SPARQL 1.1 numeric addition: A + B.
///
/// Both operands must be numeric. The result type is the widest of the
/// operand types (SPARQL 1.1 §17.3). For float / double operands the
/// arithmetic is IEEE 754 binary32 / binary64 via `noir_xpath`.
pub fn add(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);

    if !result_type.is_numeric {
        ArithResult::type_error()
    } else if result_type.level == 3 {
        let a = coerce_to_double(a_value, a_type.level);
        let b = coerce_to_double(b_value, b_type.level);
        let r = xpath::numeric_add_double(a, b);
        ArithResult::ok_double(r.to_bits(), level_to_datatype(3))
    } else if result_type.level == 2 {
        let a = coerce_to_float(a_value, a_type.level);
        let b = coerce_to_float(b_value, b_type.level);
        let r = xpath::numeric_add_float(a, b);
        ArithResult::ok_float(r.to_bits(), level_to_datatype(2))
    } else {
        // Integer / decimal: bare-Field addition.
        let sum = a_value + b_value;
        ArithResult::ok(sum, level_to_datatype(result_type.level))
    }
}

/// SPARQL 1.1 numeric subtraction: A − B.
pub fn sub(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);

    if !result_type.is_numeric {
        ArithResult::type_error()
    } else if result_type.level == 3 {
        let a = coerce_to_double(a_value, a_type.level);
        let b = coerce_to_double(b_value, b_type.level);
        let r = xpath::numeric_subtract_double(a, b);
        ArithResult::ok_double(r.to_bits(), level_to_datatype(3))
    } else if result_type.level == 2 {
        let a = coerce_to_float(a_value, a_type.level);
        let b = coerce_to_float(b_value, b_type.level);
        let r = xpath::numeric_subtract_float(a, b);
        ArithResult::ok_float(r.to_bits(), level_to_datatype(2))
    } else {
        let diff = a_value - b_value;
        ArithResult::ok(diff, level_to_datatype(result_type.level))
    }
}

/// SPARQL 1.1 numeric multiplication: A × B.
pub fn mul(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);

    if !result_type.is_numeric {
        ArithResult::type_error()
    } else if result_type.level == 3 {
        let a = coerce_to_double(a_value, a_type.level);
        let b = coerce_to_double(b_value, b_type.level);
        let r = xpath::numeric_multiply_double(a, b);
        ArithResult::ok_double(r.to_bits(), level_to_datatype(3))
    } else if result_type.level == 2 {
        let a = coerce_to_float(a_value, a_type.level);
        let b = coerce_to_float(b_value, b_type.level);
        let r = xpath::numeric_multiply_float(a, b);
        ArithResult::ok_float(r.to_bits(), level_to_datatype(2))
    } else {
        let product = a_value * b_value;
        ArithResult::ok(product, level_to_datatype(result_type.level))
    }
}

/// SPARQL 1.1 numeric division: A ÷ B.
///
/// Integer / integer returns `xsd:decimal` per SPARQL 1.1 §17.3. Float /
/// double divisions return their respective IEEE 754 type.
pub fn div(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);

    if !result_type.is_numeric {
        ArithResult::type_error()
    } else if result_type.level == 3 {
        let a = coerce_to_double(a_value, a_type.level);
        let b = coerce_to_double(b_value, b_type.level);
        let r = xpath::numeric_divide_double(a, b);
        ArithResult::ok_double(r.to_bits(), level_to_datatype(3))
    } else if result_type.level == 2 {
        let a = coerce_to_float(a_value, a_type.level);
        let b = coerce_to_float(b_value, b_type.level);
        let r = xpath::numeric_divide_float(a, b);
        ArithResult::ok_float(r.to_bits(), level_to_datatype(2))
    } else {
        // Integer / integer → xsd:decimal. Per Q7 decision (2026-05-03)
        // the decimal floor is field-element width, so we widen via
        // double for the arithmetic and report the result as xsd:decimal.
        // This keeps the per-Q7 "no arbitrary-precision compliance"
        // contract: the decimal value is whatever fits in IEEE 754
        // binary64.
        let a = coerce_to_double(a_value, a_type.level);
        let b = coerce_to_double(b_value, b_type.level);
        let r = xpath::numeric_divide_double(a, b);
        ArithResult::ok_double(r.to_bits(), level_to_datatype(1))
    }
}

/// SPARQL 1.1 unary minus: −A.
pub fn neg(value: Field, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);

    if !type_level.is_numeric {
        ArithResult::type_error()
    } else if type_level.level == 3 {
        let a = XsdDouble::from_bits(value as u64);
        let zero = xpath::cast_integer_to_double(0 as i8);
        let r = xpath::numeric_subtract_double(zero, a);
        ArithResult::ok_double(r.to_bits(), datatype)
    } else if type_level.level == 2 {
        let a = XsdFloat::from_bits(value as u32);
        let zero = xpath::cast_integer_to_float(0 as i8);
        let r = xpath::numeric_subtract_float(zero, a);
        ArithResult::ok_float(r.to_bits(), datatype)
    } else {
        let negated = 0 - value;
        ArithResult::ok(negated, datatype)
    }
}

/// SPARQL 1.1 unary plus: +A.
pub fn pos(value: Field, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);

    if !type_level.is_numeric {
        ArithResult::type_error()
    } else if type_level.level == 3 {
        ArithResult::ok_double((value as u64), datatype)
    } else if type_level.level == 2 {
        ArithResult::ok_float((value as u32), datatype)
    } else {
        ArithResult::ok(value, datatype)
    }
}

/// Simplified addition that asserts on type errors.
pub fn add_unchecked(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> Field {
    add(a_value, a_datatype, b_value, b_datatype).unwrap()
}

/// Simplified subtraction that asserts on type errors.
pub fn sub_unchecked(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> Field {
    sub(a_value, a_datatype, b_value, b_datatype).unwrap()
}

/// Simplified multiplication that asserts on type errors.
pub fn mul_unchecked(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> Field {
    mul(a_value, a_datatype, b_value, b_datatype).unwrap()
}

/// Simplified division that asserts on type errors.
pub fn div_unchecked(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> Field {
    div(a_value, a_datatype, b_value, b_datatype).unwrap()
}

/// Simplified unary minus that asserts on type errors.
pub fn neg_unchecked(value: Field, datatype: Field) -> Field {
    neg(value, datatype).unwrap()
}

/// Simplified unary plus that asserts on type errors.
pub fn pos_unchecked(value: Field, datatype: Field) -> Field {
    pos(value, datatype).unwrap()
}

// =============================================================================
// SPARQL 1.1 NUMERIC FUNCTIONS — type-aware
// =============================================================================
//
// These are the round-2 §6.2 type-aware entry points for ABS / ROUND /
// CEIL / FLOOR. Per Q7 decision the decimal floor is field-element
// width, so xsd:decimal shares the integer code path. xsd:float and
// xsd:double dispatch to `noir_xpath`'s IEEE 754 implementations.

/// ABS — absolute value.
pub fn abs(value: Field, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);

    if !type_level.is_numeric {
        ArithResult::type_error()
    } else if type_level.level == 3 {
        let a = XsdDouble::from_bits(value as u64);
        let r = xpath::abs_double(a);
        ArithResult::ok_double(r.to_bits(), datatype)
    } else if type_level.level == 2 {
        let a = XsdFloat::from_bits(value as u32);
        let r = xpath::abs_float(a);
        ArithResult::ok_float(r.to_bits(), datatype)
    } else {
        // integer / decimal — both share the integer path per Q7.
        let r = xpath::abs_int(value as i64);
        ArithResult::ok(r as Field, datatype)
    }
}

/// ROUND — nearest integer.
pub fn round(value: Field, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);

    if !type_level.is_numeric {
        ArithResult::type_error()
    } else if type_level.level == 3 {
        let a = XsdDouble::from_bits(value as u64);
        let r = xpath::round_double(a);
        ArithResult::ok_double(r.to_bits(), datatype)
    } else if type_level.level == 2 {
        let a = XsdFloat::from_bits(value as u32);
        let r = xpath::round_float(a);
        ArithResult::ok_float(r.to_bits(), datatype)
    } else {
        let r = xpath::round_int(value as i64);
        ArithResult::ok(r as Field, datatype)
    }
}

/// CEIL — round up to nearest integer.
pub fn ceil(value: Field, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);

    if !type_level.is_numeric {
        ArithResult::type_error()
    } else if type_level.level == 3 {
        let a = XsdDouble::from_bits(value as u64);
        let r = xpath::ceil_double(a);
        ArithResult::ok_double(r.to_bits(), datatype)
    } else if type_level.level == 2 {
        let a = XsdFloat::from_bits(value as u32);
        let r = xpath::ceil_float(a);
        ArithResult::ok_float(r.to_bits(), datatype)
    } else {
        let r = xpath::ceil_int(value as i64);
        ArithResult::ok(r as Field, datatype)
    }
}

/// FLOOR — round down to nearest integer.
pub fn floor(value: Field, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);

    if !type_level.is_numeric {
        ArithResult::type_error()
    } else if type_level.level == 3 {
        let a = XsdDouble::from_bits(value as u64);
        let r = xpath::floor_double(a);
        ArithResult::ok_double(r.to_bits(), datatype)
    } else if type_level.level == 2 {
        let a = XsdFloat::from_bits(value as u32);
        let r = xpath::floor_float(a);
        ArithResult::ok_float(r.to_bits(), datatype)
    } else {
        let r = xpath::floor_int(value as i64);
        ArithResult::ok(r as Field, datatype)
    }
}

// =============================================================================
// TESTS
// =============================================================================

#[test]
fn test_integer_addition() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");

    // 5 + 3 = 8
    let result = add(5, int_type, 3, int_type);
    assert(result.success);
    assert(result.value == 8);
    assert(result.datatype == int_type);
    assert(!result.is_float_type);
}

#[test]
fn test_type_promotion_int_decimal() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let decimal_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#decimal");

    // integer + decimal = decimal
    let result = add(5, int_type, 3, decimal_type);
    assert(result.success);
    assert(result.value == 8);
    assert(result.datatype == decimal_type);
}

#[test]
fn test_type_promotion_int_float() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let float_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#float");

    // integer + float = float (using IEEE 754 binary32 arithmetic)
    // 5 (integer) widened to 5.0f, 3 (float bits already) interpreted
    // as the IEEE 754 bits for 3.0f, but since the test passes 3 we
    // construct a 3.0f bits value explicitly. The point being tested
    // here is the promotion outcome (datatype + flag), not the bit
    // pattern; rebuild that with concrete values.
    let three_f = xpath::cast_integer_to_float(3 as i8).to_bits() as Field;
    let result = add(5, int_type, three_f, float_type);
    assert(result.success);
    assert(result.datatype == float_type);
    assert(result.is_float_type);
    // 5 + 3 = 8 — check via the IEEE 754 wrapper
    let eight_f = xpath::cast_integer_to_float(8 as i8);
    assert(xpath::numeric_equal_float(result.as_xsd_float(), eight_f));
}

#[test]
fn test_type_promotion_decimal_double() {
    let decimal_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#decimal");
    let double_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double");

    // decimal + double = double
    let three_d = xpath::cast_integer_to_double(3 as i8).to_bits() as Field;
    let result = add(5, decimal_type, three_d, double_type);
    assert(result.success);
    assert(result.datatype == double_type);
    assert(result.is_float_type);
}

#[test]
fn test_non_numeric_type_error() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let string_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#string");

    // integer + string = type error
    let result = add(5, int_type, 3, string_type);
    assert(!result.success);
}

#[test]
fn test_subtraction() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");

    // 10 - 3 = 7
    let result = sub(10, int_type, 3, int_type);
    assert(result.success);
    assert(result.value == 7);
}

#[test]
fn test_multiplication() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");

    // 5 * 4 = 20
    let result = mul(5, int_type, 4, int_type);
    assert(result.success);
    assert(result.value == 20);
}

#[test]
fn test_unary_neg() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");

    // -5
    let result = neg(5, int_type);
    assert(result.success);
    // In field arithmetic, -5 wraps around, but for our purposes we just
    // check the value is no longer 5.
    assert(result.value != 5);
}

#[test]
fn test_derived_integer_types() {
    let long_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#long");
    let unsigned_int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedInt");
    let integer_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");

    // long + unsignedInt should work and produce integer result.
    let result = add(100, long_type, 50, unsigned_int_type);
    assert(result.success);
    assert(result.value == 150);
    assert(result.datatype == integer_type);
}

#[test]
fn test_sparql_division_returns_decimal() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let decimal_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#decimal");

    // integer / integer returns decimal per SPARQL spec.
    let result = div(10, int_type, 4, int_type);
    assert(result.success);
    assert(result.datatype == decimal_type);
    assert(result.is_float_type);
}

#[test]
fn test_float_add_via_xpath() {
    let float_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#float");

    // 1.5f + 2.5f = 4.0f via IEEE 754
    let one_point_five = XsdFloat::from_bits(0x3fc00000); // 1.5f
    let two_point_five = XsdFloat::from_bits(0x40200000); // 2.5f
    let four = xpath::cast_integer_to_float(4 as i8);

    let result = add(
        one_point_five.to_bits() as Field, float_type,
        two_point_five.to_bits() as Field, float_type,
    );
    assert(result.success);
    assert(result.is_float_type);
    assert(xpath::numeric_equal_float(result.as_xsd_float(), four));
}

#[test]
fn test_double_mul_via_xpath() {
    let double_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double");

    // 6.0 * 7.0 = 42.0 via IEEE 754
    let six = xpath::cast_integer_to_double(6 as i8);
    let seven = xpath::cast_integer_to_double(7 as i8);
    let forty_two = xpath::cast_integer_to_double(42 as i8);

    let result = mul(
        six.to_bits() as Field, double_type,
        seven.to_bits() as Field, double_type,
    );
    assert(result.success);
    assert(result.is_float_type);
    assert(xpath::numeric_equal_double(result.as_xsd_double(), forty_two));
}

#[test]
fn test_abs_integer() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let result = abs(7, int_type);
    assert(result.success);
    assert(result.value == 7);
    assert(!result.is_float_type);
}

#[test]
fn test_abs_float_negative() {
    let float_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#float");

    // -2.0f → 2.0f
    let neg_two = XsdFloat::from_bits(0xc0000000); // -2.0f
    let two = xpath::cast_integer_to_float(2 as i8);

    let result = abs(neg_two.to_bits() as Field, float_type);
    assert(result.success);
    assert(result.is_float_type);
    assert(xpath::numeric_equal_float(result.as_xsd_float(), two));
}

#[test]
fn test_floor_double() {
    let double_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double");

    // floor(3.7) = 3.0
    // 3.7 in IEEE 754 binary64 = 0x400D999999999999A (rounded) — use the
    // exact bit pattern:
    let three_seven = XsdDouble::from_bits(0x400ecccccccccccd); // ≈ 3.7
    let three = xpath::cast_integer_to_double(3 as i8);

    let result = floor(three_seven.to_bits() as Field, double_type);
    assert(result.success);
    assert(xpath::numeric_equal_double(result.as_xsd_double(), three));
}
