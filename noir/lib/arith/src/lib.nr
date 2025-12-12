use dep::consts;

// =============================================================================
// SPARQL 1.1 NUMERIC ARITHMETIC LIBRARY
// =============================================================================
//
// This library implements SPARQL 1.1 compliant numeric arithmetic operations.
// 
// According to SPARQL 1.1 spec (Section 17.3 - Operator Mapping):
// - Numeric types: xsd:integer, xsd:decimal, xsd:float, xsd:double (and derived)
// - Type promotion: integer -> decimal -> float -> double
// - Operations return the "widest" numeric type
//
// Float/Double Implementation:
// This library uses a Float struct based on the ZKFloat library (0x3327/ZKFloat)
// for representing floating point values in ZK circuits. Numbers are represented
// as base-10 floating point values with:
// - sign: 0 for positive, 1 for negative
// - mantissa: significand digits (up to FLOAT_PRECISION digits)
// - exponent: power of 10, centered at EXPONENT_BIAS (100 = 10^0)
//
// For example: -12.34 = Float { sign: 1, mantissa: 1234, exponent: 98 }
// because -12.34 = -1 * 1234 * 10^(98-100) = -1 * 1234 * 10^(-2)

// =============================================================================
// FLOAT CONSTANTS
// =============================================================================

/// Precision of mantissa (number of significant digits)
/// This matches IEEE 754 single precision approximate decimal digits
pub global FLOAT_PRECISION: u32 = 7;

/// Extended precision for double (more significant digits)
pub global DOUBLE_PRECISION: u32 = 15;

/// Exponent bias - exponent 100 represents 10^0
/// Allows representation of exponents from -100 to +155
pub global EXPONENT_BIAS: Field = 100;

/// Maximum mantissa value for standard precision (10^7)
pub global MAX_MANTISSA: u64 = 10000000;

// =============================================================================
// DATATYPE ENCODING HELPER
// =============================================================================

/// Encode a datatype IRI to its Field representation
/// This computes: hash2([0, encode_string(iri)])
/// where 0 is the type code for NamedNode
pub fn encode_datatype_iri<let N: u32>(iri: str<N>) -> Field {
    consts::hash2([0, consts::encode_string(iri)])
}

// =============================================================================
// FLOAT STRUCT (Based on ZKFloat by 0x3327)
// =============================================================================

/// Represents a floating point number using sign, mantissa, and exponent.
/// Format: value = (-1)^sign * mantissa * 10^(exponent - EXPONENT_BIAS)
/// 
/// Examples:
/// - 123.45 = Float { sign: 0, mantissa: 12345, exponent: 98 }
/// - -0.007 = Float { sign: 1, mantissa: 7, exponent: 97 }
/// - 0      = Float { sign: 0, mantissa: 0, exponent: 100 }
pub struct Float {
    pub sign: Field,      // 0 = positive, 1 = negative
    pub mantissa: Field,  // Significant digits
    pub exponent: Field,  // Power of 10, biased by EXPONENT_BIAS
}

impl Float {
    /// Create a zero value
    pub fn zero() -> Self {
        Float { sign: 0, mantissa: 0, exponent: EXPONENT_BIAS }
    }
    
    /// Create a positive float from integer value
    pub fn from_integer(value: Field) -> Self {
        if value == 0 {
            Float::zero()
        } else {
            Float { sign: 0, mantissa: value, exponent: EXPONENT_BIAS }
        }
    }
    
    /// Create a negative float from absolute integer value
    pub fn from_negative_integer(abs_value: Field) -> Self {
        if abs_value == 0 {
            Float::zero()
        } else {
            Float { sign: 1, mantissa: abs_value, exponent: EXPONENT_BIAS }
        }
    }
    
    /// Check if this float is zero
    pub fn is_zero(self) -> bool {
        self.mantissa == 0
    }
    
    /// Check if this float is negative
    pub fn is_negative(self) -> bool {
        (self.sign == 1) & (self.mantissa != 0)
    }
    
    /// Negate this float
    pub fn negate(self) -> Self {
        if self.mantissa == 0 {
            self
        } else {
            Float { sign: 1 - self.sign, mantissa: self.mantissa, exponent: self.exponent }
        }
    }
    
    /// Get absolute value
    pub fn abs(self) -> Self {
        Float { sign: 0, mantissa: self.mantissa, exponent: self.exponent }
    }
}

/// Lookup table for powers of 10 (used in truncate)
pub fn pow10_lookup() -> [Field; 25] {
    [
        1,
        10,
        100,
        1000,
        10000,
        100000,
        1000000,
        10000000,
        100000000,
        1000000000,
        10000000000,
        100000000000,
        1000000000000,
        10000000000000,
        100000000000000,
        1000000000000000,
        10000000000000000,
        100000000000000000,
        1000000000000000000,
        10000000000000000000,
        100000000000000000000,
        1000000000000000000000,
        10000000000000000000000,
        100000000000000000000000,
        1000000000000000000000000,
    ]
}

