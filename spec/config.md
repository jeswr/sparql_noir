# Configuration Specification

This document specifies all configurable parameters for the ZK-SPARQL proof system.

## 1. Overview

The proof system is highly configurable to accommodate different:
- Security requirements
- Performance characteristics  
- Compatibility needs
- Privacy preferences

All configuration affects both proof generation and verification.

---

## 2. Configuration Structure

### 2.1 Top-Level Configuration

```rust
pub struct Config {
    /// Encoding configuration
    pub encoding: EncodingConfig,
    
    /// Signature configuration
    pub signature: SignatureConfig,
    
    /// Circuit architecture configuration
    pub architecture: ArchitectureConfig,
    
    /// Disclosure configuration
    pub disclosure: DisclosureConfig,
}
```

### 2.2 Default Configuration

```rust
impl Default for Config {
    fn default() -> Self {
        Self {
            encoding: EncodingConfig::default(),
            signature: SignatureConfig::default(),
            architecture: ArchitectureConfig::default(),
            disclosure: DisclosureConfig::default(),
        }
    }
}
```

---

## 3. Encoding Configuration

### 3.1 Hash Function Selection

```rust
pub struct EncodingConfig {
    /// Hash function for 2-input hashing (term encoding)
    pub hash2: Hash2Type,
    
    /// Hash function for 4-input hashing (literal/triple encoding)
    pub hash4: Hash4Type,
    
    /// Hash function for string-to-field conversion
    pub string_hash: StringHashType,
}
```

### 3.2 Hash2 / Hash4 Options

| Type | Noir Implementation | Security | Performance |
|------|---------------------|----------|-------------|
| `Pedersen` | `std::hash::pedersen_hash` | 128-bit | Fast |
| `Poseidon2` | `poseidon2::bn254::hash_{2,4}` | 128-bit | Very Fast |
| `Blake2s` | Custom wrapper | 128-bit | Slower |

```rust
pub enum Hash2Type {
    Pedersen,   // Default
    Poseidon2,
    Blake2s,
}

pub enum Hash4Type {
    Pedersen,   // Default
    Poseidon2,
    Blake2s,
}
```

### 3.3 String Hash Options

| Type | Noir Implementation | Output | Use Case |
|------|---------------------|--------|----------|
| `Blake3` | `std::hash::blake3` | 32 bytes | Default, fast |
| `Blake2s` | `std::hash::blake2s` | 32 bytes | Wide support |
| `Sha256` | `sha256::digest` | 32 bytes | Compatibility |
| `Keccak256` | `keccak256::keccak256` | 32 bytes | Ethereum |

```rust
pub enum StringHashType {
    Blake3,     // Default
    Blake2s,
    Sha256,
    Keccak256,
}
```

### 3.4 Default Encoding Configuration

```rust
impl Default for EncodingConfig {
    fn default() -> Self {
        Self {
            hash2: Hash2Type::Pedersen,
            hash4: Hash4Type::Pedersen,
            string_hash: StringHashType::Blake3,
        }
    }
}
```

### 3.5 Noir Code Generation

Based on configuration, the appropriate Noir functions are used:

```rust
fn hash2_name(config: &EncodingConfig) -> &'static str {
    match config.hash2 {
        Hash2Type::Pedersen => "std::hash::pedersen_hash",
        Hash2Type::Poseidon2 => "dep::poseidon2::bn254::hash_2",
        Hash2Type::Blake2s => "hash::hash2",
    }
}

fn hash4_name(config: &EncodingConfig) -> &'static str {
    match config.hash4 {
        Hash4Type::Pedersen => "std::hash::pedersen_hash",
        Hash4Type::Poseidon2 => "dep::poseidon2::bn254::hash_4",
        Hash4Type::Blake2s => "hash::hash4",
    }
}

fn string_hash_name(config: &EncodingConfig) -> &'static str {
    match config.string_hash {
        StringHashType::Blake3 => "std::hash::blake3",
        StringHashType::Blake2s => "std::hash::blake2s",
        StringHashType::Sha256 => "dep::sha256::digest",
        StringHashType::Keccak256 => "dep::keccak256::keccak256",
    }
}
```

