# SPARQL Algebra Specification

This document specifies the extended SPARQL algebra semantics for zero-knowledge proof generation. It defines how SPARQL query evaluation is augmented to track term occurrences, enabling proof construction.

## 1. Preliminaries

### 1.1 Standard SPARQL Algebra

Following [SPARQL 1.1 Query Language](https://www.w3.org/TR/sparql11-query/), the SPARQL algebra consists of:

| Operation | Notation | Description |
|-----------|----------|-------------|
| BGP | $\text{BGP}(P)$ | Basic Graph Pattern |
| Join | $P_1 \bowtie P_2$ | Natural join |
| Union | $P_1 \cup P_2$ | Disjunction |
| LeftJoin | $P_1 \mathbin{\text{⟕}} P_2$ | Optional pattern |
| Filter | $\sigma_F(P)$ | Constraint filter |
| Extend | $\rho_{v \leftarrow e}(P)$ | Variable binding |
| Project | $\pi_V(P)$ | Variable projection |

### 1.2 Solution Mapping

A **solution mapping** $\mu$ is a partial function:
$$
\mu : V \rightharpoonup T
$$

Where $V$ is the set of variables and $T = U \cup B \cup L$ is the set of RDF terms.

**Domain:** $\text{dom}(\mu) = \{v \in V \mid \mu(v) \text{ is defined}\}$

**Compatibility:** Two mappings $\mu_1$ and $\mu_2$ are compatible ($\mu_1 \sim \mu_2$) iff:
$$
\forall v \in \text{dom}(\mu_1) \cap \text{dom}(\mu_2) : \mu_1(v) = \mu_2(v)
$$

---

## 2. Extended Solution Mapping

### 2.1 Indexed Solution Mapping

For ZK proof generation, we extend solution mappings to track *where* each binding originated in the dataset.

**Definition (Indexed Solution Mapping):**

An indexed solution mapping $\mu^+$ is a function:
$$
\mu^+ : V \rightharpoonup (T \times \mathcal{P}(\mathcal{O}))
$$

Where $\mathcal{O} = (U \cup B) \times \mathbb{N} \times \mathbb{N}$ is the set of **occurrence indices**.

An occurrence index $(g, i, j)$ represents:
- $g$: Graph identifier (IRI or blank node for named graphs, $\bot$ for default)
- $i$: Triple index within the graph
- $j$: Position within the triple (0=subject, 1=predicate, 2=object)

### 2.2 Projection Functions

For an indexed solution mapping $\mu^+$:

$$
\text{term}(\mu^+(v)) = t \quad \text{where } \mu^+(v) = (t, O)
$$

$$
\text{occ}(\mu^+(v)) = O \quad \text{where } \mu^+(v) = (t, O)
$$

### 2.3 Standard Mapping Extraction

The underlying standard solution mapping:
$$
\text{std}(\mu^+)(v) = \text{term}(\mu^+(v))
$$

---

## 3. Extended Evaluation Semantics

### 3.1 Notation

Let $D$ be an RDF dataset with default graph $G_0$ and named graphs $\{(g_i, G_i)\}$.

The extended evaluation function:
$$
\text{eval}^+ : \text{Pattern} \times \text{Dataset} \to \mathcal{P}(\text{IndexedSolutionMapping})
$$

### 3.2 Basic Graph Pattern (BGP)

For a BGP consisting of triple patterns $\{tp_1, \ldots, tp_n\}$:

$$
\text{eval}^+(\text{BGP}(\{tp_1, \ldots, tp_n\}), D) = \bigcup_{(G, g) \in D} \text{eval}^+_G(\{tp_1, \ldots, tp_n\}, g)
$$

**Single Triple Pattern:**

For triple pattern $tp = (s, p, o)$ evaluated against graph $G$ with identifier $g$:

$$
\text{eval}^+_G(tp, g) = \{\ \mu^+ \mid \exists (s', p', o') \in G, i \in \mathbb{N} :
$$
$$
\quad \mu^+ \text{ maps each variable in } tp \text{ to matching term with occurrence } (g, i, pos)\ \}
$$

Where $pos \in \{0, 1, 2\}$ corresponds to subject, predicate, object positions.

### 3.3 Join

$$
\text{eval}^+(P_1 \bowtie P_2, D) = \{\ \mu^+_1 \bowtie^+ \mu^+_2 \mid
$$
$$
\quad \mu^+_1 \in \text{eval}^+(P_1, D), \mu^+_2 \in \text{eval}^+(P_2, D), \text{std}(\mu^+_1) \sim \text{std}(\mu^+_2)\ \}
$$

**Indexed Join Operation:**

For compatible $\mu^+_1, \mu^+_2$:

$$
(\mu^+_1 \bowtie^+ \mu^+_2)(v) = \begin{cases}
(\text{term}(\mu^+_1(v)), \text{occ}(\mu^+_1(v)) \cup \text{occ}(\mu^+_2(v))) & \text{if } v \in \text{dom}(\mu^+_1) \cap \text{dom}(\mu^+_2) \\
\mu^+_1(v) & \text{if } v \in \text{dom}(\mu^+_1) \setminus \text{dom}(\mu^+_2) \\
\mu^+_2(v) & \text{if } v \in \text{dom}(\mu^+_2) \setminus \text{dom}(\mu^+_1)
\end{cases}
$$

### 3.4 Union

$$
\text{eval}^+(P_1 \cup P_2, D) = \text{eval}^+(P_1, D) \cup \text{eval}^+(P_2, D)
$$

Union preserves occurrence indices from whichever branch produced the binding.

### 3.5 Left Join (Optional)

$$
\text{eval}^+(P_1 \mathbin{\text{⟕}} P_2, D) = (\text{eval}^+(P_1, D) \bowtie^+ \text{eval}^+(P_2, D)) \cup
$$
$$
\quad \{\ \mu^+_1 \mid \mu^+_1 \in \text{eval}^+(P_1, D), \nexists \mu^+_2 \in \text{eval}^+(P_2, D) : \text{std}(\mu^+_1) \sim \text{std}(\mu^+_2)\ \}
$$

**Note:** The second set contains mappings where the optional pattern did not match. These have empty occurrence sets for optional variables.

### 3.6 Filter

$$
\text{eval}^+(\sigma_F(P), D) = \{\ \mu^+ \in \text{eval}^+(P, D) \mid F(\text{std}(\mu^+)) = \text{true}\ \}
$$

Filter evaluation uses the standard mapping; occurrence indices are preserved unchanged.

### 3.7 Extend (BIND)

$$
\text{eval}^+(\rho_{v \leftarrow e}(P), D) = \{\ \mu^+[v \mapsto (e(\text{std}(\mu^+)), \emptyset)] \mid \mu^+ \in \text{eval}^+(P, D)\ \}
$$

Extended variables have empty occurrence sets (they are computed, not sourced from data).

### 3.8 Project

$$
\text{eval}^+(\pi_V(P), D) = \{\ \mu^+|_V \mid \mu^+ \in \text{eval}^+(P, D)\ \}
$$

Where $\mu^+|_V$ restricts $\mu^+$ to variables in $V$.

---

## 4. Property Path Handling

### 4.1 Path Expressions

Property paths extend BGPs with navigational patterns:

| Path | Notation | Meaning |
|------|----------|---------|
| IRI | $p$ | Single predicate |
| Inverse | $\hat{p}$ | Reverse direction |
| Sequence | $p_1 / p_2$ | Concatenation |
| Alternative | $p_1 \mid p_2$ | Disjunction |
| Zero-or-one | $p?$ | Optional |
| Zero-or-more | $p*$ | Kleene star |
| One-or-more | $p+$ | Kleene plus |
| Negated | $!(p_1 \mid \ldots \mid p_n)$ | Negated property set |

### 4.2 Bounded Path Expansion

For ZK circuits, unbounded paths must be bounded. We define:

$$
\text{PATH\_SEGMENT\_MAX} = 8
$$

**Expansion Rules:**

$$
\text{expand}(p*) = \epsilon \mid p \mid p/p \mid \ldots \mid \underbrace{p/\ldots/p}_{\text{PATH\_SEGMENT\_MAX}}
$$

$$
\text{expand}(p+) = p \mid p/p \mid \ldots \mid \underbrace{p/\ldots/p}_{\text{PATH\_SEGMENT\_MAX}}
$$

### 4.3 Path to BGP Conversion

Each expanded path becomes a sequence of BGPs joined with intermediate variables:

For path $s\ p_1/p_2/\ldots/p_n\ o$:

$$
\text{BGP}(\{(s, p_1, \_\_v_1), (\_\_v_1, p_2, \_\_v_2), \ldots, (\_\_v_{n-1}, p_n, o)\})
$$

Where $\_\_v_i$ are fresh intermediate variables.

### 4.4 Path Occurrence Tracking

For path evaluation, occurrences include all triples traversed:

$$
\text{occ}(\mu^+(s)) = \bigcup_{i=1}^{n} \{(g, idx_i, 0)\}
$$
$$
\text{occ}(\mu^+(o)) = \bigcup_{i=1}^{n} \{(g, idx_i, 2)\}
$$

**Disclosure:** The actual path length taken (≤ PATH_SEGMENT_MAX) is disclosed.

---

## 5. Filter Expression Handling

### 5.1 Supported Filter Operations

| Category | Operations |
|----------|------------|
| **Comparison** | `=`, `!=`, `<`, `>`, `<=`, `>=` |
| **Logical** | `&&`, `||`, `!` |
| **Term Testing** | `sameTerm`, `bound`, `isIRI`, `isBlank`, `isLiteral` |
| **String** | `str`, `strlen`, `contains`, `strstarts`, `strends` |
| **Numeric** | `+`, `-`, `*`, `/`, `abs`, `round`, `ceil`, `floor` |

### 5.2 In-Circuit Filter Assertions

Filters translate to circuit assertions:

| Filter | Circuit Constraint |
|--------|-------------------|
| `sameTerm(?x, ?y)` | `assert_eq(enc(μ(?x)), enc(μ(?y)))` |
| `?x = literal` | `assert_eq(enc(μ(?x)), enc(literal))` |
| `?x < ?y` | Hidden inputs with bounds assertions |
| `f1 && f2` | Both constraints |
| `f1 || f2` | Branch indicator variables |

### 5.3 Numeric Bounds (Hidden Inputs)

For numeric comparisons that should not disclose exact values:

**Proof of Numeric Bound (PoNB):**

To prove $a \leq x \leq b$ without disclosing $x$:

1. Hidden inputs: $x$, $a$, $b$ (bounds may be public or hidden)
2. Circuit assertions:
   - `assert(a <= x)`
   - `assert(x <= b)`
3. Public output: bounds $a$, $b$ (if disclosed)

---

## 6. Union Branch Handling

### 6.1 Branch Indicator Variables

For $P_1 \cup P_2$, introduce branch indicators:

$$
b_1, b_2 \in \{0, 1\} \quad \text{with} \quad b_1 \lor b_2 = 1
$$

### 6.2 Disjunctive Constraints

$$
(b_1 \land C_1) \lor (b_2 \land C_2)
$$

Where $C_i$ are the constraints from branch $i$.

### 6.3 Multi-Branch Extension

For $P_1 \cup P_2 \cup \ldots \cup P_n$:

$$
\bigvee_{i=1}^{n} (b_i \land C_i) \quad \text{with} \quad \bigvee_{i=1}^{n} b_i = 1
$$

---

## 7. Optional Pattern Handling

### 7.1 Nullable Bindings

For $P_1 \mathbin{\text{⟕}} P_2$:

Variables from $P_2$ may be unbound. In the circuit:

```
struct OptionalBinding {
    is_bound: bool,
    value: Field,
}
```

### 7.2 Optional Constraints

Constraints from optional patterns are conditional:

$$
\text{is\_bound}(v) \implies C_v
$$

Where $C_v$ are constraints involving variable $v$ from the optional pattern.

### 7.3 Metadata Tracking

Optional patterns are tracked in circuit metadata:

```json
{
  "optionalPatterns": [
    {"variables": ["?x", "?y"], "triples": [...]}
  ]
}
```

---

## 8. Query Analysis for Proof Requirements

### 8.1 Analysis Output

Given a SPARQL query $Q$, query analysis produces:

```
struct QueryAnalysis {
    input_patterns: Vec<TriplePattern>,     // Required BGP triples
    optional_patterns: Vec<TriplePattern>,  // Optional BGP triples  
    bindings: Vec<VariableBinding>,         // Variable → source mapping
    equalities: Vec<EqualityConstraint>,    // sameTerm constraints
    filters: Vec<FilterExpression>,         // Filter constraints
    union_branches: Option<Vec<QueryAnalysis>>,  // For UNION
    path_plans: Vec<PathPlan>,              // Expanded property paths
}
```

### 8.2 Variable Classification

Variables are classified by their role:

| Classification | Description | Disclosure |
|----------------|-------------|------------|
| **Projected** | In SELECT clause | Configurable |
| **Internal** | Used in patterns, not projected | Hidden |
| **Intermediate** | Generated for path expansion | Hidden |

### 8.3 Constraint Derivation

From the query analysis, derive:
1. **Signature constraints** (PoKS): Verify signed data membership
2. **Equality constraints**: Variable unification
3. **Bound constraints** (PoNB): Numeric/date comparisons
4. **Existence constraints**: At least one matching triple exists

---

## 9. Implementation Reference

### 9.1 Rust Pattern Handling

From `transform/src/main.rs`:

```rust
fn handle_patterns(pattern: &GraphPattern) -> OutInfo {
    match pattern {
        GraphPattern::Bgp { patterns } => { /* BGP handling */ }
        GraphPattern::Join { left, right } => { /* Join handling */ }
        GraphPattern::Union { left, right } => { /* Union handling */ }
        GraphPattern::LeftJoin { left, right, expression } => { /* Optional */ }
        GraphPattern::Filter { inner, expression } => { /* Filter */ }
        GraphPattern::Extend { inner, variable, expression } => { /* BIND */ }
        GraphPattern::Path { subject, path, object } => { /* Property path */ }
        // ...
    }
}
```

### 9.2 Path Expansion

```rust
fn expand_path_to_plans(path: &PropertyPathExpression) -> Vec<serde_json::Value> {
    match path {
        PropertyPathExpression::NamedNode(nn) => { /* Simple predicate */ }
        PropertyPathExpression::Sequence(a, b) => { /* p1/p2 */ }
        PropertyPathExpression::Alternative(a, b) => { /* p1|p2 */ }
        PropertyPathExpression::ZeroOrMore(inner) => { /* p* */ }
        PropertyPathExpression::OneOrMore(inner) => { /* p+ */ }
        // ...
    }
}
```

---

## 10. Correctness Properties

### 10.1 Soundness

If the proof verifies, then:
$$
\exists \mu \in \text{eval}(Q, D) : \text{disclosed\_bindings} = \pi_V(\mu)
$$

### 10.2 Completeness

For any valid solution $\mu \in \text{eval}(Q, D)$, a proof can be constructed.

### 10.3 Zero-Knowledge

The proof reveals only:
- The SPARQL query $Q$
- Public keys of dataset signers
- Disclosed variable bindings (configurable)
- Architectural parameters (merkle depth, path limits)

---

## References

1. [SPARQL 1.1 Query Language](https://www.w3.org/TR/sparql11-query/)
2. [SPARQL 1.1 Query Semantics](https://www.w3.org/TR/sparql11-query/#sparqlAlgebra)
3. WWW26 zkRDF Paper - Extended Evaluation Semantics
