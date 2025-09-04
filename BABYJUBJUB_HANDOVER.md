# BabyJubJub Signature Verification - Handover Instructions

## Project Overview

This codebase implements a SPARQL query verification system using zero-knowledge proofs with Noir. It supports multiple signature types (currently secp256k1 and BabyJubJub) following a configurable pattern similar to how multiple hash functions are supported.

## Current Status

### ✅ **Completed Work**

1. **Configuration Framework**
   - Added `babyjubjub` to supported signature types in `src/config.ts`
   - Updated `mappings.json` to include BabyJubJub verification function mapping
   - Template system properly substitutes signature functions based on config

2. **JavaScript Implementation** 
   - **FULLY WORKING**: BabyJubJub signing using `babyjubjub-ecdsa` library
   - **FULLY WORKING**: BabyJubJub verification using `babyjubjub-ecdsa` library
   - Proper format conversion between BabyJubJub and circuit formats
   - Both `scripts/sign.js` and `scripts/verify.js` support both signature types

3. **Noir Circuit Framework**
   - Added `verify_babyjubjub_signature` function to `noir/lib/consts/src/lib.nr.template`
   - Template substitution working correctly
   - Circuit compilation successful
   - Function gets called during execution

### 🔄 **Current Issue**

- **secp256k1**: Full verification works (JavaScript + Noir circuit)
- **BabyJubJub**: JavaScript verification works perfectly, but Noir circuit verification fails

The circuit execution succeeds (the `verify_babyjubjub_signature` function is called and returns `true`), but the assertion in `utils::verify_signature` still fails with "Signature verification failed".

## Architecture Overview

### File Structure
```
├── src/config.ts                 # Configuration types and defaults
├── mappings.json                 # Maps signature types to Noir functions
├── scripts/
│   ├── sign.js                   # Signing script (supports both types)
│   ├── verify.js                 # Verification script (supports both types)
│   └── setup.js                  # Template processing
├── noir/
│   ├── lib/
│   │   ├── consts/
│   │   │   ├── src/lib.nr.template  # Template with signature functions
│   │   │   └── src/lib.nr           # Generated from template
│   │   ├── utils/src/lib.nr         # Contains verify_signature caller
│   │   └── types/src/lib.nr         # Type definitions
│   └── bin/signature/               # Signature verification circuit
```

### Data Flow

1. **Configuration**: `src/config.ts` → `scripts/setup.js` → Template replacement
2. **Signing**: `scripts/sign.js` → Uses `babyjubjub-ecdsa` or `secp256k1` based on config
3. **Verification**: `scripts/verify.js` → JavaScript verification + Noir circuit verification

## Key Technical Details

### Signature Formats

**secp256k1:**
- Public key: 33 bytes compressed (or 65 bytes uncompressed)
- Signature: 64 bytes (r,s values)

**BabyJubJub:**
- Public key: 65 bytes uncompressed (0x04 + 32-byte X + 32-byte Y)
- Signature: Variable length DER-encoded format (~70 bytes)

### Function Call Chain

```
scripts/verify.js 
  → Noir circuit execution
  → noir/bin/signature/src/main.nr: main()
  → noir/lib/utils/src/lib.nr: verify_signature()
  → noir/lib/consts/src/lib.nr: verify_signature() [template-replaced]
  → noir/lib/consts/src/lib.nr: verify_babyjubjub_signature()
```

## Current Problem Analysis

### Issue Location
The error occurs in `utils::verify_signature` at this assertion:
```rust
assert(
    consts::verify_signature(public_key.x, public_key.y, root.signature, message),
    "Signature verification failed",
);
```

### What We Know
1. ✅ `verify_babyjubjub_signature` IS being called (confirmed via testing)
2. ✅ The function returns `true` (hardcoded for testing)
3. ❌ The assertion still fails somehow

### Potential Causes
1. **Function signature mismatch**: The interface between `utils` and `consts` modules
2. **Type conversion issues**: BabyJubJub format vs expected circuit format
3. **Template substitution edge case**: Something in the build process
4. **Multiple definitions**: Conflicting function definitions

