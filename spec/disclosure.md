# Disclosure Specification

This document specifies the privacy model for ZK-SPARQL proofs, defining what information is disclosed and what remains hidden.

## 1. Privacy Model Overview

### 1.1 Core Principle

A ZK-SPARQL proof reveals **only** what is necessary for verification, plus explicitly configured disclosures. The underlying signed datasets remain hidden except for structural information inherent in the proof system.

### 1.2 Disclosure Categories

| Category | Description | Controllable |
|----------|-------------|--------------|
| **Structural** | Inherent to proof architecture | No |
| **Query** | The SPARQL query itself | No |
| **Authentication** | Signer public keys | No |
| **Result** | Query variable bindings | Yes |
| **Bounds** | Numeric range constraints | Partially |

---

## 2. Structural Disclosure

### 2.1 Merkle Tree Depth

**Disclosed:** The configured `MERKLE_DEPTH` parameter.

**Implication:** Reveals maximum dataset size capacity ($2^{\text{MERKLE\_DEPTH}}$ triples).

**Example:** `MERKLE_DEPTH = 11` discloses that each signed dataset contains ≤ 2048 triples.

### 2.2 Number of Datasets

**Disclosed:** Count of signed datasets used in the proof.

**Implication:** Reveals how many distinct signers/sources contributed data.

### 2.3 BGP Pattern Count

**Disclosed:** Number of triple patterns in the query's BGP(s).

**Implication:** Reveals query complexity and structure.

### 2.4 Property Path Depth

**Disclosed:** `PATH_SEGMENT_MAX` and actual path length taken.

**Implication:** For queries with `+`, `*`, `?` paths, reveals:
- Maximum allowed path depth (architecture constant)
- Actual traversal depth for each path (≤ PATH_SEGMENT_MAX)

**Example:** If `PATH_SEGMENT_MAX = 8` and a `foaf:knows+` path resolves in 3 hops, the verifier learns that exactly 3 intermediate nodes were traversed.

### 2.5 Union Branch Count

**Disclosed:** Number of branches in UNION patterns.

**Implication:** Query structure is visible.

### 2.6 Optional Pattern Presence

**Disclosed:** Whether optional patterns matched.

**Implication:** For `OPTIONAL { ?x ?p ?o }`, the verifier knows if the optional pattern matched (bound) or not (unbound).

---

## 3. Query Disclosure

### 3.1 Full Query Text

**Disclosed:** The complete SPARQL query.

**Rationale:** The query defines what is being proven. Without it, verification is meaningless.

**Privacy Note:** Query patterns may reveal sensitive information about what the prover is looking for. Users should consider query content carefully.

### 3.2 Query Hash

**Disclosed:** Cryptographic hash of the query (in public inputs).

**Purpose:** Binds the proof to a specific query, preventing proof reuse for different queries.

---

## 4. Authentication Disclosure

### 4.1 Signer Public Keys

**Disclosed:** All public keys of dataset signers.

**Rationale:** Verification requires checking that data came from trusted sources.

**Example:** A proof involving datasets signed by `pk_1` (Government) and `pk_2` (Employer) reveals both organizations participated.

### 4.2 Signature Scheme

**Disclosed:** The signature algorithm used (Schnorr, ECDSA, BLS, etc.).

**Rationale:** Required for verification algorithm selection.

### 4.3 Not Disclosed

- Actual signature values
- Merkle tree roots
- Any data content

---

## 5. Result Disclosure

### 5.1 Projected Variables

**Default:** Variable bindings in the SELECT clause are disclosed.

**Configurable:** Individual variables can be marked as hidden.

### 5.2 Hidden Bindings

For privacy-preserving queries, bindings can be hidden while still proving constraints:

```sparql
SELECT ?name ?age
WHERE {
  ?person foaf:name ?name .
  ?person foaf:age ?age .
  FILTER(?age >= 18)
}
```

**Configuration:**
```json
{
  "disclose": ["?name"],
  "hide": ["?age"]
}
```

**Result:** Proves `?age >= 18` without revealing the actual age.

### 5.3 Term Encoding vs. Term Value

When disclosing a binding:

| Mode | Disclosed | Hidden |
|------|-----------|--------|
| **Value** | Decoded term (IRI string, literal value) | Nothing |
| **Encoding** | Field element encoding | Raw term |
| **Hash** | Hash of binding | Term and encoding |

---

## 6. Bounds Disclosure

### 6.1 Numeric Comparisons

For filters like `?x < 100`:

| Mode | Disclosed | Hidden |
|------|-----------|--------|
| **Bound disclosed** | The comparison constant (100) | Actual value of ?x |
| **Bound hidden** | Nothing | Both bound and value |

### 6.2 Range Constraints

For `a < ?x < b`:

**Disclosed:** Bounds $a$ and $b$ (unless explicitly hidden)

**Hidden:** Actual value of `?x`

### 6.3 DateTime Comparisons

DateTime values are converted to Unix epoch for comparison:

**Disclosed:** Epoch representation of bounds

**Hidden:** Actual datetime value

---

## 7. Disclosure Summary Table

