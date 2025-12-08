# Disclosure Model

This document specifies what information is disclosed by a ZK-SPARQL proof.

## 1. Always Disclosed

The following are always revealed by a proof:

| Item | Reason |
|------|--------|
| **SPARQL query** | Defines what is being proven |
| **Public keys** | Required for authentication |
| **Signature scheme** | Required for verification |
| **Hash functions** | Required for encoding verification |
| **Merkle depth** | Architecture parameter |
| **Number of datasets** | Structural |

---

## 2. Conditionally Disclosed

| Item | Default | Configurable |
|------|---------|--------------|
| **Projected variable bindings** | Disclosed | Yes |
| **Path length** (for `+`, `*`, `?`) | Disclosed | No |
| **Optional pattern matched** | Disclosed | No |
| **Union branch taken** | Disclosed | No |

---

## 3. Never Disclosed

| Item |
|------|
| Merkle roots |
| Signature values |
| Non-projected variable bindings |
| Dataset content beyond query results |
| Triple positions/indices |

---

## 4. Disclosure Configuration

```rust
pub struct Config {
    /// Variables to disclose (None = all projected)
    pub disclose: Option<Vec<String>>,
}
```

**Example - Disclose only `?name`:**
```rust
let config = Config {
    disclose: Some(vec!["?name".to_string()]),
    ..Default::default()
};
```

**Example - Disclose nothing (existence proof only):**
```rust
let config = Config {
    disclose: Some(vec![]),
    ..Default::default()
};
```

---

## 5. Structural Disclosure Implications

### 5.1 Merkle Depth

`merkle_depth = 11` reveals: *Each dataset contains at most 2048 triples.*

### 5.2 Path Segment Max

`path_segment_max = 8` reveals: *Property paths traverse at most 8 hops.*

The actual path length taken is also disclosed for each path pattern.

### 5.3 Dataset Count

The number of distinct signed datasets is visible from the public key list.

---

## 6. Info Command

Use the `info` command to see what will be disclosed before generating a proof:

```bash
sparql-zk info --query query.rq
```

**Output:**
```
Query: SELECT ?name WHERE { ?person foaf:name ?name . ?person foaf:age ?age . FILTER(?age >= 18) }

Always Disclosed:
  - Query (shown above)
  - Public keys (at proof time)
  - Merkle depth: 11
  - Signature scheme: schnorr

Configurable:
  - Disclosed variables: ?name
  - Hidden variables: ?age, ?person
```

---

## References

- [W3C Verifiable Credentials Data Model](https://www.w3.org/TR/vc-data-model-2.0/)