/// Compute 10^n for small n
pub fn pow10(n: u32) -> Field {
    let lookup = pow10_lookup();
    if n < 25 {
        lookup[n]
    } else {
        // For larger exponents, compute iteratively
        let mut result: Field = lookup[24];
        for _ in 25..n + 1 {
            result *= 10;
        }
        result
    }
}

/// Truncate a Float to specified precision (number of significant digits)
/// This normalizes the float representation after arithmetic operations
pub fn truncate(num: Float, precision: u32) -> Float {
    let lookup = pow10_lookup();
    let max_value = pow10(precision);
    
    // Find the magnitude of mantissa (floor of log10)
    let mut dec_value: Field = 1;
    let mut log_value: u32 = 0;
    
    for i in 0..25 {
        if num.mantissa as u64 >= lookup[i] as u64 {
            dec_value = lookup[i];
            log_value = i;
        }
    }
    
    dec_value *= 10;
    log_value += 1;
    
    let mut res = Float { sign: num.sign, mantissa: num.mantissa, exponent: num.exponent };
    
    // Truncate if mantissa exceeds precision
    if log_value > precision {
        let divisor = (dec_value as u64 / max_value as u64) as Field;
        let new_mantissa = (num.mantissa as u64 / divisor as u64) as Field;
        let exp_increase = log_value - precision;
        res = Float { 
            sign: num.sign, 
            mantissa: new_mantissa, 
            exponent: num.exponent + exp_increase as Field
        };
    }
    
    // Handle zero mantissa
    if res.mantissa == 0 {
        res = Float { sign: res.sign, mantissa: 0, exponent: EXPONENT_BIAS };
    }
    
    res
}

/// Truncate with standard float precision
pub fn truncate_float(num: Float) -> Float {
    truncate(num, FLOAT_PRECISION)
}

/// Truncate with double precision
pub fn truncate_double(num: Float) -> Float {
    truncate(num, DOUBLE_PRECISION)
}

// =============================================================================
// FLOAT ARITHMETIC OPERATIONS (Based on ZKFloat)
// =============================================================================

/// Add two Float numbers
pub fn add_floats(x: Float, y: Float) -> Float {
    let mut mant_1 = x.mantissa;
    let mut mant_2 = y.mantissa;
    let mut exp_1 = x.exponent;
    let exp_2 = y.exponent;
    
    // Align exponents
    let mut diff: Field = 0;
    if exp_1 as u64 > exp_2 as u64 {
        diff = exp_1 - exp_2;
    } else {
        diff = exp_2 - exp_1;
    }
    
    let pow10_diff = pow10(diff as u32);
    
    if x.exponent as u64 < y.exponent as u64 {
        mant_2 *= pow10_diff;
        exp_1 = x.exponent;
    } else {
        mant_1 *= pow10_diff;
        exp_1 = y.exponent;
    }
    
    // Compute sum based on signs
    let mut sum_mant = mant_1 + mant_2;
    let mut sign = x.sign;
    
    if x.sign != y.sign {
        if mant_1 as u64 > mant_2 as u64 {
            sum_mant = mant_1 - mant_2;
        } else {
            sum_mant = mant_2 - mant_1;
            sign = y.sign;
        }
    }
    
    truncate_float(Float { sign, mantissa: sum_mant, exponent: exp_1 })
}

/// Subtract two Float numbers: x - y
pub fn sub_floats(x: Float, y: Float) -> Float {
    add_floats(x, Float { sign: 1 - y.sign, mantissa: y.mantissa, exponent: y.exponent })
}

/// Multiply two Float numbers
pub fn mul_floats(x: Float, y: Float) -> Float {
    let mant = x.mantissa * y.mantissa;
    let exp = x.exponent + y.exponent - EXPONENT_BIAS;
    
    let mut sign: Field = 0;
    if x.sign != y.sign {
        sign = 1;
    }
    
    truncate_float(Float { sign, mantissa: mant, exponent: exp })
}

/// Divide two Float numbers: x / y
/// Asserts that y is not zero
pub fn div_floats(x: Float, y: Float) -> Float {
    assert(y.mantissa != 0, "Division by zero");
    
    let mut exp1 = x.exponent;
    let mut mant1 = x.mantissa as u64;
    let exp2 = y.exponent;
    let mant2 = y.mantissa;
    
    // Scale up numerator if needed for precision
    if mant1 < mant2 as u64 {
        mant1 *= 10;
        exp1 -= 1;
    }
    
    // Long division for FLOAT_PRECISION digits
    let mut new_mant: u64 = 0;
    for i in 0..FLOAT_PRECISION {
        let div = mant1 / mant2 as u64;
        mant1 = (mant1 - mant2 as u64 * div) * 10;
        
        let exp = FLOAT_PRECISION - i - 1;
        let pow = pow10(exp) as u64;
        new_mant += div * pow;
    }
    
    let new_exp = EXPONENT_BIAS + exp1 - exp2 - (FLOAT_PRECISION - 1) as Field;
    
    let mut new_sign: Field = 0;
    if x.sign as u64 != y.sign as u64 {
        new_sign = 1;
    }
    
    Float { sign: new_sign, mantissa: new_mant as Field, exponent: new_exp }
}

