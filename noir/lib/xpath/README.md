# XPath Functions Wrapper for SPARQL

This library wraps the [noir_XPath](https://github.com/jeswr/noir_XPath) library for use in SPARQL query circuits.

## ⚠️ CRITICAL LIMITATIONS

### Numeric Functions - Integer-Only
The following functions **ONLY work with xsd:integer** types:
- `abs_int()`, `round_int()`, `ceil_int()`, `floor_int()`

**Limitations:**
- ❌ NO support for xsd:float or xsd:double
- ❌ NO type casting between numeric types
- ❌ NO automatic type promotion (violates SPARQL 1.1 spec)
- ❌ Using with non-integer types causes circuit verification failure

### String Functions - Not Implemented
The following string helper functions are declared but **DO NOT WORK**:
- `is_string_type()` - Type checking helper only

**Actual string operations from noir_XPath:**
- `string_length()`, `starts_with()`, `ends_with()`, `contains()`
- These require proper string values (not hashes) to work correctly
- Currently not properly integrated in transform code generation

## Usage

Import in generated circuits:
```noir
use dep::xpath;

// Numeric functions (integer-only!)
let result = xpath::abs_int(value as i64);

// Type checking
if xpath::is_numeric_type(datatype) {
    // ...
}
```

## Dependencies

- `noir_xpath` - XPath 2.0 functions implementation
- `consts` - Encoding and hashing utilities

## See Also

- [XPATH_INTEGRATION_SUMMARY.md](../../../XPATH_INTEGRATION_SUMMARY.md) - Complete integration details and limitations
- [noir_XPath Repository](https://github.com/jeswr/noir_XPath) - Upstream library
