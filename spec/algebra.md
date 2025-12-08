# SPARQL to Noir Mapping

This document specifies how SPARQL query patterns are transformed into Noir circuit constraints.

## 1. Overview

A SPARQL SELECT query is transformed into a Noir circuit that:
1. Takes signed dataset roots and variable bindings as input
2. Verifies signatures on dataset roots
3. Verifies Merkle inclusion of triples matching the query pattern
4. Asserts variable binding consistency

---

## 2. Basic Graph Pattern (BGP)

### 2.1 Triple Pattern Mapping

Each triple pattern `(?s, ?p, ?o)` generates:

1. **Circuit input:** A `TripleInput` struct with encoded terms and Merkle path
2. **Inclusion assertion:** Verify the triple is in a signed dataset
3. **Binding assertions:** Link variables to their positions in the triple

**Example:**
```sparql
SELECT ?name WHERE { ?person foaf:name ?name }
```

**Generated Noir:**
```noir
// Input
bgp: [TripleInput; 1],
variables: Variables { person: Field, name: Field },

// Assertions
assert(verify_inclusion(bgp[0], root));
assert(variables.person == bgp[0].terms[0]);  // subject
assert(bgp[0].terms[1] == FOAF_NAME_ENCODED);  // predicate (constant)
assert(variables.name == bgp[0].terms[2]);     // object
```

### 2.2 Constants in Patterns

When a pattern position has a constant (IRI or literal), the circuit asserts equality with the pre-computed encoding:

```noir
// For pattern: ?s foaf:name "Alice"
assert(bgp[0].terms[1] == 0x...);  // foaf:name encoding
assert(bgp[0].terms[2] == 0x...);  // "Alice" encoding
```

---

## 3. JOIN

Multiple patterns in a WHERE clause create implicit JOINs.

**SPARQL:**
```sparql
SELECT ?name ?age WHERE {
    ?person foaf:name ?name .
    ?person foaf:age ?age .
}
```

**Mapping:**
- Two `TripleInput` entries
- Shared variable `?person` must match in both:

```noir
// Variable unification
assert(bgp[0].terms[0] == bgp[1].terms[0]);  // ?person in both
```

---

## 4. UNION

UNION creates disjunctive branches with indicator variables.

**SPARQL:**
```sparql
SELECT ?contact WHERE {
    { ?person foaf:mbox ?contact }
    UNION
    { ?person foaf:phone ?contact }
}
```

**Mapping:**
```noir
// Branch indicators (at least one must be true)
branch_1: bool,
branch_2: bool,

assert(branch_1 | branch_2);

// Branch 1 constraints (when active)
if branch_1 {
    assert(verify_inclusion(bgp_branch1[0], root));
    // ...
}

// Branch 2 constraints (when active)
if branch_2 {
    assert(verify_inclusion(bgp_branch2[0], root));
    // ...
}
```

---

## 5. OPTIONAL (LEFT JOIN)

Optional patterns may or may not match.

**SPARQL:**
```sparql
SELECT ?name ?email WHERE {
    ?person foaf:name ?name .
    OPTIONAL { ?person foaf:mbox ?email }
}
```

**Mapping:**
```noir
// Required pattern
assert(verify_inclusion(bgp[0], root));

// Optional pattern (conditional)
optional_matched: bool,

if optional_matched {
    assert(verify_inclusion(optional_bgp[0], root));
    assert(optional_bgp[0].terms[0] == bgp[0].terms[0]);  // ?person matches
}
```

**Metadata tracks which variables are optional:**
```json
{
  "optionalPatterns": [
    {"variables": ["email"], "triples": [...]}
  ]
}
```

---

## 6. FILTER

Filters add constraint assertions to the circuit.

### 6.1 Term Identity: `sameTerm`

`sameTerm(?x, ?y)` tests whether two RDF terms are **identical** (same lexical form, datatype, and language tag).

```sparql
FILTER(sameTerm(?x, ?y))
```

```noir
// Direct field comparison - terms must be identical
assert(variables.x == variables.y);
```

Since our encoding is deterministic, identical RDF terms produce identical Field values:
```
sameTerm(A, B) ↔ Enc_t(A) == Enc_t(B)
```

### 6.2 Value Equality: `=` (RDFterm-equal)