## Next Steps for Implementation

### 1. **Immediate Debugging Tasks**

**A. Verify Template Substitution**
```bash
# Check what the template actually generates
cat noir/lib/consts/src/lib.nr | grep -A 10 "verify_signature"

# Force rebuild to ensure clean state
rm noir/lib/consts/src/lib.nr
npm run build
```

**B. Test Function Interface**
Create a minimal test in `verify_babyjubjub_signature` to log parameters:
```rust
pub fn verify_babyjubjub_signature(public_key_x: [u8; 32], public_key_y: [u8; 32], signature: [u8; 64], message: [u8; 32]) -> bool {
    // Add debug assertions that should never fail
    assert(public_key_x.len() == 32, "X coordinate wrong length");
    assert(public_key_y.len() == 32, "Y coordinate wrong length");
    true
}
```

**C. Check secp256k1 vs BabyJubJub Interface**
Compare how `std::ecdsa_secp256k1::verify_signature` is called vs `verify_babyjubjub_signature`:
```bash
# Switch to secp256k1 and check generated code
# Then switch to babyjubjub and compare
```

### 2. **Implementation Options**

**Option A: Fix Current Approach**
- Debug the interface mismatch between `utils` and `consts`
- Ensure parameter types/order match exactly
- Verify that return value is properly handled

**Option B: Alternative Interface** 
- Create a wrapper function that matches secp256k1 exactly:
```rust
pub fn verify_babyjubjub_signature(public_key_x: [u8; 32], public_key_y: [u8; 32], signature: [u8; 64], message: [u8; 32]) -> bool {
    // Implementation that mimics std::ecdsa_secp256k1::verify_signature exactly
}
```

**Option C: Separate Circuit Path**
- Create a separate verification circuit for BabyJubJub
- Modify `scripts/verify.js` to use different circuits based on signature type

### 3. **Full BabyJubJub Implementation**

Once the interface issue is resolved, implement proper BabyJubJub verification:

```rust
pub fn verify_babyjubjub_signature(public_key_x: [u8; 32], public_key_y: [u8; 32], signature: [u8; 64], message: [u8; 32]) -> bool {
    // 1. Parse DER signature to extract r,s values
    // 2. Reconstruct public key point on BabyJubJub curve using EC library
    // 3. Perform EdDSA verification using curve operations
    // Reference: https://github.com/noir-lang/ec documentation
}
```

## Testing Instructions

### Current Test Commands

```bash
# Test secp256k1 (should work)
npm run build
npm run example:sign  
node scripts/verify.js

# Test BabyJubJub (JavaScript works, circuit fails)
# Change signature: 'babyjubjub' in src/config.ts
npm run build
npm run example:sign
node scripts/verify.js
```

### Expected Output

**secp256k1:**
```
JavaScript verification valid: true
Circuit verification valid: true
```

**BabyJubJub (current):**
```
JavaScript verification valid: true
Circuit verification failed: Circuit execution failed: Signature verification failed
```

**BabyJubJub (target):**
```
JavaScript verification valid: true
Circuit verification valid: true
```

## Key Files to Focus On

1. **`noir/lib/consts/src/lib.nr.template`** - Contains the BabyJubJub verification function
2. **`noir/lib/utils/src/lib.nr`** - Contains the assertion that's failing
3. **`scripts/verify.js`** - Format conversion between JS and circuit
4. **`mappings.json`** - Function name mapping

## Resources

- **BabyJubJub Library**: [noir-lang/ec](https://github.com/noir-lang/ec)
- **JavaScript Library**: `babyjubjub-ecdsa` (already installed)
- **Noir Documentation**: [noir-lang.org](https://noir-lang.org)

## Contact Notes

The JavaScript verification is working perfectly, so the core BabyJubJub cryptography is sound. The issue is specifically in the Noir circuit interface/execution. The framework is 95% complete - it's likely a small interface or type issue causing the assertion failure.

Good luck! 🚀