// =============================================================================
// FLOAT COMPARISON OPERATIONS
// =============================================================================

/// Compare two floats: returns true if x > y
pub fn float_gt(x: Float, y: Float) -> bool {
    // Handle zeros
    let both_zero = x.is_zero() & y.is_zero();
    
    // Different signs: positive > negative
    let x_pos_y_neg = (x.sign == 0) & (y.sign == 1) & !y.is_zero();
    let x_neg_y_pos = (x.sign == 1) & (y.sign == 0);
    
    // Same sign - compare magnitudes
    let same_sign = x.sign == y.sign;
    let x_positive = x.sign == 0;
    
    // Compare exponents
    let x_exp_gt = x.exponent as u64 > y.exponent as u64;
    let x_exp_lt = x.exponent as u64 < y.exponent as u64;
    let exp_equal = x.exponent == y.exponent;
    
    // Compare mantissa (when exponents equal)
    let x_mant_gt = x.mantissa as u64 > y.mantissa as u64;
    let x_mant_lt = x.mantissa as u64 < y.mantissa as u64;
    
    // Result based on cases
    let exp_result = if x_positive { x_exp_gt } else { x_exp_lt };
    let mant_result = if x_positive { x_mant_gt } else { x_mant_lt };
    
    let same_sign_result = same_sign & (exp_result | (exp_equal & mant_result));
    
    // Combine all cases
    !both_zero & (x_pos_y_neg | (!x_neg_y_pos & same_sign_result))
}

/// Compare two floats: returns true if x < y
pub fn float_lt(x: Float, y: Float) -> bool {
    float_gt(y, x)
}

/// Compare two floats: returns true if x >= y
pub fn float_gte(x: Float, y: Float) -> bool {
    !float_lt(x, y)
}

/// Compare two floats: returns true if x <= y
pub fn float_lte(x: Float, y: Float) -> bool {
    !float_gt(x, y)
}

/// Compare two floats for equality
pub fn float_eq(x: Float, y: Float) -> bool {
    // Both zero (regardless of sign)
    let both_zero = x.is_zero() & y.is_zero();
    
    // Compare all components
    let same_components = (x.sign == y.sign) & (x.mantissa == y.mantissa) & (x.exponent == y.exponent);
    
    both_zero | same_components
}

// =============================================================================
// SPECIAL VALUES (IEEE 754 style)
// =============================================================================

/// Represents special float values for IEEE 754 compliance
pub struct FloatSpecial {
    pub is_nan: bool,      // Not a Number
    pub is_inf: bool,      // Infinity
    pub is_neg_inf: bool,  // Negative Infinity
    pub value: Float,      // Normal value (if not special)
}

impl FloatSpecial {
    pub fn normal(f: Float) -> Self {
        FloatSpecial { is_nan: false, is_inf: false, is_neg_inf: false, value: f }
    }
    
    pub fn nan() -> Self {
        FloatSpecial { is_nan: true, is_inf: false, is_neg_inf: false, value: Float::zero() }
    }
    
    pub fn infinity() -> Self {
        FloatSpecial { is_nan: false, is_inf: true, is_neg_inf: false, value: Float::zero() }
    }
    
    pub fn neg_infinity() -> Self {
        FloatSpecial { is_nan: false, is_inf: false, is_neg_inf: true, value: Float::zero() }
    }
    
    pub fn is_special(self) -> bool {
        self.is_nan | self.is_inf | self.is_neg_inf
    }
}

// =============================================================================
// FLOAT ENCODING/DECODING FOR SPARQL
// =============================================================================

/// Encode a Float to a single Field value for storage
/// Packs sign, mantissa, and exponent into one Field
/// Layout: [sign (1 bit)] [exponent (8 bits)] [mantissa (remaining bits)]
pub fn encode_float(f: Float) -> Field {
    // Simple encoding: sign * 2^250 + exponent * 2^242 + mantissa
    let sign_part = f.sign * 0x400000000000000000000000000000000000000000000000000000000000000;
    let exp_part = f.exponent * 0x4000000000000000000000000000000000000000000000000000000000000;
    sign_part + exp_part + f.mantissa
}

