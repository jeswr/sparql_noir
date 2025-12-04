# Encoding Specification

This document provides the formal, declarative specification for encoding RDF terms, literals, and triples into zero-knowledge circuit inputs. It serves as the authoritative source of truth for code generation, paper writing, security analysis, and W3C specification development.

## 1. Preliminaries

### 1.1 Notation

| Symbol | Description |
|--------|-------------|
| $\mathbb{F}_p$ | Prime field (BN254 scalar field, $p \approx 2^{254}$) |
| $U$ | Set of all IRIs (URIs) |
| $B$ | Set of all blank nodes |
| $L$ | Set of all RDF literals |
| $V$ | Set of all variables |
| $T = U \cup B \cup L$ | Set of all RDF terms |
| $\mathcal{G}$ | Set of all graphs (including default graph) |
| $\bot$ | Default graph identifier |

### 1.2 RDF Foundation

Following [RDF 1.1 Concepts](https://www.w3.org/TR/rdf11-concepts/):

- **IRI** (Named Node): An internationalized resource identifier
- **Blank Node**: A locally-scoped identifier  
- **Literal**: A value with optional language tag or datatype IRI
- **Triple**: An ordered 3-tuple $(s, p, o)$ where $s \in U \cup B$, $p \in U$, $o \in T$
- **Quad**: An ordered 4-tuple $(s, p, o, g)$ extending triple with graph $g \in \mathcal{G}$

---

## 2. Hash Function Interfaces

The encoding scheme is parameterized by configurable hash functions. All hash functions MUST be collision-resistant and produce outputs in $\mathbb{F}_p$.

### 2.1 Core Hash Functions

```
h_2 : F_p × F_p → F_p
h_4 : F_p × F_p × F_p × F_p → F_p
h_s : String → F_p
```

### 2.2 Supported Implementations

| Function | `h_2` / `h_4` Options | `h_s` Options |
|----------|----------------------|---------------|
| **Pedersen** | `std::hash::pedersen_hash` | N/A |
| **Poseidon2** | `poseidon2::bn254::hash_{2,4}` | N/A |
| **Blake2s** | Custom wrapper | `std::hash::blake2s` |
| **Blake3** | N/A | `std::hash::blake3` |
| **SHA-256** | N/A | `sha256::digest` |
| **Keccak256** | N/A | `keccak256::keccak256` |

### 2.3 Default Configuration

```
h_2 = pedersen_hash
h_4 = pedersen_hash  
h_s = blake3
```

### 2.4 String to Field Conversion

For string values, the encoding applies `h_s` and interprets the result as a field element:

$$
\text{Enc}_s(str) = \text{from\_le\_bytes}(h_s(\text{as\_bytes}(str)))
$$

---

## 3. Term Type Codes

Each RDF term type is assigned a unique integer code:

| Term Type | Code | Symbol |
|-----------|------|--------|
| Named Node (IRI) | 0 | $\tau_{iri}$ |
| Blank Node | 1 | $\tau_{blank}$ |
| Literal | 2 | $\tau_{lit}$ |
| Variable | 3 | $\tau_{var}$ |
| Default Graph | 4 | $\tau_{default}$ |
| Quad | 5 | $\tau_{quad}$ |

**Definition (Term Type Function):**
$$
\text{type}: T \cup V \cup \{\bot\} \to \{0, 1, 2, 3, 4, 5\}
$$

---

## 4. Term Encoding

### 4.1 General Term Encoding

The encoding of an RDF term combines its type code with its value encoding:

$$
\text{Enc}_t : T \cup \{\bot\} \to \mathbb{F}_p
$$

$$
\text{Enc}_t(t) = h_2(\text{type}(t), \text{Enc}_v(t))
$$

Where $\text{Enc}_v$ is the value encoding function defined below.

### 4.2 Value Encoding by Term Type

#### 4.2.1 Named Node (IRI)

For $n \in U$:
$$
\text{Enc}_v(n) = \text{Enc}_s(\text{str}(n))
$$

Where $\text{str}(n)$ is the string representation of the IRI.

#### 4.2.2 Blank Node

For $b \in B$:
$$
\text{Enc}_v(b) = \text{Enc}_s(\text{id}(b))
$$

Where $\text{id}(b)$ is the blank node identifier string.

#### 4.2.3 Default Graph

$$
\text{Enc}_v(\bot) = \text{Enc}_s(\text{""})
$$

---

## 5. Literal Encoding

Literals require special handling due to their complex structure (value, optional language tag, datatype).

### 5.1 General Literal Encoding

For a literal $l \in L$ with:
- $\text{val}(l)$: lexical value string
- $\text{lang}(l)$: language tag (empty string if none)
- $\text{dt}(l)$: datatype IRI

$$
\text{Enc}_v(l) = h_4(
  \text{Enc}_s(\text{val}(l)),
  \text{Enc}_{special}(l),
  \text{Enc}_s(\text{lang}(l)),
  \text{Enc}_s(\text{str}(\text{dt}(l)))
)
$$

### 5.2 Special Literal Handling

The $\text{Enc}_{special}$ function provides optimized encodings for specific XSD datatypes, enabling efficient in-circuit comparisons.

#### 5.2.1 XSD Boolean

For $l$ with $\text{dt}(l) = \text{xsd:boolean}$:

$$
\text{Enc}_{special}(l) = \begin{cases}
1 & \text{if } \text{val}(l) \in \{\text{"true"}, \text{"1"}\} \\
0 & \text{if } \text{val}(l) \in \{\text{"false"}, \text{"0"}\}
\end{cases}
$$

#### 5.2.2 XSD Integer

For $l$ with $\text{dt}(l) = \text{xsd:integer}$:

$$
\text{Enc}_{special}(l) = \text{parse\_int}(\text{val}(l))
$$

The value is parsed as a signed integer and represented directly as a field element.

**Constraint:** The integer MUST fit within the field size ($|v| < p$).

#### 5.2.3 XSD DateTime

For $l$ with $\text{dt}(l) = \text{xsd:dateTime}$:

$$
\text{Enc}_{special}(l) = \text{unix\_epoch\_ms}(\text{val}(l))
$$

The datetime is converted to Unix epoch milliseconds, enabling numeric comparisons.

**Fallback:** If parsing fails, $\text{Enc}_{special}(l) = \text{Enc}_s(\text{val}(l))$.

#### 5.2.4 Other Datatypes (Default)

For all other datatypes:

$$
\text{Enc}_{special}(l) = \text{Enc}_s(\text{val}(l))
$$

### 5.3 Complete Literal Encoding

Combining with Section 4.1:

$$
\text{Enc}_t(l) = h_2(\tau_{lit}, \text{Enc}_v(l))
$$

$$
= h_2(2, h_4(
  \text{Enc}_s(\text{val}(l)),
  \text{Enc}_{special}(l),
  \text{Enc}_s(\text{lang}(l)),
  \text{Enc}_s(\text{str}(\text{dt}(l)))
))
$$

---

## 6. Triple/Quad Encoding

### 6.1 Triple Encoding

For a triple $(s, p, o)$:

$$
\text{Enc}_T : (U \cup B) \times U \times T \to \mathbb{F}_p
$$

$$
\text{Enc}_T(s, p, o) = h_4(
  \text{Enc}_t(s),
  \text{Enc}_t(p),
  \text{Enc}_t(o),
  \text{Enc}_t(\bot)
)
$$

### 6.2 Quad Encoding

For a quad $(s, p, o, g)$:

$$
\text{Enc}_Q : (U \cup B) \times U \times T \times \mathcal{G} \to \mathbb{F}_p
$$

$$
\text{Enc}_Q(s, p, o, g) = h_4(
  \text{Enc}_t(s),
  \text{Enc}_t(p),
  \text{Enc}_t(o),
  \text{Enc}_t(g)
)
$$

---

## 7. Dataset Structure

### 7.1 Merkle Tree Representation

An RDF dataset is represented as a Merkle tree for efficient membership proofs.

**Parameters:**
- $d$: Tree depth (configurable, default = 11)
- Maximum capacity: $2^d$ triples

**Definition (Merkle Root):**

For a dataset $D = \{q_1, q_2, \ldots, q_n\}$:

$$
\text{root}(D) = \text{MerkleRoot}(\text{Enc}_Q(q_1), \text{Enc}_Q(q_2), \ldots, \text{Enc}_Q(q_n), 0, \ldots, 0)
$$

Where padding zeros fill the tree to $2^d$ leaves.

### 7.2 Merkle Path Structure

A Merkle inclusion proof for quad $q_i$ consists of:

```
struct MerklePath {
    siblings: [F_p; d],      // Sibling hashes at each level
    directions: [bit; d-1],  // Path direction (0=left, 1=right)
}
```

### 7.3 Inclusion Verification

$$
\text{verify\_inclusion}(leaf, path, root) = \begin{cases}
\text{true} & \text{if } \text{compute\_root}(leaf, path) = root \\
\text{false} & \text{otherwise}
\end{cases}
$$

Where $\text{compute\_root}$ iteratively applies $h_2$ up the path.

---

## 8. Signed Dataset

### 8.1 Signature Structure

A signed dataset binds a Merkle root to a cryptographic signature:

```
struct SignedDataset {
    root: F_p,                // Merkle tree root
    signature: Signature,     // Cryptographic signature over root
    public_key: PublicKey,    // Signer's public key
}
```

### 8.2 Supported Signature Schemes

| Scheme | Curve | Public Key Size | Signature Size |
|--------|-------|-----------------|----------------|
| Schnorr | Grumpkin | Point | 64 bytes |
| ECDSA | secp256k1 | Point | 64 bytes |
| ECDSA | secp256r1 | Point | 64 bytes |
| BabyJubJub | BabyJubJub | Point | 64 bytes |
| BLS | BLS12-381 | Point | Variable |

### 8.3 Default Signature Scheme

The default scheme is **Schnorr over Grumpkin curve**, which is native to Noir and provides efficient in-circuit verification.

---

## 9. Circuit Input Structure

### 9.1 Triple Input

For each triple pattern in a BGP, the circuit receives:

```
struct TripleInput {
    terms: [F_p; 4],              // Encoded [s, p, o, g]
    path: [F_p; MERKLE_DEPTH],    // Merkle siblings
    directions: [u8; MERKLE_DEPTH - 1],  // Path directions
}
```

### 9.2 Root Input

For each signed dataset:

```
struct RootInput {
    value: F_p,           // Merkle root
    signature: Signature, // Signature over root
}
```

### 9.3 Variable Bindings

Query variable bindings:

```
struct Variables {
    // One field per projected variable
    var_1: F_p,
    var_2: F_p,
    ...
}
```

---

## 10. Encoding Correctness Properties

### 10.1 Collision Resistance

For any two distinct terms $t_1 \neq t_2$:
$$
\Pr[\text{Enc}_t(t_1) = \text{Enc}_t(t_2)] \leq \text{negl}(\lambda)
$$

### 10.2 Determinism

The encoding is deterministic:
$$
t_1 = t_2 \implies \text{Enc}_t(t_1) = \text{Enc}_t(t_2)
$$

### 10.3 Binding

Given $\text{Enc}_t(t)$, it is computationally infeasible to find $t' \neq t$ such that $\text{Enc}_t(t') = \text{Enc}_t(t)$.