| Information | Disclosed | Notes |
|-------------|-----------|-------|
| SPARQL query | ✅ Always | Core to verification |
| Public keys | ✅ Always | Required for auth |
| Signature scheme | ✅ Always | Required for verification |
| Hash functions | ✅ Always | Required for encoding verification |
| Merkle depth | ✅ Always | Architecture parameter |
| Dataset count | ✅ Always | Structural |
| BGP pattern count | ✅ Always | Query structure |
| Path segment max | ✅ If paths used | Architecture parameter |
| Actual path length | ✅ If paths used | Per-path disclosure |
| Union branch count | ✅ If unions used | Query structure |
| Optional matched | ✅ If optionals used | Structural |
| Projected bindings | ⚙️ Configurable | Default: disclosed |
| Filter bounds | ⚙️ Configurable | Default: disclosed |
| Merkle roots | ❌ Never | Core hidden value |
| Signature values | ❌ Never | Core hidden value |
| Non-projected bindings | ❌ Never | Internal variables |
| Dataset content | ❌ Never | Core protected data |

---

## 8. Privacy Analysis

### 8.1 Linkability

**Risk:** Multiple proofs from the same dataset may be linkable.

**Mitigation:** 
- Use fresh blank node identifiers per proof
- Consider adding proof-specific randomness

### 8.2 Query Analysis Attacks

**Risk:** Query structure may reveal intent.

**Example:** Query for `ex:hasConviction` reveals interest in criminal records.

**Mitigation:** Query content is user's responsibility to manage.

### 8.3 Timing Analysis

**Risk:** Proof generation time may reveal dataset size.

**Mitigation:** Pad to constant time (future work).

### 8.4 Size Analysis

**Risk:** Proof size may reveal query complexity.

**Mitigation:** Fixed-size proofs (inherent to Groth16/PLONK).

---

## 9. Disclosure Configuration

### 9.1 Configuration Schema

```rust
pub struct DisclosureConfig {
    /// Variables to disclose (default: all projected)
    pub disclose_variables: Option<Vec<String>>,
    
    /// Variables to hide (takes precedence)
    pub hide_variables: Option<Vec<String>>,
    
    /// Disclose filter bounds
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

### 9.2 Default Configuration

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

### 9.3 Privacy-Preserving Configuration

```rust
let config = DisclosureConfig {
    disclose_variables: Some(vec![]),  // Hide all
    hide_variables: None,
    disclose_bounds: false,
    disclosure_mode: DisclosureMode::Hash,
};
```

---

## 10. Disclosure Info API

### 10.1 Purpose

Before generating a proof, users can inspect what will be disclosed:

```rust
pub fn info(query: &str, config: &Config) -> DisclosureInfo;
```

### 10.2 DisclosureInfo Structure

```rust
pub struct DisclosureInfo {
    /// Structural disclosures (always present)
    pub structural: StructuralDisclosure,
    
    /// Query-derived disclosures
    pub query: QueryDisclosure,
    
    /// Configurable disclosures
    pub configurable: ConfigurableDisclosure,
    
    /// Human-readable summary
    pub summary: String,
}

pub struct StructuralDisclosure {
    pub merkle_depth: u32,
    pub path_segment_max: u32,
    pub signature_scheme: String,
    pub hash_functions: HashConfig,
}

pub struct QueryDisclosure {
    pub query_text: String,
    pub bgp_pattern_count: usize,
    pub union_branch_count: usize,
    pub has_optional_patterns: bool,
    pub has_property_paths: bool,
    pub path_expressions: Vec<String>,
}

pub struct ConfigurableDisclosure {
    pub disclosed_variables: Vec<String>,
    pub hidden_variables: Vec<String>,
    pub disclosed_bounds: Vec<BoundInfo>,
    pub hidden_bounds: Vec<String>,
}
```

### 10.3 Example Output

```
Disclosure Summary for Query:
=============================
SELECT ?name WHERE { ?person foaf:name ?name . ?person foaf:age ?age . FILTER(?age >= 18) }

ALWAYS DISCLOSED:
- Query: (shown above)
- Merkle depth: 11 (max 2048 triples per dataset)
- Hash functions: h2=pedersen, h4=pedersen, hs=blake3
- Signature scheme: Schnorr/Grumpkin
- Dataset count: Will be disclosed at proof time
- BGP patterns: 2

CONFIGURABLE (current settings):
- Disclosed variables: ?name
- Hidden variables: ?age
- Disclosed bounds: ?age >= 18

NEVER DISCLOSED:
- Merkle roots
- Signature values
- Dataset content beyond query results
```

---

## 11. Compliance Considerations

### 11.1 GDPR

For EU data protection:
- **Data minimization:** Only disclose what's necessary
- **Purpose limitation:** Query defines purpose
- **Right to be forgotten:** Proofs don't contain raw data

### 11.2 Selective Disclosure

Aligns with [W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model-2.0/) selective disclosure:
- Holder controls what to reveal
- Verifier learns only disclosed claims

### 11.3 Audit Trail

For regulated use cases:
- Proof metadata includes timestamp
- Query hash provides non-repudiation
- Public keys establish provenance

---

## References

1. [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
2. GDPR Article 5 - Principles relating to processing of personal data
3. Zero-Knowledge Proofs: A Survey of Techniques and Applications