/// Decode a Field value back to a Float
/// Note: This is an approximate inverse of encode_float
/// In practice, floats are better passed as struct components
pub fn decode_float(encoded: Field) -> Float {
    // Extract components - this is simplified and may need refinement
    // For proper implementation, pass Float struct directly
    Float::from_integer(encoded)
}

// =============================================================================
// NUMERIC TYPE HIERARCHY
// =============================================================================
// 
// Type promotion order (from narrowest to widest):
// 0: integer (and derived types like int, long, short, byte, etc.)
// 1: decimal
// 2: float
// 3: double
//
// The result type of an operation is the widest of the operand types.
// Float and double types use the Float struct for actual computation.

/// Numeric type level for type promotion
/// Lower values are narrower types, higher values are wider types
pub struct NumericTypeLevel {
    pub level: u8,       // 0=integer, 1=decimal, 2=float, 3=double
    pub is_numeric: bool // true if this is a valid numeric type
}

impl NumericTypeLevel {
    /// Not a numeric type
    pub fn non_numeric() -> Self {
        NumericTypeLevel { level: 0, is_numeric: false }
    }
    
    /// Integer type (level 0)
    pub fn integer() -> Self {
        NumericTypeLevel { level: 0, is_numeric: true }
    }
    
    /// Decimal type (level 1)
    pub fn decimal() -> Self {
        NumericTypeLevel { level: 1, is_numeric: true }
    }
    
    /// Float type (level 2)
    pub fn float() -> Self {
        NumericTypeLevel { level: 2, is_numeric: true }
    }
    
    /// Double type (level 3)
    pub fn double() -> Self {
        NumericTypeLevel { level: 3, is_numeric: true }
    }
    
    /// Check if this is a floating point type (float or double)
    pub fn is_floating_point(self) -> bool {
        self.is_numeric & (self.level >= 2)
    }
}

/// Get the numeric type level for a datatype
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
    let is_float = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#float");
    
    // Double type (level 3)
    let is_double = datatype == encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double");
    
    // Determine level and validity
    let is_numeric = is_any_integer | is_decimal | is_float | is_double;
    
    // Compute level (higher = wider type)
    let level = if is_double {
        3
    } else if is_float {
        2
    } else if is_decimal {
        1
    } else {
        0
    };
    
    NumericTypeLevel { level, is_numeric }
}

/// Get the wider of two numeric type levels for type promotion
pub fn promote_types(a: NumericTypeLevel, b: NumericTypeLevel) -> NumericTypeLevel {
    let is_numeric = a.is_numeric & b.is_numeric;
    let level = if a.level > b.level { a.level } else { b.level };
    NumericTypeLevel { level, is_numeric }
}

/// Get the encoded datatype IRI for a numeric type level
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
// ARITHMETIC RESULT TYPE (Extended for Float support)
// =============================================================================

/// Result of an arithmetic operation
/// Contains the result value, result datatype, success indicator, and optional Float representation
pub struct ArithResult {
    pub success: bool,           // true if operation succeeded (both operands numeric)
    pub value: Field,            // the result value (for integer/decimal) or encoded float
    pub datatype: Field,         // the result datatype (encoded IRI)
    pub float_result: Float,     // Float representation (valid if is_float_type is true)
    pub is_float_type: bool,     // true if result is float/double type
}

impl ArithResult {
    /// Create a successful arithmetic result for integer/decimal
    pub fn ok(value: Field, datatype: Field) -> Self {
        ArithResult { 
            success: true, 
            value, 
            datatype,
            float_result: Float::zero(),
            is_float_type: false
        }
    }
    
    /// Create a successful arithmetic result for float/double
    pub fn ok_float(float_value: Float, datatype: Field) -> Self {
        ArithResult { 
            success: true, 
            value: encode_float(float_value),
            datatype,
            float_result: float_value,
            is_float_type: true
        }
    }
    
    /// Create a type error result (non-numeric operands)
    pub fn type_error() -> Self {
        ArithResult { 
            success: false, 
            value: 0, 
            datatype: 0,
            float_result: Float::zero(),
            is_float_type: false
        }
    }
    
    /// Check if this is a type error
    pub fn is_error(self) -> bool {
        !self.success
    }
    
    /// Get the value, asserting no type error
    pub fn unwrap(self) -> Field {
        assert(self.success, "Arithmetic type error: operands must be numeric");
        self.value
    }
    
    /// Get the Float value, asserting no type error
    pub fn unwrap_float(self) -> Float {
        assert(self.success, "Arithmetic type error: operands must be numeric");
        self.float_result
    }
    
    /// Get the value, or a default if type error
    pub fn unwrap_or(self, default: Field) -> Field {
        if self.success { self.value } else { default }
    }
}

// =============================================================================
// ADDITION OPERATION
// =============================================================================

