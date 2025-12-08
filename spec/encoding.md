# Encoding Specification

This document specifies how RDF terms and triples are encoded into field elements for use in Noir circuits.

## 1. Hash Functions

The encoding uses configurable hash functions:

| Function | Type | Default |
|----------|------|---------|
| `h_2` | `(Field, Field) → Field` | `pedersen_hash` |
| `h_4` | `(Field, Field, Field, Field) → Field` | `pedersen_hash` |
| `h_s` | `String → Field` | `blake3` |

**String to Field:**
```
Enc_s(str) = Field::from_le_bytes(h_s(str.as_bytes()))
```

---

## 2. Term Types

| Type | Code |
|------|------|
| NamedNode (IRI) | 0 |
| BlankNode | 1 |
| Literal | 2 |
| Variable | 3 |
| DefaultGraph | 4 |

---

## 3. Term Encoding

### 3.1 General Formula

```
Enc_t(term) = h_2(type_code, value_encoding)
```

### 3.2 Named Node

```
Enc_t(iri) = h_2(0, Enc_s(iri_string))
```

### 3.3 Blank Node

```
Enc_t(blank) = h_2(1, Enc_s(blank_id))
```

### 3.4 Literal

Literals have a 4-component encoding:

```
value_encoding = h_4(
    Enc_s(lexical_value),
    special_encoding,
    Enc_s(language_tag),      // empty string if none
    Enc_s(datatype_iri)
)

Enc_t(literal) = h_2(2, value_encoding)
```

**Special Encoding** provides numeric values for in-circuit comparisons:

| Datatype | Special Encoding |
|----------|------------------|
| `xsd:boolean` | `1` for true, `0` for false |
| `xsd:integer` | Parsed integer value |
| `xsd:dateTime` | Unix epoch milliseconds |
| Other | `Enc_s(lexical_value)` |

### 3.5 Default Graph

```
Enc_t(default_graph) = h_2(4, Enc_s(""))
```

---

## 4. Triple/Quad Encoding

```
Enc_Q(s, p, o, g) = h_4(Enc_t(s), Enc_t(p), Enc_t(o), Enc_t(g))
```

For triples (no named graph):
```
Enc_T(s, p, o) = Enc_Q(s, p, o, default_graph)
```

---

## 5. Dataset Structure

### 5.1 Merkle Tree

Encoded triples are leaves in a Merkle tree:

- **Depth:** Configurable (default: 11, max 2048 triples)
- **Hash:** Uses `h_2` for internal nodes
- **Padding:** Empty leaves are 0

### 5.2 Inclusion Proof

```noir
struct TripleInput {
    terms: [Field; 4],                    // [s, p, o, g] encoded
    path: [Field; MERKLE_DEPTH],          // Sibling hashes
    directions: [u8; MERKLE_DEPTH - 1],   // 0=left, 1=right
}
```

---

## 6. Noir Implementation

```noir
// From noir/lib/consts/src/lib.nr
pub fn hash2(input: [Field; 2]) -> Field {
    std::hash::pedersen_hash(input)
}

pub fn hash4(input: [Field; 4]) -> Field {
    std::hash::pedersen_hash(input)
}
```

---

## 7. Rust Implementation

```rust
// Term type codes
const NAMED_NODE: u32 = 0;
const BLANK_NODE: u32 = 1;
const LITERAL: u32 = 2;
const DEFAULT_GRAPH: u32 = 4;

fn encode_term(term: &Term) -> String {
    let type_code = match term { /* ... */ };
    let value = encode_value(term);
    format!("hash2([{}, {}])", type_code, value)
}
```

---

## References

- [RDF 1.1 Concepts](https://www.w3.org/TR/rdf11-concepts/)