---

## 4. Signature Configuration

### 4.1 Signature Scheme Selection

```rust
pub struct SignatureConfig {
    /// Signature scheme
    pub scheme: SignatureScheme,
}

pub enum SignatureScheme {
    /// Schnorr signatures over Grumpkin curve (Noir native)
    Schnorr,
    
    /// ECDSA over secp256k1 (Bitcoin/Ethereum)
    EcdsaSecp256k1,
    
    /// ECDSA over secp256r1 (WebAuthn/NIST P-256)
    EcdsaSecp256r1,
    
    /// BabyJubJub signatures
    BabyJubJub,
    
    /// Optimized BabyJubJub
    BabyJubJubOpt,
    
    /// BLS signatures (aggregatable)
    Bls,
}
```

### 4.2 Signature Scheme Properties

| Scheme | Curve | PK Size | Sig Size | In-Circuit Cost | Use Case |
|--------|-------|---------|----------|-----------------|----------|
| `Schnorr` | Grumpkin | 64B | 64B | Low | Default, Noir native |
| `EcdsaSecp256k1` | secp256k1 | 64B | 64B | High | Bitcoin/Ethereum compat |
| `EcdsaSecp256r1` | P-256 | 64B | 64B | High | WebAuthn, TLS |
| `BabyJubJub` | BabyJubJub | 32B | 64B | Medium | EdDSA-like |
| `BabyJubJubOpt` | BabyJubJub | 32B | 64B | Low | Optimized EdDSA |
| `Bls` | BLS12-381 | 48B | 96B | Very High | Aggregation |

### 4.3 Default Signature Configuration

```rust
impl Default for SignatureConfig {
    fn default() -> Self {
        Self {
            scheme: SignatureScheme::Schnorr,
        }
    }
}
```

### 4.4 Noir Library Mapping

| Scheme | Noir Library Path |
|--------|-------------------|
| `Schnorr` | `noir/lib/signatures/schnorr` |
| `EcdsaSecp256k1` | `noir/lib/signatures/secp256k1` |
| `EcdsaSecp256r1` | `noir/lib/signatures/secp256r1` |
| `BabyJubJub` | `noir/lib/signatures/babyjubjub` |
| `BabyJubJubOpt` | `noir/lib/signatures/babyjubjubOpt` |
| `Bls` | `noir/lib/signatures/bls` |

---

## 5. Architecture Configuration

### 5.1 Structure

```rust
pub struct ArchitectureConfig {
    /// Merkle tree depth (determines max triples per dataset)
    pub merkle_depth: u32,
    
    /// Maximum property path segment length
    pub path_segment_max: u32,
    
    /// Maximum number of BGP patterns
    pub max_bgp_patterns: Option<u32>,
    
    /// Maximum number of union branches
    pub max_union_branches: Option<u32>,
}
```

### 5.2 Merkle Depth

**Parameter:** `merkle_depth`

**Range:** 1 - 32 (practical: 8 - 16)

**Trade-offs:**

| Depth | Max Triples | Proof Size Impact | Use Case |
|-------|-------------|-------------------|----------|
| 8 | 256 | Minimal | Small datasets |
| 10 | 1,024 | Low | Typical VCs |
| 11 | 2,048 | Low | Default |
| 14 | 16,384 | Medium | Large datasets |
| 16 | 65,536 | Higher | Very large datasets |

**Default:** 11

### 5.3 Path Segment Maximum

**Parameter:** `path_segment_max`

**Range:** 1 - 32 (practical: 4 - 12)

**Trade-offs:**

| Max | Circuit Size | Use Case |
|-----|--------------|----------|
| 4 | Small | Simple hierarchies |
| 8 | Medium | Default, most use cases |
| 12 | Large | Deep graphs |
| 16 | Very Large | Unusual requirements |