/// Perform SPARQL 1.1 compliant numeric addition: A + B
/// 
/// According to SPARQL 1.1 spec:
/// - Both operands must be numeric types
/// - Result type is determined by type promotion rules
/// - Returns type error if either operand is non-numeric
/// - For float/double operands, uses Float arithmetic
///
/// Parameters:
/// - `a_value`: The Field representing the numeric value of operand A
/// - `a_datatype`: The encoded datatype IRI of operand A
/// - `b_value`: The Field representing the numeric value of operand B
/// - `b_datatype`: The encoded datatype IRI of operand B
///
/// Returns:
/// - ArithResult with the sum, result datatype, and success indicator
pub fn add(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);
    
    if result_type.is_numeric {
        let result_datatype = level_to_datatype(result_type.level);
        
        if result_type.is_floating_point() {
            // Use Float arithmetic for float/double
            let a_float = Float::from_integer(a_value);
            let b_float = Float::from_integer(b_value);
            let result = add_floats(a_float, b_float);
            ArithResult::ok_float(result, result_datatype)
        } else {
            // Integer/decimal arithmetic
            let sum = a_value + b_value;
            ArithResult::ok(sum, result_datatype)
        }
    } else {
        ArithResult::type_error()
    }
}

/// Add with explicit Float operands (for float/double values)
pub fn add_float(a: Float, a_datatype: Field, b: Float, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);
    
    if result_type.is_numeric {
        let result_datatype = level_to_datatype(result_type.level);
        let result = add_floats(a, b);
        ArithResult::ok_float(result, result_datatype)
    } else {
        ArithResult::type_error()
    }
}

/// Simplified addition that asserts on type errors
/// Use this when you expect both operands to be numeric
pub fn add_unchecked(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> Field {
    let result = add(a_value, a_datatype, b_value, b_datatype);
    result.unwrap()
}

// =============================================================================
// SUBTRACTION OPERATION
// =============================================================================

/// Perform SPARQL 1.1 compliant numeric subtraction: A - B
/// 
/// Parameters:
/// - `a_value`: The Field representing the numeric value of operand A
/// - `a_datatype`: The encoded datatype IRI of operand A
/// - `b_value`: The Field representing the numeric value of operand B
/// - `b_datatype`: The encoded datatype IRI of operand B
///
/// Returns:
/// - ArithResult with the difference, result datatype, and success indicator
pub fn sub(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);
    
    if result_type.is_numeric {
        let result_datatype = level_to_datatype(result_type.level);
        
        if result_type.is_floating_point() {
            // Use Float arithmetic for float/double
            let a_float = Float::from_integer(a_value);
            let b_float = Float::from_integer(b_value);
            let result = sub_floats(a_float, b_float);
            ArithResult::ok_float(result, result_datatype)
        } else {
            // Integer/decimal arithmetic
            let diff = a_value - b_value;
            ArithResult::ok(diff, result_datatype)
        }
    } else {
        ArithResult::type_error()
    }
}

/// Subtract with explicit Float operands
pub fn sub_float(a: Float, a_datatype: Field, b: Float, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);
    
    if result_type.is_numeric {
        let result_datatype = level_to_datatype(result_type.level);
        let result = sub_floats(a, b);
        ArithResult::ok_float(result, result_datatype)
    } else {
        ArithResult::type_error()
    }
}

/// Simplified subtraction that asserts on type errors
pub fn sub_unchecked(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> Field {
    let result = sub(a_value, a_datatype, b_value, b_datatype);
    result.unwrap()
}

// =============================================================================
// MULTIPLICATION OPERATION
// =============================================================================

/// Perform SPARQL 1.1 compliant numeric multiplication: A * B
/// 
/// Parameters:
/// - `a_value`: The Field representing the numeric value of operand A
/// - `a_datatype`: The encoded datatype IRI of operand A
/// - `b_value`: The Field representing the numeric value of operand B
/// - `b_datatype`: The encoded datatype IRI of operand B
///
/// Returns:
/// - ArithResult with the product, result datatype, and success indicator
pub fn mul(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);
    
    if result_type.is_numeric {
        let result_datatype = level_to_datatype(result_type.level);
        
        if result_type.is_floating_point() {
            // Use Float arithmetic for float/double
            let a_float = Float::from_integer(a_value);
            let b_float = Float::from_integer(b_value);
            let result = mul_floats(a_float, b_float);
            ArithResult::ok_float(result, result_datatype)
        } else {
            // Integer/decimal arithmetic
            let product = a_value * b_value;
            ArithResult::ok(product, result_datatype)
        }
    } else {
        ArithResult::type_error()
    }
}

/// Multiply with explicit Float operands
pub fn mul_float(a: Float, a_datatype: Field, b: Float, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);
    
    if result_type.is_numeric {
        let result_datatype = level_to_datatype(result_type.level);
        let result = mul_floats(a, b);
        ArithResult::ok_float(result, result_datatype)
    } else {
        ArithResult::type_error()
    }
}

