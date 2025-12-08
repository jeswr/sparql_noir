# Proof API Specification

This document specifies the public API for signing datasets, generating proofs, and verifying proofs.

## 1. Overview

The API consists of four operations:

| Operation | Purpose |
|-----------|---------|
| `sign` | Sign an RDF dataset |
| `prove` | Generate a ZK proof for a query |
| `verify` | Verify a proof |
| `info` | Get disclosure information for a configuration |

---

## 2. Sign

Signs an RDF dataset, producing a signed dataset with Merkle root and signature.

### 2.1 Rust API

```rust
pub fn sign(
    dataset: &str,           // Turtle/N-Quads content
    keypair: &KeyPair,       // Signing keypair
    config: &Config,         // Configuration
) -> Result<SignedDataset, Error>;
```

### 2.2 CLI

```bash
sparql-zk sign \
    --input data.ttl \
    --keypair keypair.json \
    --output signed.json
```

### 2.3 Output Structure

```rust
pub struct SignedDataset {
    /// Merkle root of encoded triples
    pub root: Field,
    
    /// Signature over the root
    pub signature: Signature,
    
    /// Signer's public key
    pub public_key: PublicKey,
    
    /// Encoded triples (for proof generation)
    pub triples: Vec<EncodedTriple>,
    
    /// Configuration used
    pub config: Config,
}
```

---

## 3. Prove

Generates a zero-knowledge proof that a SPARQL query holds over signed datasets.

### 3.1 Rust API

```rust
pub fn prove(
    query: &str,                      // SPARQL SELECT query
    datasets: &[SignedDataset],       // Signed datasets
    config: &Config,                  // Configuration
) -> Result<Proof, Error>;
```

### 3.2 CLI

```bash
sparql-zk prove \
    --query query.rq \
    --datasets signed1.json,signed2.json \
    --output proof.json
```

### 3.3 Process

1. **Parse query** using spargebra
2. **Generate circuit** from SPARQL patterns (see [algebra.md](./algebra.md))
3. **Compute witness** from datasets (variable bindings, Merkle paths)
4. **Run prover** (Noir/Barretenberg)
5. **Package proof** with metadata

### 3.4 Output Structure

```rust
pub struct Proof {
    /// The ZK proof bytes
    pub proof: Vec<u8>,
    
    /// Verification key
    pub verification_key: Vec<u8>,
    
    /// Public inputs
    pub public_inputs: PublicInputs,
    
    /// Metadata for verification
    pub metadata: ProofMetadata,
}

pub struct PublicInputs {
    /// Public keys of dataset signers
    pub public_keys: Vec<PublicKey>,
}

pub struct ProofMetadata {
    /// The SPARQL query
    pub query: String,
    
    /// Disclosed variable bindings (if any)
    pub bindings: Option<HashMap<String, String>>,
    
    /// Configuration used
    pub config: Config,
}
```

---

## 4. Verify

Verifies a proof is valid.

### 4.1 Rust API

```rust
pub fn verify(proof: &Proof) -> Result<VerificationResult, Error>;

pub enum VerificationResult {
    Valid,
    Invalid(String),
}
```

### 4.2 CLI

```bash
sparql-zk verify --proof proof.json
```

### 4.3 Process

1. **Extract** verification key and public inputs from proof
2. **Verify** the ZK proof using Barretenberg
3. **Return** result

---

## 5. Info

Returns disclosure information for a query and configuration.

### 5.1 Rust API

```rust
pub fn info(
    query: &str,
    config: &Config,
) -> DisclosureInfo;
```

### 5.2 CLI

```bash
sparql-zk info --query query.rq --config config.json
```

### 5.3 Output Structure

```rust
pub struct DisclosureInfo {
    /// The query (always disclosed)
    pub query: String,
    
    /// Structural parameters disclosed
    pub merkle_depth: u32,
    pub path_segment_max: u32,
    pub signature_scheme: String,
    
    /// Variables that will be disclosed
    pub disclosed_variables: Vec<String>,
    
    /// Variables that will be hidden
    pub hidden_variables: Vec<String>,
    
    /// Human-readable summary
    pub summary: String,
}
```

---

## 6. Configuration

```rust
pub struct Config {
    /// Hash function for h_2 and h_4
    pub hash: HashType,           // pedersen | poseidon2
    
    /// Hash function for strings
    pub string_hash: StringHashType,  // blake3 | sha256 | keccak256
    
    /// Signature scheme
    pub signature: SignatureType,     // schnorr | ecdsa_secp256k1 | ...
    
    /// Merkle tree depth
    pub merkle_depth: u32,            // default: 11
    
    /// Max property path length
    pub path_segment_max: u32,        // default: 8
    
    /// Variables to disclose (None = all projected)
    pub disclose: Option<Vec<String>>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hash: HashType::Pedersen,
            string_hash: StringHashType::Blake3,
            signature: SignatureType::Schnorr,
            merkle_depth: 11,
            path_segment_max: 8,
            disclose: None,
        }
    }
}
```

---

## 7. Error Types

```rust
pub enum Error {
    /// Invalid SPARQL query
    ParseError(String),
    
    /// Query uses unsupported features
    UnsupportedFeature(String),
    
    /// Dataset doesn't satisfy query
    NoSolution,
    
    /// Signature verification failed
    InvalidSignature,
    
    /// Circuit compilation failed
    CircuitError(String),
    
    /// Proof generation failed
    ProverError(String),
    
    /// Proof verification failed
    VerifierError(String),
}
```

---

## 8. TypeScript/WASM API

The same API is available via WASM for TypeScript:

```typescript
import { sign, prove, verify, info, Config } from '@jeswr/sparql-zk-proof';

// Sign
const signed = await sign(turtleData, keypair, config);

// Prove
const proof = await prove(sparqlQuery, [signed], config);

// Verify
const result = await verify(proof);

// Info
const disclosure = info(sparqlQuery, config);
```

---

## 9. Example Usage

```rust
use sparql_zk::{sign, prove, verify, Config, KeyPair};

// 1. Sign a dataset
let keypair = KeyPair::generate();
let dataset = r#"
    @prefix foaf: <http://xmlns.com/foaf/0.1/> .
    <#alice> foaf:name "Alice" ;
             foaf:age 30 .
"#;
let signed = sign(dataset, &keypair, &Config::default())?;

// 2. Generate a proof
let query = r#"
    SELECT ?name WHERE {
        ?person foaf:name ?name .
        ?person foaf:age ?age .
        FILTER(?age >= 18)
    }
"#;
let proof = prove(query, &[signed], &Config::default())?;

// 3. Verify the proof
match verify(&proof)? {
    VerificationResult::Valid => println!("Proof is valid!"),
    VerificationResult::Invalid(reason) => println!("Invalid: {}", reason),
}
```

---

## References

- [Noir Language](https://noir-lang.org/docs)
- [Barretenberg](https://github.com/AztecProtocol/barretenberg)