**Default:** 8

**Note:** Actual path length is disclosed, so larger max values don't inherently leak more information unless paths actually use them.

### 5.4 Default Architecture Configuration

```rust
impl Default for ArchitectureConfig {
    fn default() -> Self {
        Self {
            merkle_depth: 11,
            path_segment_max: 8,
            max_bgp_patterns: None,     // Unlimited
            max_union_branches: None,   // Unlimited
        }
    }
}
```

---

## 6. Disclosure Configuration

### 6.1 Structure

```rust
pub struct DisclosureConfig {
    /// Variables to explicitly disclose (None = all projected)
    pub disclose_variables: Option<Vec<String>>,
    
    /// Variables to explicitly hide (takes precedence)
    pub hide_variables: Option<Vec<String>>,
    
    /// Whether to disclose numeric filter bounds
    pub disclose_bounds: bool,
    
    /// Disclosure mode for disclosed variables
    pub disclosure_mode: DisclosureMode,
}

pub enum DisclosureMode {
    /// Disclose decoded term value
    Value,
    /// Disclose field encoding only  
    Encoding,
    /// Disclose hash of binding
    Hash,
}
```

### 6.2 Default Disclosure Configuration

```rust
impl Default for DisclosureConfig {
    fn default() -> Self {
        Self {
            disclose_variables: None,  // All projected
            hide_variables: None,
            disclose_bounds: true,
            disclosure_mode: DisclosureMode::Value,
        }
    }
}
```

---

## 7. Configuration Presets

### 7.1 Default (Balanced)

```rust
pub fn default_config() -> Config {
    Config::default()
}
```

### 7.2 High Performance

```rust
pub fn high_performance_config() -> Config {
    Config {
        encoding: EncodingConfig {
            hash2: Hash2Type::Poseidon2,
            hash4: Hash4Type::Poseidon2,
            string_hash: StringHashType::Blake3,
        },
        signature: SignatureConfig {
            scheme: SignatureScheme::BabyJubJubOpt,
        },
        architecture: ArchitectureConfig {
            merkle_depth: 10,
            path_segment_max: 6,
            ..Default::default()
        },
        disclosure: DisclosureConfig::default(),
    }
}
```

### 7.3 Maximum Compatibility

```rust
pub fn compatibility_config() -> Config {
    Config {
        encoding: EncodingConfig {
            hash2: Hash2Type::Pedersen,
            hash4: Hash4Type::Pedersen,
            string_hash: StringHashType::Sha256,
        },
        signature: SignatureConfig {
            scheme: SignatureScheme::EcdsaSecp256k1,
        },
        architecture: ArchitectureConfig::default(),
        disclosure: DisclosureConfig::default(),
    }
}
```

### 7.4 Maximum Privacy

```rust
pub fn privacy_config() -> Config {
    Config {
        encoding: EncodingConfig::default(),
        signature: SignatureConfig::default(),
        architecture: ArchitectureConfig::default(),
        disclosure: DisclosureConfig {
            disclose_variables: Some(vec![]),  // Hide all
            hide_variables: None,
            disclose_bounds: false,
            disclosure_mode: DisclosureMode::Hash,
        },
    }
}
```

### 7.5 Ethereum Compatible

```rust
pub fn ethereum_config() -> Config {
    Config {
        encoding: EncodingConfig {
            hash2: Hash2Type::Pedersen,
            hash4: Hash4Type::Pedersen,
            string_hash: StringHashType::Keccak256,
        },
        signature: SignatureConfig {
            scheme: SignatureScheme::EcdsaSecp256k1,
        },
        architecture: ArchitectureConfig::default(),
        disclosure: DisclosureConfig::default(),
    }
}
```

---

## 8. Configuration Serialization