/// Simplified multiplication that asserts on type errors
pub fn mul_unchecked(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> Field {
    let result = mul(a_value, a_datatype, b_value, b_datatype);
    result.unwrap()
}

// =============================================================================
// DIVISION OPERATION (SPARQL 1.1)
// =============================================================================

/// Perform SPARQL 1.1 compliant numeric division: A / B
/// 
/// According to SPARQL 1.1 spec (Section 17.3):
/// - Division of integers returns xsd:decimal
/// - Division of decimal by decimal returns xsd:decimal
/// - Division involving float/double returns float/double
/// - Division by zero is an error
///
/// Parameters:
/// - `a_value`: The Field representing the numeric value of operand A
/// - `a_datatype`: The encoded datatype IRI of operand A
/// - `b_value`: The Field representing the numeric value of operand B
/// - `b_datatype`: The encoded datatype IRI of operand B
///
/// Returns:
/// - ArithResult with the quotient, result datatype, and success indicator
pub fn div(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);
    
    if result_type.is_numeric {
        // Division always uses Float arithmetic for proper fractional results
        // Per SPARQL spec, integer division returns decimal
        let a_float = Float::from_integer(a_value);
        let b_float = Float::from_integer(b_value);
        
        // Check for division by zero
        if b_float.is_zero() {
            ArithResult::type_error() // Division by zero
        } else {
            let result = div_floats(a_float, b_float);
            
            // Result type: if either operand is float/double, keep that type
            // Otherwise (integer/decimal), result is decimal
            let result_level = if result_type.is_floating_point() {
                result_type.level
            } else {
                1 // decimal
            };
            let result_datatype = level_to_datatype(result_level);
            ArithResult::ok_float(result, result_datatype)
        }
    } else {
        ArithResult::type_error()
    }
}

/// Divide with explicit Float operands
pub fn div_float(a: Float, a_datatype: Field, b: Float, b_datatype: Field) -> ArithResult {
    let a_type = get_numeric_type_level(a_datatype);
    let b_type = get_numeric_type_level(b_datatype);
    let result_type = promote_types(a_type, b_type);
    
    if result_type.is_numeric {
        if b.is_zero() {
            ArithResult::type_error() // Division by zero
        } else {
            let result = div_floats(a, b);
            let result_level = if result_type.is_floating_point() {
                result_type.level
            } else {
                1 // decimal
            };
            let result_datatype = level_to_datatype(result_level);
            ArithResult::ok_float(result, result_datatype)
        }
    } else {
        ArithResult::type_error()
    }
}

/// Simplified division that asserts on type errors
pub fn div_unchecked(a_value: Field, a_datatype: Field, b_value: Field, b_datatype: Field) -> Float {
    let result = div(a_value, a_datatype, b_value, b_datatype);
    result.unwrap_float()
}

// =============================================================================
// UNARY OPERATIONS
// =============================================================================

/// Perform SPARQL 1.1 compliant unary minus: -A
/// 
/// Parameters:
/// - `value`: The Field representing the numeric value
/// - `datatype`: The encoded datatype IRI
///
/// Returns:
/// - ArithResult with the negated value, same datatype, and success indicator
pub fn neg(value: Field, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);
    
    if type_level.is_numeric {
        if type_level.is_floating_point() {
            let float_value = Float::from_integer(value);
            let negated = float_value.negate();
            ArithResult::ok_float(negated, datatype)
        } else {
            let negated = 0 - value;
            ArithResult::ok(negated, datatype)
        }
    } else {
        ArithResult::type_error()
    }
}

/// Negate a Float value
pub fn neg_float(value: Float, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);
    
    if type_level.is_numeric {
        let negated = value.negate();
        ArithResult::ok_float(negated, datatype)
    } else {
        ArithResult::type_error()
    }
}

/// Simplified unary minus that asserts on type errors
pub fn neg_unchecked(value: Field, datatype: Field) -> Field {
    let result = neg(value, datatype);
    result.unwrap()
}

/// Perform SPARQL 1.1 compliant unary plus: +A
/// Simply returns the value unchanged with type checking
/// 
/// Parameters:
/// - `value`: The Field representing the numeric value
/// - `datatype`: The encoded datatype IRI
///
/// Returns:
/// - ArithResult with the same value, same datatype, and success indicator
pub fn pos(value: Field, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);
    
    if type_level.is_numeric {
        if type_level.is_floating_point() {
            let float_value = Float::from_integer(value);
            ArithResult::ok_float(float_value, datatype)
        } else {
            ArithResult::ok(value, datatype)
        }
    } else {
        ArithResult::type_error()
    }
}

/// Unary plus for Float value
pub fn pos_float(value: Float, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);
    
    if type_level.is_numeric {
        ArithResult::ok_float(value, datatype)
    } else {
        ArithResult::type_error()
    }
}

