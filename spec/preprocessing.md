# Query Preprocessing Specification

This document specifies the transformations that MUST be applied to a SPARQL query before circuit generation. The circuit generator expects queries in a specific normalized form.

## 1. Overview

The circuit generator (Rust transform) accepts a subset of SPARQL algebra. Queries using features outside this subset MUST be preprocessed into an equivalent form that the generator can handle.

**Processing Pipeline:**
```
SPARQL Query → Parse → Preprocess → Generate Circuit → Compile → Prove
                        ↓
              1. Property path expansion
              2. Operator equivalence transforms
              3. Expression simplification
              4. Boolean constraint optimization
```

---

## 2. Generator Input Requirements

### 2.1 Accepted Top-Level Operations

The generator accepts **only** the following at the query top-level:

| Operation | Status | Notes |
|-----------|--------|-------|
| `PROJECT` | ✅ Required | Must wrap all queries |
| `SLICE` | ✅ Accepted | LIMIT/OFFSET (metadata only) |
| `DISTINCT` | ✅ Accepted | Metadata flag |
| `ORDER BY` | ❌ Rejected | Not supported |
| `GROUP BY` | ❌ Rejected | Not supported |
| Raw patterns | ❌ Rejected | Must be wrapped in PROJECT |

### 2.2 Accepted Pattern Operations

Within a PROJECT, the generator accepts:

| Operation | Status | Notes |
|-----------|--------|-------|
| `BGP` | ✅ | Basic graph patterns |
| `JOIN` | ✅ | Implicit or explicit joins |
| `UNION` | ✅ | Disjunctive patterns |
| `OPTIONAL` (LEFT JOIN) | ✅ | Conditional patterns |
| `FILTER` | ✅ | Constraint expressions |
| `EXTEND` (BIND) | ✅ | Variable binding |
| `GRAPH` | ✅ | Named graph patterns |
| `PATH` | ⚠️ | Only after expansion (see §3) |

### 2.3 Rejected Operations (Require Preprocessing)

The generator **rejects** these operations directly:

| Operation | Rejection Reason | Required Transform |
|-----------|------------------|-------------------|
| Property path (/, +, *) | Complex paths | Expand to BGP/JOIN/UNION |
| `SERVICE` | Federated query | Not supported |
| `MINUS` | Negation | Not supported |
| `VALUES` | Inline data | Expand to UNION |
| Subqueries | Nested SELECT | Flatten if possible |
| Aggregates | GROUP/COUNT/etc | Not supported |

---

## 3. Property Path Preprocessing

### 3.1 Principle

**The generator should NOT accept raw property path expressions like `/`, `+`, or `*`.**

Property paths MUST be transformed into equivalent BGP/JOIN/UNION patterns before circuit generation. This ensures the circuit structure is deterministic and bounded.

### 3.2 Path Transformation Rules

| Path Expression | Transform To | Notes |
|-----------------|--------------|-------|
| `p` (link) | `BGP(?s p ?o)` | Single triple pattern |
| `^p` (inverse) | `BGP(?o p ?s)` | Swap subject/object |
| `p1/p2` (sequence) | `JOIN(BGP(?s p1 ?v), BGP(?v p2 ?o))` | Intermediate variable |
| `p1\|p2` (alternative) | `UNION(PATH(?s p1 ?o), PATH(?s p2 ?o))` | Disjunction |
| `p?` (zero-or-one) | `OPTIONAL + EXTEND` | Complex (see §3.3) |
| `p+` (one-or-more) | `UNION` of bounded lengths | Expand to max depth |
| `p*` (zero-or-more) | `UNION` of bounded lengths | Expand to max depth |
| `!p` (negated set) | Not supported | Requires enumeration |

### 3.3 Detailed Path Transformations

#### 3.3.1 Sequence Path (`p1/p2`)

**Input:**
```sparql
?s p1/p2 ?o
```

**Output:**
```sparql
?s p1 ?_v0 .
?_v0 p2 ?o .
```

For longer sequences (`p1/p2/p3`), create chained intermediate variables:
```sparql
?s p1 ?_v0 .
?_v0 p2 ?_v1 .
?_v1 p3 ?o .
```

#### 3.3.2 Alternative Path (`p1|p2`)

**Input:**
```sparql
?s p1|p2 ?o
```

**Output:**
```sparql
{ ?s p1 ?o } UNION { ?s p2 ?o }
```