---

## 11. Implementation Reference

### 11.1 Rust Implementation

Primary implementation in `transform/src/main.rs`:

```rust
// Term type codes
const NAMED_NODE: u32 = 0;
const BLANK_NODE: u32 = 1;
const LITERAL: u32 = 2;
const VARIABLE: u32 = 3;
const DEFAULT_GRAPH: u32 = 4;

// Hash function selection
fn hash2_name() -> &'static str { ... }
fn hash4_name() -> &'static str { ... }
fn string_hash_name() -> &'static str { ... }

// Core encoding functions
fn string_to_field_fn(s: &str) -> String { ... }
fn term_to_field_fn(term: &GroundTerm) -> String { ... }
fn get_term_encoding_string(term: &GroundTerm) -> String { ... }
fn special_literal_value(lit: &Literal) -> String { ... }
```

### 11.2 Noir Implementation

Circuit-side encoding in `noir/lib/consts/src/lib.nr`:

```noir
pub fn hash2(input: [Field; 2]) -> Field {
    std::hash::pedersen_hash(input)
}

pub fn hash4(input: [Field; 4]) -> Field {
    std::hash::pedersen_hash(input)
}

pub fn hash_string<let N: u32>(input: [u8; N]) -> [u8; 32] {
    dep::sha256::digest(input)
}
```

---

## 12. Changelog

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2024-12-04 | Initial formal specification |

---

## References

1. [RDF 1.1 Concepts and Abstract Syntax](https://www.w3.org/TR/rdf11-concepts/)
2. [SPARQL 1.1 Query Language](https://www.w3.org/TR/sparql11-query/)
3. Pedersen Hash: Efficient ZK-friendly hash function
4. Poseidon2: SNARK-friendly permutation
5. Blake3: Fast cryptographic hash function