### 8.1 JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "encoding": {
      "type": "object",
      "properties": {
        "hash2": { "enum": ["pedersen", "poseidon2", "blake2s"] },
        "hash4": { "enum": ["pedersen", "poseidon2", "blake2s"] },
        "stringHash": { "enum": ["blake3", "blake2s", "sha256", "keccak256"] }
      }
    },
    "signature": {
      "type": "object",
      "properties": {
        "scheme": { 
          "enum": ["schnorr", "ecdsa-secp256k1", "ecdsa-secp256r1", 
                   "babyjubjub", "babyjubjub-opt", "bls"] 
        }
      }
    },
    "architecture": {
      "type": "object",
      "properties": {
        "merkleDepth": { "type": "integer", "minimum": 1, "maximum": 32 },
        "pathSegmentMax": { "type": "integer", "minimum": 1, "maximum": 32 }
      }
    },
    "disclosure": {
      "type": "object",
      "properties": {
        "discloseVariables": { "type": "array", "items": { "type": "string" } },
        "hideVariables": { "type": "array", "items": { "type": "string" } },
        "discloseBounds": { "type": "boolean" },
        "disclosureMode": { "enum": ["value", "encoding", "hash"] }
      }
    }
  }
}
```

### 8.2 Example Configuration File

```json
{
  "encoding": {
    "hash2": "pedersen",
    "hash4": "pedersen",
    "stringHash": "blake3"
  },
  "signature": {
    "scheme": "schnorr"
  },
  "architecture": {
    "merkleDepth": 11,
    "pathSegmentMax": 8
  },
  "disclosure": {
    "discloseVariables": ["?name", "?email"],
    "hideVariables": ["?ssn", "?income"],
    "discloseBounds": true,
    "disclosureMode": "value"
  }
}
```

---

## 9. CLI Configuration

### 9.1 Sign Command

```bash
sparql-zk sign \
  --input dataset.ttl \
  --keypair keypair.json \
  --signature-scheme schnorr \
  --merkle-depth 11 \
  --string-hash blake3 \
  --output signed.json
```

### 9.2 Prove Command

```bash
sparql-zk prove \
  --query query.rq \
  --datasets signed1.json,signed2.json \
  --config config.json \
  --disclose "?name,?date" \
  --hide "?ssn" \
  --output proof.json
```

### 9.3 Verify Command

```bash
sparql-zk verify \
  --proof proof.json
```

### 9.4 Info Command

```bash
sparql-zk info \
  --query query.rq \
  --config config.json
```

---

## 10. Configuration Validation

### 10.1 Validation Rules

```rust
impl Config {
    pub fn validate(&self) -> Result<(), ConfigError> {
        // Merkle depth bounds
        if self.architecture.merkle_depth < 1 || self.architecture.merkle_depth > 32 {
            return Err(ConfigError::InvalidMerkleDepth);
        }
        
        // Path segment max bounds
        if self.architecture.path_segment_max < 1 || self.architecture.path_segment_max > 32 {
            return Err(ConfigError::InvalidPathSegmentMax);
        }
        
        // Hash function compatibility
        if self.encoding.hash2 == Hash2Type::Blake2s 
           && self.encoding.string_hash != StringHashType::Blake2s {
            // Warning: mixing hash families may have security implications
        }
        
        Ok(())
    }
}
```

### 10.2 Compatibility Checks

```rust
impl Config {
    pub fn is_compatible_with(&self, other: &Config) -> bool {
        // For verification, configs must match
        self.encoding == other.encoding
            && self.signature == other.signature
            && self.architecture == other.architecture
    }
}
```

---

## 11. Configuration in Proof Metadata

Proofs embed their configuration for verification:

```rust
pub struct ProofMetadata {
    pub query: String,
    pub config: Config,  // Full configuration used
    pub created_at: u64,
    pub circuit_id: String,
}
```

This ensures verifiers use the correct parameters without external coordination.

---

## References

1. Pedersen Commitments and Hash Functions
2. Poseidon: A New Hash Function for Zero-Knowledge Proof Systems
3. BLAKE3 Specification
4. Schnorr Signatures for secp256k1
5. BLS Signatures