#### 3.3.3 Zero-or-One Path (`p?`)

**Input:**
```sparql
?s p? ?o
```

**Output (using EXTEND for identity case):**
```sparql
{
  BIND(?s AS ?o)  # Zero-length: subject equals object
}
UNION
{
  ?s p ?o         # One-length: actual edge
}
```

Alternatively, use OPTIONAL:
```
OPTIONAL { ?s p ?_pathMatch }
BIND(IF(BOUND(?_pathMatch), ?_pathMatch, ?s) AS ?o)
```

#### 3.3.4 One-or-More Path (`p+`)

**Input:**
```sparql
?s p+ ?o
```

**Output (bounded to MAX_DEPTH=8):**
```sparql
{
  ?s p ?o .                                    # length 1
}
UNION
{
  ?s p ?_v0 . ?_v0 p ?o .                      # length 2
}
UNION
{
  ?s p ?_v0 . ?_v0 p ?_v1 . ?_v1 p ?o .        # length 3
}
UNION
... up to MAX_DEPTH
```

#### 3.3.5 Zero-or-More Path (`p*`)

**Input:**
```sparql
?s p* ?o
```

**Output (bounded):**
```sparql
{
  BIND(?s AS ?o)                               # length 0
}
UNION
{
  ?s p ?o .                                    # length 1
}
UNION
{
  ?s p ?_v0 . ?_v0 p ?o .                      # length 2
}
UNION
... up to MAX_DEPTH
```

### 3.4 Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `PATH_SEGMENT_MAX` | 8 | Maximum path length for `+`/`*` expansion |

**Note:** The actual path length taken is disclosed in the proof (see `spec/disclosure.md`).

---

## 4. Operator Equivalence Transforms

Certain SPARQL operators should be transformed to equivalent forms that the generator handles more efficiently.

### 4.1 IN and NOT IN

**Transform `IN` to disjunction:**
```sparql
FILTER(?x IN (a, b, c))
```
→
```sparql
FILTER(?x = a || ?x = b || ?x = c)
```

**Transform `NOT IN` to negated disjunction:**
```sparql
FILTER(?x NOT IN (a, b, c))
```
→
```sparql
FILTER(!(?x = a || ?x = b || ?x = c))
```

### 4.2 Type Testing Functions

**Transform `isLiteral` using De Morgan:**
```sparql
FILTER(isLiteral(?x))
```
→
```sparql
FILTER(!(isIRI(?x) || isBlank(?x)))
```

This is semantically equivalent for bound terms.

### 4.3 Comparison Direction

**Transform `<` to `>` with swapped arguments:**
```sparql
FILTER(?a < ?b)
```
→
```sparql
FILTER(?b > ?a)
```

This normalization reduces the number of comparison operators the generator must handle.

### 4.4 Numeric Type Coercion

Numeric literals with different types should be normalized:
```sparql
FILTER(?x = "1"^^xsd:integer)
FILTER(?x = "1.0"^^xsd:decimal)
FILTER(?x = "1.0e0"^^xsd:double)
```

These may all represent the same numeric value. Preprocessing can normalize to a canonical form.

---

## 5. Expression Simplification

### 5.1 Constant Folding

Evaluate constant expressions at preprocessing time:

```sparql
FILTER(1 + 1 = 2)        # → FILTER(true)
FILTER("a" = "b")        # → FILTER(false)
BIND(2 * 3 AS ?x)        # → BIND(6 AS ?x)
```

### 5.2 Boolean Simplification

Apply boolean algebra to simplify filter expressions:

```sparql
FILTER(?a && true)       # → FILTER(?a)
FILTER(?a || false)      # → FILTER(?a)
FILTER(!(!?a))           # → FILTER(?a)
FILTER(?a && ?a)         # → FILTER(?a)
FILTER(?a || ?a)         # → FILTER(?a)
FILTER(?a && false)      # → Remove pattern (unsatisfiable)
FILTER(?a || true)       # → Remove filter (tautology)
```

### 5.3 Constraint Optimization

For circuits, boolean constraints can be optimized using libraries like `@fordi-org/bsimp`:

1. Convert constraints to boolean expressions
2. Apply simplification rules
3. Convert back to constraint format

This reduces circuit size and proof generation time.

---

## 6. VALUES Expansion

The `VALUES` clause should be expanded to UNION:

**Input:**
```sparql
SELECT ?name WHERE {
  VALUES ?type { foaf:Person schema:Person }
  ?x a ?type .
  ?x foaf:name ?name .
}
```

**Output:**
```sparql
SELECT ?name WHERE {
  {
    ?x a foaf:Person .
    ?x foaf:name ?name .
  }
  UNION
  {
    ?x a schema:Person .
    ?x foaf:name ?name .
  }
}
```

---

## 7. Preprocessing Implementation

### 7.1 Recommended Approach

Use a SPARQL algebra manipulation library:
- **TypeScript:** `sparqlalgebrajs` - Parse, transform, serialize
- **Rust:** `spargebra` + custom transforms

### 7.2 Transform Order

Apply transforms in this order:

1. **Property path expansion** - Convert paths to BGP/JOIN/UNION
2. **VALUES expansion** - Convert to UNION
3. **Operator equivalence** - Normalize operators
4. **Expression simplification** - Fold constants, simplify booleans
5. **Constraint optimization** - Reduce boolean complexity

### 7.3 Example Implementation (TypeScript)

```typescript
import { Algebra, Factory, Util } from 'sparqlalgebrajs';

const factory = new Factory();

function preprocess(query: Algebra.Operation): Algebra.Operation {
  return Util.mapOperation(query, {
    // Expand property paths
    [Algebra.types.PATH]: (op: Algebra.Path) => {
      return pathToBgp(op.subject, op.path, op.object);
    },
    // Transform IN to disjunction
    [Algebra.types.EXPRESSION]: (op: Algebra.Expression) => {
      if (op.expressionType === 'operator' && op.operator === 'in') {
        return expandIn(op);
      }
      return op;
    },
  });
}

function pathToBgp(
  subject: RDF.Term,
  path: Algebra.PropertyPathSymbol,
  object: RDF.Term
): Algebra.Operation {
  switch (path.type) {
    case Algebra.types.LINK:
      return factory.createBgp([factory.createPattern(subject, path.iri, object)]);
    case Algebra.types.INV:
      return pathToBgp(object, path.path, subject);
    case Algebra.types.SEQ:
      const intermediate = factory.createTerm(`_:v${nextVar++}`);
      return factory.createJoin([
        pathToBgp(subject, path.input[0], intermediate),
        pathToBgp(intermediate, path.input[1], object),
      ]);
    // ... other path types
  }
}
```

---

## 8. Generator Behavior

When the generator encounters unsupported operations:

| Scenario | Behavior |
|----------|----------|
| Raw property path (`/`, `+`, `*`) | Error: "Property paths must be preprocessed" |
| `SERVICE` | Error: "SERVICE not supported" |
| `MINUS` | Error: "MINUS not supported" |
| `VALUES` | Error: "VALUES must be expanded to UNION" |
| Subquery | Error: "Subqueries must be flattened" |
| Aggregates | Error: "Aggregates not supported" |

The generator provides clear error messages directing users to apply preprocessing.

---

## 9. Summary

### What the Generator Accepts

- `PROJECT` (required top-level)
- `BGP`, `JOIN`, `UNION`, `OPTIONAL`, `FILTER`, `EXTEND`, `GRAPH`
- Simple property paths (`p`, `^p`) that can be trivially converted
- `p?` (zero-or-one) with special handling

### What Must Be Preprocessed

- Sequence paths (`p1/p2`) → JOIN with intermediate variables
- Repetition paths (`p+`, `p*`) → UNION of bounded expansions
- Alternative paths (`p1|p2`) → UNION
- `IN`/`NOT IN` → Disjunction/negated disjunction
- `VALUES` → UNION
- Complex expressions → Simplified form

### Configuration Defaults

| Parameter | Default |
|-----------|---------|
| `PATH_SEGMENT_MAX` | 8 |
| Expression simplification | Enabled |
| Boolean optimization | Enabled |

---

## References

- [SPARQL 1.1 Property Paths](https://www.w3.org/TR/sparql11-query/#propertypaths)
- [SPARQL Algebra](https://www.w3.org/TR/sparql11-query/#sparqlAlgebra)
- [sparqlalgebrajs](https://github.com/comunica/sparqlalgebrajs) - TypeScript algebra library
- [noir-sparql-proof](https://github.com/jeswr/noir-sparql-proof) - Reference implementation
