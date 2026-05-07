# Disclosure Model

This document specifies what information is disclosed by a ZK-SPARQL
proof, and — critically — which post-evaluation properties of the
disclosed output are computed *outside* the circuit by the verifier
rather than re-proven in-circuit.

The governing principle (workspace memory:
`feedback_zkp_no_proof_of_revealed_properties`) is:

> **Information that is revealed in the disclosed output must not be
> ZK-proven inside the circuit.** The circuit's only obligation is
> *correct evaluation against the committed inputs*. Post-evaluation
> properties of the public output (counts, sums, ordering, distinct-
> ness, length, IRI well-formedness, etc.) are the verifier's job.

## 1. Always Disclosed

| Item | Reason |
|------|--------|
| **SPARQL query** | Defines what is being proven |
| **Public keys** | Required for authentication |
| **Signature scheme** | Required for verification |
| **Hash functions** | Required for encoding verification |
| **Merkle depth** | Architecture parameter |
| **Number of datasets** | Structural |

## 2. Conditionally Disclosed

| Item | Default | Configurable |
|------|---------|--------------|
| **Projected variable bindings** | Disclosed | Yes |
| **Path length** (for `+`, `*`, `?`) | Disclosed | No |
| **Optional pattern matched** | Disclosed | No |
| **Union branch taken** | Disclosed | No |
| **Aggregate source multisets** | Disclosed | No (see §7) |

## 3. Never Disclosed

| Item |
|------|
| Merkle roots |
| Signature values |
| Non-projected variable bindings |
| Dataset content beyond query results |
| Triple positions/indices |

## 4. Disclosure Configuration

```rust
pub struct Config {
    /// Variables to disclose (None = all projected)
    pub disclose: Option<Vec<String>>,
}
```

**Disclose only `?name`:**
```rust
let config = Config {
    disclose: Some(vec!["?name".to_string()]),
    ..Default::default()
};
```

**Disclose nothing (existence proof only):**
```rust
let config = Config {
    disclose: Some(vec![]),
    ..Default::default()
};
```

## 5. Structural Disclosure Implications

### 5.1 Merkle Depth

`merkle_depth = 11` reveals: *Each dataset contains at most 2048
triples.*

### 5.2 Path Segment Max

`path_segment_max = 8` reveals: *Property paths traverse at most 8
hops.* The actual path length taken is also disclosed for each path
pattern.

### 5.3 Dataset Count

The number of distinct signed datasets is visible from the public-key
list.

## 6. Info Command

```bash
sparql-zk info --query query.rq
```

Sample output:
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

## 7. Per-operator audit — what is in-circuit vs verifier-side

The table below records, for every SPARQL operator the transform
recognises, exactly which obligations the emitted Noir circuit
enforces and which are deferred to the verifier. Per the principle in
the preamble, no operator emits an in-circuit deduplication, sort,
count, or aggregation primitive over the *disclosed* bindings.
Constraints that operate on the *hidden* committed triples (BGP
matching, FILTER over private witnesses, NOT EXISTS over the sorted
Merkle commitment) are correct-evaluation obligations and stay
in-circuit.

