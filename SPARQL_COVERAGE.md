# SPARQL Feature Coverage Report

**Generated:** 2025-12-09  
**Test Suite:** sparql_noir Rust Transform  
**Pass Rate:** 51.2% (22/43 test queries)

## Summary

The sparql_noir project generates ZK proofs that SPARQL query results are correct, without revealing the underlying signed RDF datasets. This document reports the SPARQL features supported by the Rust transform component.

> **Note:** Some features require query preprocessing before circuit generation. See [spec/preprocessing.md](./spec/preprocessing.md) for details.

## Feature Support Matrix

| Feature | Status | Notes |
|---------|--------|-------|
| **Basic Graph Pattern (BGP)** | ✅ Full | Core triple pattern matching |
| **Multiple Triple Patterns (JOIN)** | ✅ Full | Implicit joins via shared variables |
| **UNION** | ✅ Full | Disjunctive pattern matching |
| **OPTIONAL** | ✅ Full | Left outer joins |
| **FILTER (equality)** | ✅ Full | `?x = value`, `?x = ?y`, `?x != value` |
| **FILTER (comparison)** | ✅ Full | `>`, `>=`, `<`, `<=`, `&&`, `\|\|` |
| **FILTER (functions)** | ✅ Full | `isURI()`, `BOUND()`, `STRLEN()` |
| **Property Paths (alternative \|)** | ✅ Full | `p1\|p2` |
| **Property Paths (inverse ^)** | ✅ Full | `^p` |
| **Property Paths (optional ?)** | ✅ Full | `p?` (zero or one) |
| **Property Paths (sequence /)** | 🔄 Preprocess | Requires expansion to JOIN (see preprocessing.md) |
| **Property Paths (one or more +)** | 🔄 Preprocess | Requires expansion to bounded UNION |
| **Property Paths (zero or more *)** | 🔄 Preprocess | Requires expansion to bounded UNION |
| **BIND** | ❌ Not Working | Needs implementation for non-trivial expressions |
| **DISTINCT** | ❌ Not Working | Needs top-level handling |
| **ORDER BY** | ❌ Not Supported | Post-process only |
| **LIMIT/OFFSET** | ❌ Not Working | Needs top-level handling |
| **ASK** | ❌ Not Working | Needs top-level handling |
| **SELECT** | ✅ Full | Variable projection |
| **IN/NOT IN** | 🔄 Preprocess | Expand to disjunction of equalities |
| **GROUP BY** | ❌ Not Supported | Out of scope for ZK circuits |
| **HAVING** | ❌ Not Supported | Out of scope |
| **Aggregates (COUNT, SUM, etc.)** | ❌ Not Supported | Out of scope |
| **Subqueries** | ❌ Not Supported | Out of scope |
| **VALUES** | 🔄 Preprocess | Expand to UNION |
| **SERVICE** | ❌ Not Supported | Federated queries not applicable |
| **MINUS** | ❌ Not Supported | Out of scope |
| **EXISTS/NOT EXISTS** | ❌ Not Supported | Out of scope |
| **CONSTRUCT** | ❌ Not Supported | Different query type |
| **DESCRIBE** | ⚠️ Partial | Parses but may not generate correct circuit |

## Legend

- ✅ **Full**: Feature is fully supported
- ⚠️ **Partial**: Feature has limited support
- 🔄 **Preprocess**: Feature can be supported via query preprocessing
- ❌ **Not Working**: Feature needs implementation
- ❌ **Not Supported**: Feature is out of scope for ZK proof system

## Test Results by Category

### Fully Supported (10 features)
- Basic Graph Pattern (BGP): 3/3 ✓
- Multiple Triple Patterns: 2/2 ✓
- UNION: 2/2 ✓
- OPTIONAL: 2/2 ✓
- FILTER (equality): 3/3 ✓
- FILTER (comparison): 3/3 ✓
- FILTER (functions): 3/3 ✓ (isURI, BOUND, STRLEN)
- Property Paths (alternative |): 1/1 ✓
- Property Paths (inverse ^): 1/1 ✓
- Property Paths (optional ?): 1/1 ✓