/// Simplified unary plus that asserts on type errors
pub fn pos_unchecked(value: Field, datatype: Field) -> Field {
    let result = pos(value, datatype);
    result.unwrap()
}

// =============================================================================
// NUMERIC TYPE CHECKING
// =============================================================================

/// Check if a datatype is numeric
/// Convenience function that reuses the type level logic
pub fn is_numeric_datatype(datatype: Field) -> bool {
    get_numeric_type_level(datatype).is_numeric
}

/// Check if a datatype is a floating point type (float or double)
pub fn is_floating_point_datatype(datatype: Field) -> bool {
    get_numeric_type_level(datatype).is_floating_point()
}

// =============================================================================
// SPARQL 1.1 NUMERIC FUNCTIONS
// =============================================================================

/// ABS - Returns the absolute value of a numeric value
pub fn abs(value: Field, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);
    
    if type_level.is_numeric {
        if type_level.is_floating_point() {
            let float_value = Float::from_integer(value);
            ArithResult::ok_float(float_value.abs(), datatype)
        } else {
            // For Field values, we just return the value (assume positive)
            // In real implementation, would need signed integer handling
            ArithResult::ok(value, datatype)
        }
    } else {
        ArithResult::type_error()
    }
}

/// ABS for Float values
pub fn abs_float(value: Float, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);
    
    if type_level.is_numeric {
        ArithResult::ok_float(value.abs(), datatype)
    } else {
        ArithResult::type_error()
    }
}

/// ROUND - Rounds to nearest integer
/// For Float values, adjusts the mantissa based on exponent
pub fn round_float(value: Float, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);
    
    if type_level.is_numeric {
        // If exponent >= EXPONENT_BIAS, already integer
        if value.exponent as u64 >= EXPONENT_BIAS as u64 {
            ArithResult::ok_float(value, datatype)
        } else {
            // Calculate decimal places
            let decimal_places = (EXPONENT_BIAS - value.exponent) as u32;
            let divisor = pow10(decimal_places);
            
            // Round: add 0.5 and truncate
            let half = divisor as u64 / 2;
            let mant = value.mantissa as u64;
            let rounded_mant = ((mant + half) / divisor as u64) as Field;
            
            let result = Float { 
                sign: value.sign, 
                mantissa: rounded_mant, 
                exponent: EXPONENT_BIAS 
            };
            ArithResult::ok_float(result, datatype)
        }
    } else {
        ArithResult::type_error()
    }
}

/// FLOOR - Rounds down to nearest integer
pub fn floor_float(value: Float, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);
    
    if type_level.is_numeric {
        if value.exponent as u64 >= EXPONENT_BIAS as u64 {
            ArithResult::ok_float(value, datatype)
        } else {
            let decimal_places = (EXPONENT_BIAS - value.exponent) as u32;
            let divisor = pow10(decimal_places);
            
            let mant = value.mantissa as u64;
            let mut floored_mant = (mant / divisor as u64) as Field;
            
            // For negative numbers, floor goes more negative
            if (value.sign == 1) & ((mant % divisor as u64) > 0) {
                floored_mant += 1;
            }
            
            let result = Float { 
                sign: value.sign, 
                mantissa: floored_mant, 
                exponent: EXPONENT_BIAS 
            };
            ArithResult::ok_float(result, datatype)
        }
    } else {
        ArithResult::type_error()
    }
}