| Operator | In-circuit constraints | Verifier-side checks | Source |
|----------|------------------------|----------------------|--------|
| **BGP** | Triple-position equalities (`variables.x == bgp[i].terms[j]`); per-triple `verify_inclusion` against the Merkle root; signature on the root. | None beyond reading disclosed bindings. | `transform/src/{lower,emit}.rs`; `template/main-verify.template.nr` |
| **FILTER** | The boolean expression compiled by `expr::filter_to_noir` is `assert`ed. Operands are the *hidden* triple terms or constants. EBV / numeric comparison / regex obey IEEE-754. | None — FILTER acts on hidden values, so the predicate must be in-circuit. | `transform/src/expr.rs` |
| **JOIN** | Shared-variable equalities are emitted as additional `assert`s; constraints from one side are distributed into every UNION branch of the other (roborev #332 fix). | None. | `transform/src/lower.rs::join_pattern_infos` |
| **UNION** | OR-of-branches: `assert(branch_0 \| branch_1 \| …)` where each branch conjoins its own triple equalities and FILTERs. The *taken* branch is leaked structurally. | None. | `transform/src/emit.rs` |
| **OPTIONAL** | Power-set variant circuits, one per matched-OPTIONAL bit-mask. Each variant is a plain BGP+FILTER circuit; the matched mask is disclosed via `metadata.json`. | None. (Round 3 collapse via NOT EXISTS handles unmatched arms inside the variant.) | `transform/src/emit.rs::generate_circuit_for_optional_combination` |
| **MINUS** | Restricted-RHS rewrite: the W3C-disjoint case is a no-op; the equivalent-`FILTER NOT EXISTS` case lowers to a non-membership obligation against the sorted Merkle root. | None. | `transform/src/lower.rs::GraphPattern::Minus` |
| **EXISTS** (inside FILTER) | Inner pattern is inlined as additional BGP rows + assertions. The boolean *is* the satisfiability of the resulting circuit, so its correctness is intrinsic. | None — the boolean is the result, not a derived property of a richer disclosure. | `transform/src/lower.rs` (round-3 spike) |
| **NOT EXISTS** | `verify_non_membership_no_inclusion(bracket_left, bracket_right, hash4(absent))` against the sorted commitment. Bracket leaves are inclusion-checked by the generic per-triple loop. | None — like EXISTS, the boolean is the result. | `transform/src/emit.rs`; `noir/lib/utils/src/lib.nr` |
| **Path** (`p+ p* p?`) | Bounded UNION over depths `1..=path_segment_max`; chosen depth is disclosed. Each branch is a join chain. | None. | `transform/src/lower.rs::kleene_unroll` |
| **PROJECT** | The struct `Variables { … }` enumerates *only* the disclosed projected variables; non-projected bindings are not exposed by `main.nr`. | None. | `transform/src/emit.rs` |
| **DISTINCT / REDUCED** | **Nothing.** The transform unwraps the modifier (`lower.rs:1705`); the circuit emits the underlying pattern unchanged. | Verifier dedupes the disclosed multiset of solutions. | `transform/src/lower.rs::process_graph_pattern_inner` |
| **ORDER BY** | **Nothing.** The order keys are unwrapped from the algebra root and propagated only into `metadata.json` (`orderBy`). The circuit body is identical to the unsorted query. | Verifier sorts the disclosed multiset by the keys; `aggregates.ts` performs this. | `transform/src/lower.rs::strip_post_processing`, `unwrap_project_inner` |
| **LIMIT / OFFSET** | **Nothing.** `Slice { start, length }` becomes `metadata.offset` / `metadata.limit`. The circuit produces every solution; slicing is verifier-side. | Verifier asserts `\|disclosed\| ≤ limit` and slices `disclosed[offset..offset+limit]`. | `transform/src/lower.rs::strip_post_processing` |
| **COUNT(?x) / COUNT(\*)** | **Nothing.** The aggregate kind is recorded in `metadata.aggregates`; the circuit discloses the *source multiset* of `?x` (or all in-scope variables for `COUNT(*)`). The aggregate's output variable never appears in the circuit's `Variables` struct. | Verifier counts the disclosed multiset. | `transform/src/lower.rs::aggregate_expression_to_kind`, `process_query_with_options`; `src/aggregates.ts` |
| **COUNT(DISTINCT ?x)** | **Nothing.** Same as `COUNT(?x)`; verifier dedupes before counting. | Verifier computes `\|distinct(disclosed(?x))\|`. | as above |
| **SUM / AVG** | **Nothing.** Source multiset disclosed; aggregate kind in metadata. PR #49 (`origin/aggregates-precision-fix`) hardened the verifier-side IEEE-754 reduction; that lives entirely in `aggregates.ts`. | Verifier sums / averages the disclosed multiset (with `distinct` if requested). | `transform/src/ir.rs::AggregateKind`; `src/aggregates.ts` |
| **MIN / MAX** | **Nothing.** Source multiset disclosed; verifier picks the extremum. | Verifier picks `min` / `max` of the disclosed multiset. | as above |
| **GROUP BY HAVING** | Currently rejected at lowering time when `group_vars` is non-empty (`lower.rs:1945`); HAVING follows trivially from FILTER on the post-processed solutions. | Once supported, partition + per-group aggregate are verifier-side; HAVING is a verifier-side filter on grouped rows. | open work — see §9 |
| **GROUP_CONCAT / SAMPLE / Custom** | Rejected at lowering time. | n/a | `lower.rs::aggregate_expression_to_kind` |
| **ASK** | Body is a plain BGP-with-constraints circuit. The boolean is the satisfiability of the circuit; verifier merely accepts the proof. | None. | `transform/src/lower.rs::process_query_with_options` (ASK branch) |
| **CONSTRUCT / DESCRIBE** | Out of scope (no algebra coverage in round 3). | n/a | n/a |

### 7.1 Sentinel-form circuit body

Every emitted `sparql.nr::checkBinding` is a sequence of:

1. Optional triple-position equalities (`variables.x == bgp[i].terms[j]`).
2. Optional FILTER assertions (compiled from the algebra-level
   expression by `expr.rs`).
3. Optional UNION OR-of-branches.
4. Optional `verify_non_membership_no_inclusion` calls for NOT EXISTS
   / MINUS.

It contains *no* loops, sorts, hash sets, or counters over the
`Variables` struct. This was verified by inspecting every snapshot in
`transform/tests/snapshots/` (50+ fixtures covering BGP, JOIN, UNION,
OPTIONAL, MINUS, NOT EXISTS, EXISTS, paths, FILTER, BIND, DISTINCT,
ORDER BY, LIMIT/OFFSET, COUNT, COUNT(DISTINCT), COUNT(*), SUM, AVG,
MIN, MAX, ASK).

### 7.2 The `noir/lib/utils` sort is *not* an output sort

`noir/lib/utils/src/lib.nr::merkle` runs an insertion sort over the
*hidden* committed triples to derive the canonical sorted-Merkle
commitment. This is a commitment-side primitive — it operates on the
private witness and produces the public root. It is *not* a sort over
disclosed bindings, and the principle does not apply.

## 8. Audit history

| Date | Auditor | Outcome | Notes |
|------|---------|---------|-------|
| 2026-05-03 | claude (round-3 disclosure-audit agent) | No violations. Per-operator table above is the canonical record of in-circuit vs verifier-side responsibilities. | Inspected `lower.rs`, `emit.rs`, `ir.rs`, `expr.rs`, `template/main-verify.template.nr`, `noir/lib/utils/src/lib.nr`, and every aggregate / DISTINCT / ORDER BY / LIMIT fixture in `transform/tests/snapshots/`. Cross-referenced against PR #39 (aggregates via disclose-and-verify), PR #42 (NOT EXISTS), `aggregates-precision-fix` branch (verifier-side IEEE-754). |

## 9. Open concerns

- **GROUP BY (with grouping variables).** Currently rejected; when
  added, the partition logic must stay verifier-side. The transform
  must disclose the source multiset *plus* the group-key variable so
  the verifier can partition; no in-circuit hash-grouping primitive.
- **HAVING.** Trivially verifier-side once GROUP BY is supported, since
  it filters post-aggregation rows.
- **ORDER BY by expression.** `order_expression_to_key` rejects
  non-variable keys. If lifted, the expression must be either (a)
  derivable from disclosed bindings (verifier recomputes), or (b) an
  added projected column whose value is disclosed (verifier sorts on
  it). It must *not* become an in-circuit sort.
- **Path-length disclosure.** The chosen depth for `+` / `*` / `?` is
  leaked structurally by the UNION-of-depths construction. Documented
  as a known disclosure in §2; not a violation, but worth flagging in
  the privacy-leakage analysis (paper §5.5).
- **`__exists_*` / `__blank_*` internal variables.** These never
  appear in the disclosed projection (see `process_query_with_options`
  filter), so there is no revealed property whose computation could be
  duplicated.

## References

- [W3C Verifiable Credentials Data Model](https://www.w3.org/TR/vc-data-model-2.0/)
- Workspace memory: `feedback_zkp_no_proof_of_revealed_properties`
- `circuits/sparql_noir/SPARQL_ROADMAP.md` §8.6 (Q6 disclose-and-verify decision)
- PR #39 — aggregates via disclose-and-verify
- PR #42 — NOT EXISTS sorted-commitment
- `aggregates-precision-fix` branch — verifier-side IEEE-754 reduction