### Not Working (8 features)
- BIND: 0/2 ✗
- Property Paths (sequence /): 0/2 ✗ (requires preprocessing)
- Property Paths (one or more +): 0/1 ✗ (requires preprocessing)
- Property Paths (zero or more *): 0/1 ✗ (requires preprocessing)
- DISTINCT: 0/1 ✗
- ORDER BY: 0/2 ✗
- LIMIT/OFFSET: 0/2 ✗
- ASK: 0/1 ✗

## Preprocessing Requirements

Some SPARQL features require query transformation before circuit generation. See [spec/preprocessing.md](./spec/preprocessing.md) for the full specification.

### Features Requiring Preprocessing

| Feature | Transform | Target |
|---------|-----------|--------|
| Property path `/` | Expand to JOIN with intermediate variables | BGP + JOIN |
| Property path `+` | Expand to bounded UNION (max 8 hops) | UNION of BGPs |
| Property path `*` | Expand to bounded UNION including identity | UNION of BGPs |
| `IN(x, [a,b,c])` | Expand to `x=a \|\| x=b \|\| x=c` | FILTER disjunction |
| `NOT IN(...)` | Expand to negated disjunction | FILTER |
| `VALUES` | Expand to UNION | UNION |
| `isLiteral(x)` | Transform to `!(isIRI(x) \|\| isBlank(x))` | FILTER |

### Example: Sequence Path Preprocessing

**Before (not accepted):**
```sparql
SELECT ?x ?z WHERE { ?x ex:knows/ex:knows ?z }
```

**After preprocessing (accepted):**
```sparql
SELECT ?x ?z WHERE { 
  ?x ex:knows ?_v0 . 
  ?_v0 ex:knows ?z .
}
```

## Implementation Notes

### ZK Circuit Constraints

Some SPARQL features are not suitable for ZK circuit generation:
- **Aggregates**: Would require proving arithmetic over unknown-size result sets
- **Subqueries**: Would require nested proofs or variable-depth circuits
- **MINUS/EXISTS**: Require proving negation which is complex in ZK

### Post-Processing Features

Some features can be handled outside the ZK circuit:
- **DISTINCT**: Can be enforced by the verifier checking uniqueness
- **ORDER BY**: Can be sorted after proof verification
- **LIMIT/OFFSET**: Can be applied to verified results

### Property Paths

The Rust transform supports some property path features directly:
- **Supported directly**: Alternative (`|`), inverse (`^`), optional (`?`)
- **Require preprocessing**: Sequence (`/`), plus (`+`), star (`*`)

Complex path operators must be preprocessed into equivalent BGP/JOIN/UNION patterns before circuit generation. This is because ZK circuits require fixed structure, and these paths can match variable-length chains.

See [spec/preprocessing.md](./spec/preprocessing.md) for transformation rules.

## Running Tests

```bash
# Run SPARQL parsing tests
npm run test:parsing

# Show feature summary
npm run test:sparql:features

# Run E2E tests (full proof generation)
npm run e2e
```

## Next Steps

Priority features to implement:
1. **Query preprocessor**: Implement preprocessing transforms (see spec/preprocessing.md)
2. **ASK queries**: Simple to add, just different result type
3. **DISTINCT/LIMIT**: Add top-level operation handling
4. **BIND**: Support for simple variable aliasing

## W3C Test Suite Compatibility

This report is based on manual testing against representative queries. For full W3C SPARQL 1.1 test suite compatibility:

```bash
# Run against W3C test suite (syntax tests only)
npx rdf-test-suite ./dist/test/sparql-engine.js \
  https://w3c.github.io/rdf-tests/sparql/sparql11/manifest-all.ttl \
  -c .rdf-test-suite-cache -e -t syntax
```

Note: Full query evaluation tests are not applicable since sparql_noir is a ZK proof system, not a query engine. The correct results must be known by the prover ahead of time.