The `=` operator tests for **equivalent values**, not identical terms. Per [W3C SPARQL 1.1 §17.4.1.7](https://www.w3.org/TR/sparql11-query/#func-RDFterm-equal):

- Returns TRUE if terms have equivalent values
- Returns FALSE if terms have different values
- **Produces a type error** for literals with unsupported datatypes and different lexical forms

**Key difference from `sameTerm`:**
```sparql
# These are TRUE with = but FALSE with sameTerm:
FILTER("1"^^xsd:integer = "1.0"^^xsd:decimal)        # same numeric value
FILTER("2005-01-01T00:00:00Z"^^xsd:dateTime = 
       "2004-12-31T19:00:00-05:00"^^xsd:dateTime)    # same instant
```

**Current implementation (simplified):**

For the initial implementation, we support `=` only when it can be reduced to term identity:

```noir
// When both operands have known types that can be compared
// via their encoded representations:
assert(variables.x == variables.y);
```

**Full implementation requirements:**

A complete implementation of `=` requires:

1. **Type-specific comparison functions:**
   ```noir
   fn numeric_equal(a: NumericEncoding, b: NumericEncoding) -> bool
   fn datetime_equal(a: DateTimeEncoding, b: DateTimeEncoding) -> bool
   ```

2. **Type detection at circuit generation time:**
   - If types are known and comparable → emit type-specific comparison
   - If types are identical → fallback to term identity
   - If types are unknown/unsupported → emit error or conservative failure

3. **Witness for type information:**
   ```noir
   // Hidden inputs for type-aware equality
   a_type: u8,  // 0=IRI, 1=blank, 2=literal
   a_datatype: Field,  // for literals
   ```

### 6.3 Comparison with Constant

```sparql
FILTER(?name = "Alice")
```

```noir
assert(variables.name == ALICE_ENCODED);
```

When comparing with a constant, we know the type at circuit generation time, so we can apply the appropriate comparison.

### 6.4 Numeric Comparisons

```sparql
FILTER(?age >= 18)
```

Numeric comparisons use the `special_encoding` field from the literal encoding, which preserves numeric value:

```noir
// The literal encoding contains the numeric value in special_encoding
// For xsd:integer, special_encoding = numeric_value
assert(age_value >= 18);
```

**Note:** This requires hidden inputs to provide the unpacked numeric value and assertions to verify the unpacking is correct relative to the encoded term.

### 6.5 Logical Operators

```sparql
FILTER(?a && ?b)
FILTER(?a || ?b)
FILTER(!?a)
```

```noir
assert(constraint_a & constraint_b);
assert(constraint_a | constraint_b);
assert(!constraint_a);
```

### 6.6 Type Testing Functions

```sparql
FILTER(isIRI(?x))
FILTER(isBlank(?x))
FILTER(isLiteral(?x))
```

These require hidden type information:

```noir
// Hidden input provides type code
x_type: u8,

// Verify type matches the encoded term
assert(verify_type_encoding(variables.x, x_type));

// Then test
assert(x_type == 0);  // isIRI: type code 0
```

See [W3C reference](./w3c/sparql11-query-reference.md) for detailed semantics.

---

## 7. BIND / EXTEND

BIND introduces computed variables.

**SPARQL:**
```sparql
SELECT ?fullName WHERE {
    ?person foaf:firstName ?first .
    ?person foaf:lastName ?last .
    BIND(CONCAT(?first, " ", ?last) AS ?fullName)
}
```

**Mapping:** BIND expressions are computed outside the circuit; the result is provided as a witness and verified if needed.

---

## 8. Property Paths

Property paths are expanded to bounded BGP sequences.

### 8.1 Expansion

| Path | Expansion (max depth 8) |
|------|-------------------------|
| `p+` | `p`, `p/p`, `p/p/p`, ... |
| `p*` | `ε`, `p`, `p/p`, ... |
| `p?` | `ε`, `p` |
| `p1/p2` | Sequence |
| `p1\|p2` | Alternative (UNION) |
| `^p` | Reverse direction |

### 8.2 Example

```sparql
SELECT ?ancestor WHERE { ?person foaf:knows+ ?ancestor }
```

**Expands to UNION of:**
```
?person foaf:knows ?ancestor .

?person foaf:knows ?v1 . ?v1 foaf:knows ?ancestor .

?person foaf:knows ?v1 . ?v1 foaf:knows ?v2 . ?v2 foaf:knows ?ancestor .
...
```

**Note:** The actual path length taken is disclosed.

---

## 9. Generated Circuit Structure

### 9.1 Main Function

```noir
fn main(
    // Public inputs
    public_keys: [PubKey; N_DATASETS],
    
    // Private inputs (witness)
    roots: [Root; N_DATASETS],
    bgp: [TripleInput; N_PATTERNS],
    variables: Variables,
) {
    // 1. Verify signatures
    for i in 0..N_DATASETS {
        assert(verify_signature(public_keys[i], roots[i].signature, roots[i].value));
    }
    
    // 2. Verify triple inclusions
    for i in 0..N_PATTERNS {
        assert(verify_inclusion(bgp[i], roots[pattern_to_dataset[i]].value));
    }
    
    // 3. Assert variable bindings
    // (generated based on query)
    
    // 4. Assert filter constraints
    // (generated based on query)
}
```

### 9.2 Metadata Output

The transformation produces metadata alongside the circuit:

```json
{
  "variables": ["?person", "?name"],
  "inputPatterns": [
    {"subject": "?person", "predicate": "foaf:name", "object": "?name"}
  ],
  "optionalPatterns": [],
  "unionBranches": null,
  "pathPlans": []
}
```

---

## 10. Supported SPARQL Features

| Feature | Status | Notes |
|---------|--------|-------|
| SELECT | ✅ | Projected variables |
| BGP | ✅ | Basic patterns |
| JOIN | ✅ | Multiple patterns |
| UNION | ✅ | Disjunctive branches |
| OPTIONAL | ✅ | Conditional matching |
| FILTER | ✅ | Equality, comparison, logical |
| BIND | ✅ | Computed variables |
| Property Paths | ✅ | Bounded expansion |
| DISTINCT | ⚠️ | Post-processing |
| LIMIT | ⚠️ | Post-processing |
| ORDER BY | ❌ | Not supported |
| GROUP BY | ❌ | Deferred |
| HAVING | ❌ | Deferred |
| Aggregates | ❌ | Deferred |

---

## References

- [SPARQL 1.1 Query Language](https://www.w3.org/TR/sparql11-query/) - Full W3C specification
- [W3C Reference Excerpts](./w3c/sparql11-query-reference.md) - Key sections on `=` vs `sameTerm`
- [XPath Functions and Operators](https://www.w3.org/TR/xpath-functions/) - Operator semantics
