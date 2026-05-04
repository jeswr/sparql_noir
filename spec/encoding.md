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
struct TermWitness {
    hash:   Field,                  // term hash (Enc_t result, §3)
    bytes:  [u8; STRING_LEN_MAX],   // bounded lexical bytes (advisory; see §6)
    length: u32,                    // 0 ≤ length ≤ STRING_LEN_MAX
}

struct Triple {
    terms:      [TermWitness; 4],         // [s, p, o, g] witnesses
    path:       [Field; MERKLE_DEPTH],    // Sibling hashes
    directions: [u8; MERKLE_DEPTH - 1],   // 0=left, 1=right
}
```

The Merkle commitment is computed over `[terms[0].hash, …, terms[3].hash]` exactly as in §4 — `bytes` and `length` are *not* part of the hash chain. See §6 for the witness's role in string operations.

---

## 6. Bounded Byte-Array Witness

### 6.1 Motivation

Hash-only term encoding (§3) supports equality (BGP matching, FILTER `=`) but rules out string operators that need raw lexical content — `STRSTARTS`, `STRENDS`, `CONTAINS`, `STRLEN`, `LANG`, `REGEX`, `IRI(…)`, `STRDT(…)`, `SHA256(…)`. SPARQL_ROADMAP.md §6.3 / §8.Q3 records the decision: extend the term witness with a bounded byte buffer plus a length witness.

### 6.2 Shape

```noir
pub struct TermWitness {
    pub hash:   Field,
    pub bytes:  [u8; STRING_LEN_MAX],
    pub length: u32,
}
```

`STRING_LEN_MAX` is a public global in `noir/lib/consts` (default `64`), configurable via `setup.ts` exactly like `MERKLE_DEPTH`, `stringHash`, etc. (see §6.5).

`length` is the count of meaningful bytes; `bytes[length..STRING_LEN_MAX]` is unconstrained padding (typically zero). Each consumer that walks `bytes` MUST clamp its index to `length`.

### 6.3 Soundness

Round 1 wires the witness shape only — it does **not** add a global binding constraint between `bytes` / `length` and `hash` inside `verify_inclusion`. The reasoning:

- Most term positions hold IRIs / blank nodes / numeric literals where the bytes view is irrelevant. Forcing `encode_string_bounded(bytes, length) == lexical_hash_of(hash)` for every term costs `STRING_LEN_MAX` bytes of input plus a `hash_string` call per term per triple — paid even by queries that touch zero string operators.
- Instead, the binding is **caller-supplied**. Round-2 string-operator lowering will emit, immediately before any `bytes`-touching code, a constraint of the form

  ```noir
  // round-2 helper — sketch
  pub fn bind_term_bytes(w: TermWitness, expected_lexical_hash: Field) {
      let computed = consts::encode_string_bounded(w.bytes, w.length);
      assert(computed == expected_lexical_hash);
      assert(w.length as Field <= STRING_LEN_MAX as Field);
  }
  ```

  where `expected_lexical_hash` is reconstructed from `w.hash` and the term's known structural metadata (e.g. for a literal, the `lexical_value` slot of the inner `hash4`). The prover only pays the byte-witness cost on the terms a query actually needs to read as bytes.

- Until a string operator is invoked on a term, an adversarial prover may supply arbitrary `bytes` / `length` for that term — but the `hash` field still binds the term's identity into the signed Merkle root, so query results remain sound. The bytes witness is only load-bearing once the `bind_term_bytes` constraint is added.

This contract is documented at the top of `noir/lib/types/src/lib.nr`.

### 6.4 Cost

Per triple: `4 × STRING_LEN_MAX` bytes of private input (4 × 64 = 256 bytes by default), plus `4 × u32` for the length witnesses. No extra constraints in round 1; round 2 adds one `hash_string`-equality constraint per byte-using term per use site.

For `STRING_LEN_MAX = 64` and a 4-triple BGP, the witness blob grows by `4 × 4 × 64 = 1024` bytes — negligible against signature / Merkle path data. Picking `STRING_LEN_MAX = 256` quadruples the byte footprint and quadruples the (round-2) `hash_string` cost. Picking `STRING_LEN_MAX = 32` halves both but truncates lexical values longer than 32 bytes, breaking string operations on those terms (the prover cannot supply a witness that satisfies the length bound, so the proof fails to construct).

| `STRING_LEN_MAX` | Bytes per triple | Coverage of typical RDF lexicals |
|---|---|---|
| 32  | 128  | Short IRIs, integers, booleans, language-tag strings |
| 64  | 256  | Default. Most labels, short IRIs, dates |
| 128 | 512  | Fully-qualified IRIs, names, short prose |
| 256 | 1024 | Long URLs, URIs with deep path segments |

### 6.5 Public API for `STRING_LEN_MAX`

The bound is configured at setup time via the same template substitution as the other `consts` parameters:

- TypeScript: `--string-len-max <n>` flag on `npm run setup` (defaults to 64).
- The substituted value lands in `noir/lib/consts/src/lib.nr` as `pub global STRING_LEN_MAX: u32 = <n>`.
- The Rust transform reads the value back via `TransformOptions::string_len_max` (defaults to `DEFAULT_STRING_LEN_MAX = 64`); WASM bindings expose it as the `string_len_max` field on the options object.

Callers picking a non-default value MUST keep the TypeScript flag and the Rust option in sync — a mismatch yields a compile-time error in the generated circuit because input shapes won't match.

### 6.6 Compatibility

- BGP matching, FILTER `=`, FILTER comparison, LANG-tag / DATATYPE-tag equality all still resolve through `terms[k].hash` and are unchanged.
- `verify_inclusion` and the sorted-Merkle commitment (`utils::merkle`) are unchanged; they hash over the `hash` field of each term witness.
- Round-2 string operators add their own `bind_term_bytes` constraints at use sites; no global `verify_inclusion` change is needed.
- The encode binary (`noir/bin/encode`) and the `sign.ts` / `prove.ts` data flow now produce the bytes / length witness alongside each term hash; non-literal positions (NamedNode / BlankNode) supply the IRI / blank-id bytes verbatim, since those forms are also lexical strings under §3.

---

## 7. Noir Implementation

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

## 8. Rust Implementation

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