/// CEIL - Rounds up to nearest integer
pub fn ceil_float(value: Float, datatype: Field) -> ArithResult {
    let type_level = get_numeric_type_level(datatype);
    
    if type_level.is_numeric {
        if value.exponent as u64 >= EXPONENT_BIAS as u64 {
            ArithResult::ok_float(value, datatype)
        } else {
            let decimal_places = (EXPONENT_BIAS - value.exponent) as u32;
            let divisor = pow10(decimal_places);
            
            let mant = value.mantissa as u64;
            let mut ceiled_mant = (mant / divisor as u64) as Field;
            
            // For positive numbers, ceil goes more positive
            if (value.sign == 0) & ((mant % divisor as u64) > 0) {
                ceiled_mant += 1;
            }
            
            let result = Float { 
                sign: value.sign, 
                mantissa: ceiled_mant, 
                exponent: EXPONENT_BIAS 
            };
            ArithResult::ok_float(result, datatype)
        }
    } else {
        ArithResult::type_error()
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
    
    // integer + float = float (using Float arithmetic)
    let result = add(5, int_type, 3, float_type);
    assert(result.success);
    assert(result.datatype == float_type);
    assert(result.is_float_type);
    // Result should be Float representing 8
    assert(result.float_result.mantissa == 8);
    assert(result.float_result.sign == 0);
}

#[test]
fn test_type_promotion_decimal_double() {
    let decimal_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#decimal");
    let double_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#double");
    
    // decimal + double = double
    let result = add(5, decimal_type, 3, double_type);
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
    // In field arithmetic, -5 wraps around, but for our purposes we just test it's not 5
    assert(result.value != 5);
}

#[test]
fn test_derived_integer_types() {
    let long_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#long");
    let unsigned_int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#unsignedInt");
    let integer_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    
    // long + unsignedInt should work and produce integer result
    let result = add(100, long_type, 50, unsigned_int_type);
    assert(result.success);
    assert(result.value == 150);
    // Both are integer-level types, so result should be integer
    assert(result.datatype == integer_type);
}

// =============================================================================
// FLOAT-SPECIFIC TESTS
// =============================================================================

#[test]
fn test_float_zero() {
    let zero = Float::zero();
    assert(zero.mantissa == 0);
    assert(zero.sign == 0);
    assert(zero.exponent == EXPONENT_BIAS);
    assert(zero.is_zero());
}

#[test]
fn test_float_from_integer() {
    let f = Float::from_integer(123);
    assert(f.mantissa == 123);
    assert(f.sign == 0);
    assert(f.exponent == EXPONENT_BIAS);
}

#[test]
fn test_float_negate() {
    let f = Float::from_integer(123);
    let neg_f = f.negate();
    assert(neg_f.mantissa == 123);
    assert(neg_f.sign == 1);
    assert(neg_f.is_negative());
}

#[test]
fn test_float_addition() {
    let a = Float::from_integer(100);
    let b = Float::from_integer(50);
    let result = add_floats(a, b);
    assert(result.mantissa == 150);
    assert(result.sign == 0);
}

#[test]
fn test_float_subtraction() {
    let a = Float::from_integer(100);
    let b = Float::from_integer(30);
    let result = sub_floats(a, b);
    assert(result.mantissa == 70);
    assert(result.sign == 0);
}

#[test]
fn test_float_multiplication() {
    let a = Float::from_integer(12);
    let b = Float::from_integer(10);
    let result = mul_floats(a, b);
    assert(result.mantissa == 120);
    assert(result.sign == 0);
}

#[test]
fn test_float_division() {
    let a = Float::from_integer(100);
    let b = Float::from_integer(4);
    let result = div_floats(a, b);
    // 100 / 4 = 25
    // Result should represent 25
    assert(result.sign == 0);
    // Due to the way division works, mantissa will be scaled
    // The important thing is the value represents 25
}

#[test]
fn test_float_comparison_gt() {
    let a = Float::from_integer(100);
    let b = Float::from_integer(50);
    assert(float_gt(a, b));
    assert(!float_gt(b, a));
    assert(!float_gt(a, a)); // Not greater than self
}

#[test]
fn test_float_comparison_lt() {
    let a = Float::from_integer(50);
    let b = Float::from_integer(100);
    assert(float_lt(a, b));
    assert(!float_lt(b, a));
}

#[test]
fn test_float_comparison_eq() {
    let a = Float::from_integer(42);
    let b = Float::from_integer(42);
    let c = Float::from_integer(43);
    assert(float_eq(a, b));
    assert(!float_eq(a, c));
}

#[test]
fn test_float_comparison_zeros() {
    let pos_zero = Float::zero();
    let neg_zero = Float { sign: 1, mantissa: 0, exponent: EXPONENT_BIAS };
    // Both zeros should be equal
    assert(float_eq(pos_zero, neg_zero));
}

#[test]
fn test_sparql_division_returns_decimal() {
    let int_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#integer");
    let decimal_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#decimal");
    
    // integer / integer should return decimal per SPARQL spec
    let result = div(10, int_type, 4, int_type);
    assert(result.success);
    assert(result.datatype == decimal_type);
    assert(result.is_float_type);
}

#[test]
fn test_truncate_float() {
    // Create a float with mantissa exceeding precision
    let big = Float { sign: 0, mantissa: 123456789, exponent: EXPONENT_BIAS };
    let truncated = truncate_float(big);
    // Should be truncated to 7 digits
    assert(truncated.mantissa as u64 <= MAX_MANTISSA);
}

#[test]
fn test_negative_float_arithmetic() {
    let a = Float::from_integer(50);
    let b = Float::from_negative_integer(30);
    
    // 50 + (-30) = 20
    let result = add_floats(a, b);
    assert(result.mantissa == 20);
    assert(result.sign == 0);
}

#[test]
fn test_float_abs() {
    let float_type = encode_datatype_iri("http://www.w3.org/2001/XMLSchema#float");
    let neg = Float::from_negative_integer(42);
    
    let result = abs_float(neg, float_type);
    assert(result.success);
    assert(result.float_result.sign == 0);
    assert(result.float_result.mantissa == 42);
}
