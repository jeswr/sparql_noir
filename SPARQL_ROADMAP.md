# SPARQL 1.1 Coverage and ZK-Feasibility Roadmap

**Owner:** Jesse Wright (drafted by sparql-semantics + noir-circuits scout)
**Branch:** `docs/sparql-roadmap`
**Status:** Survey + planning. **No code changes** in this round; this document supersedes `SPARQL_COVERAGE.md` as the steering plan.
**Vocabulary:** SPARQL 1.1 algebra terms follow the W3C Recommendation [SPARQL 1.1 §18](https://www.w3.org/TR/sparql11-query/) and the Pérez–Arenas–Gutiérrez (PAG) compositional semantics ("Semantics and Complexity of SPARQL", ACM TODS 34(3), 2009). British English throughout.

---

## 1. Executive summary

`sparql_noir` already supports a non-trivial fragment of SPARQL: the conjunctive core (BGP + Join + Filter), Union, Optional (LeftJoin, encoded as a power-set of UNION-of-flat-circuits), Graph, simple property paths, BIND, Project, and post-processing acceptance of Distinct/OrderBy/Slice/Reduced. Most numeric, datatype, EBV and a partial set of XPath datetime/cast functions land in-circuit via `noir/lib/{ebv,arith,xpath}`. The W3C SPARQL 1.0 evaluation manifest (~270 evaluation tests) is the current de-facto coverage target, with a hand-maintained skip-list (`ts.js`) excluding tests that require features the transform cannot yet render.

The three highest-leverage moves for the next quarter are:
1. **Refactor the `transform/src/lib.rs` god-module** into a layered IR (parse → algebra-IR → constraint-IR → emit) so every subsequent feature lands cleanly rather than as another match arm in the 2,500-line file.
2. **Reach a defensible baseline on SPARQL 1.1 §17 built-ins**: real string ops (CONTAINS/SUBSTR/REGEX), proper IEEE-754 numeric promotion for ABS/ROUND/CEIL/FLOOR, EXISTS/NOT EXISTS, IN/NOT IN, COALESCE, IF.
3. **Stand up the `unconstrained` + `_verified` pattern** in `noir/lib/arith` (integer division, mantissa truncation) and as constant-folding in `noir/lib/{ebv,arith}` for datatype-IRI hashes. **Note:** Merkle-path hashing must stay constrained for soundness — the `unconstrained` pattern is for arithmetic, not the cryptographic chain. Gate-cost wins compound across every generated circuit.

Property paths with Kleene closure, MINUS, subqueries, and aggregates are deferred to a second round once the IR refactor lands; SERVICE, NOW(), UUID(), and update/protocol/federation suites stay permanently out of scope for ZK.

---

## 2. Current coverage

Sources cross-checked: `transform/src/lib.rs` (the only Rust transform body), `noir/lib/{ebv,arith,xpath,utils,types}/src/lib.nr`, `ts.js` (test driver and skip-list), `SPARQL_COVERAGE.md`, `IMPLEMENTATION_SUMMARY.md`, `XPATH_INTEGRATION_SUMMARY.md`, `spec/algebra.md`, `spec/preprocessing.md`. "Y" means in-circuit and exercised; "Partial" means accepted but with an asterisk; "Post" means accepted by the transform but enforced by the verifier outside the proof; "N" means rejected by the transform today.

### 2.1 Algebra (PAG core + 1.1 extensions)

| Algebra op | In-circuit? | Where | Notes |
|---|---|---|---|
| BGP | Y | `transform/src/lib.rs::process_patterns` (~L1379) | Subject/predicate/object processed; blank nodes treated as internal vars (`__blank_*`). Predicate variables supported. |
| Join | Y | `process_graph_pattern::Join` (~L1624) | Implicit conjunction; index offsetting for optional blocks (`adjust_optional_block_indices`). |
| Filter | Y (subset) | `filter_to_noir` (~L780), `numeric_comparison` (~L1099) | Equality, ordered comparisons (numeric/string/bool/datetime), BOUND, sameTerm, &&, \|\|, !, isIRI/isBlank/isLiteral, LANG/STR/DATATYPE/LANGMATCHES, partial type-aware equality. |
| Union | Y | `process_graph_pattern::Union` (~L1762) | Branches collected and OR-joined; widest branch determines circuit BGP shape. |
| LeftJoin (OPTIONAL) | Y, expensive | `process_graph_pattern::LeftJoin` (~L1697) and `transform_query_with_options` (~L2243) | Encoded by enumerating the `2^n` matched/unmatched power set of optional blocks; one circuit variant per combination (see `optional_circuits` in `TransformResult`). Variables that only appear in unmatched optionals are dropped from `Variables`. |
| Minus | N | n/a | Rejected; algebraic negation not implemented. |
| Graph | Y | `process_graph_pattern::Graph` (~L1796) | Stores graph IRI in 4th term of `Triple`; supports both `GRAPH <iri>` and `GRAPH ?g`. |
| Path (link, inverse, alternative, ZeroOrOne) | Y | `expand_path` (~L1511) | Unfolds at transform time into BGP/Join/Union. `Sequence` only for direct named-node legs. |
| Path (Sequence of paths, +, *) | Y | `lower::expand_path` / `kleene_unroll` | Bounded unrolling to `path_segment_max` (default 4) — `+` over depths 1..=N, `*` adds zero-step branch. Path-length leaks (documented disclosure). |
| Path (NPS `!p`) | Y | `lower::expand_negated_property_set` | Single triple plus conjunction of `?p != p_i` filters. `^!P` handled via `normalise_path` push-down. |
| Extend (BIND) | Partial | `process_graph_pattern::Extend` (~L1682) | Only Variable / NamedNode / Literal RHS. Arithmetic, function calls in BIND rejected. |
| Group / Aggregate | N | rejected by `ts.js` skip-list | Out of scope as currently scoped. |
| Service | N | rejected | Out of scope. |
| Project | Y | `process_query` (~L1862) | Required wrapper for SELECT; ASK works without Project (auto-collects vars). |
| Distinct / Reduced | Post | unwrap loop in `process_query` (~L1865) | Accepted; not enforced in-circuit. |
| OrderBy | Post | same | Accepted; not enforced. |
| Slice (LIMIT/OFFSET) | Post | same | Accepted; not enforced. |
| ToList / ToMultiset | n/a | implicit | Not modelled explicitly; bag semantics implicit in the verifier. |
| Values | N | rejected | Listed for preprocessing → UNION expansion. |

### 2.2 Query forms

| Form | Status | Notes |
|---|---|---|
| SELECT | Y | Variable projection, `Variables` struct in `sparql.nr`. |
| ASK | Y | Falls through Project unwrap; auto-collects vars (`process_query`). |
| CONSTRUCT | N | Different output shape; not modelled. |
| DESCRIBE | Partial | Parses, behaviour undefined. |

### 2.3 FILTER built-ins (SPARQL 1.1 §17)

| Function / operator | Status | Source / caveat |
|---|---|---|
| `=`, `!=`, `<`, `<=`, `>`, `>=` (numeric, string, bool, datetime) | Y | `filter_to_noir`, `numeric_comparison`, `string_comparison`, `boolean_comparison`, `datetime_comparison` |
| `&&`, `\|\|`, `!` | Y | filter_to_noir |
| `BOUND`, `sameTerm` | Y | filter_to_noir |
| `isIRI` / `isURI`, `isBlank`, `isLiteral` | Y | `type_check` |
| `STR`, `LANG`, `DATATYPE`, `LANGMATCHES` | Y | `handle_function_equality` (compares hashed values) |
| `IRI()`, `BNODE()`, `STRDT`, `STRLANG` | N | not implemented |
| `UUID`, `STRUUID`, `RAND`, `NOW` | N (OOS) | non-deterministic / external time — incompatible with ZK reproducibility |
| `IN`, `NOT IN` | N (preprocess) | spec/preprocessing.md flags expansion to disjunction |
| `EXISTS`, `NOT EXISTS` | N | filter sub-pattern; would require nesting a pattern check |
| `IF`, `COALESCE` | N | conditional expressions; not implemented |
| `isNumeric` | N | not implemented |
| Numeric: `ABS`, `ROUND`, `CEIL`, `FLOOR` | Partial (integer-only happy-path) | `Function::Abs` etc. emit `xpath::abs_int` always; float/double broken — see XPATH_INTEGRATION_SUMMARY.md §1. |
| Numeric: arithmetic in expressions (`+ - * /` between operands) | N | `noir/lib/arith` exists with `Float`/`ArithResult` machinery but is unused by the transform. |
| String: `STRLEN`, `CONTAINS`, `STRSTARTS`, `STRENDS` | Stub | Functions emit hash-based placeholders; `noir_xpath::contains` etc. are re-exported in `noir/lib/xpath` but not wired through. |
| String: `SUBSTR`, `UCASE`, `LCASE`, `STRBEFORE`, `STRAFTER`, `CONCAT`, `ENCODE_FOR_URI`, `REPLACE` | N | not implemented; require in-circuit byte-level string handling |
| `REGEX` | N | not implemented |
| Datetime: `YEAR`, `MONTH`, `DAY`, `HOURS`, `MINUTES`, `SECONDS`, `TIMEZONE` | Y | `expr_to_noir_code` lines 585–620; encoded values pass through `xpath::datetime_from_epoch_microseconds` |
| Datetime: `TZ` | N | not implemented |
| Hash: `MD5`, `SHA1`, `SHA256`, `SHA384`, `SHA512` | N (OOS for now) | `noir/lib/hashes` has poseidon2 only; SHA family available via stdlib but not wired |
| XSD casts (`xsd:integer(?v)`, `xsd:float`, `xsd:double`, `xsd:decimal`, `xsd:boolean`, `xsd:string`) | Partial | `handle_xsd_cast` (~L334) supports several targets; numeric→string rejected; `xsd:dateTime/date/time` are no-ops |
| EBV (`FILTER(?v)`, `FILTER(!?v)`, bare literal) | Y | `noir/lib/ebv` + filter_to_noir Variable/Literal arms |

### 2.4 Plumbing observations

- `noir/lib/arith/src/lib.nr` (1,376 lines) implements full SPARQL 1.1 type-promoted arithmetic with a base-10 `Float` (sign/mantissa/exponent), but **the Rust transform never emits calls into it**. There is a parallel float story in `noir_xpath` (IEEE 754) which the transform _does_ call. Two competing float representations is a smell.
- `noir/lib/xpath` is essentially a re-export of `noir_xpath` with a small `is_numeric_type` helper. Healthy.
- `noir/lib/utils::verify_inclusion` (~L25) does a serial `for i in 1..MERKLE_DEPTH` of `consts::hash2` over a sibling path — prime candidate for unconstrained path validation.
- Optional power-set generation is `O(2^n)` circuits — fine at n≤3, will explode beyond. No reuse between siblings.

---

## 3. Gap analysis vs SPARQL 1.1

For each missing or partial feature, ZK feasibility is scored:
- **Easy** — bounded loops, clean compositional semantics, no recursion.
- **Hard** — needs a circuit-friendly reformulation (bounded unrolling, sort-and-witness pattern, etc.) but the path is known.
- **OOS (out of scope)** — federation, time/randomness sources, or features that require unbounded external state.

| Feature / function | ZK feasibility | Reason | Dependencies |
|---|---|---|---|
| MINUS | Hard | Negation as failure; equivalent to `Filter(NOT EXISTS)` per spec §15.4. Needs a "no compatible binding exists" witness over the inner pattern. | EXISTS in-circuit primitive |
| EXISTS / NOT EXISTS | Hard | Same as MINUS. Inner pattern is a fresh BGP/Filter; prover supplies witness "exists" or sets of incompatibility witnesses ("doesn't exist for any of these candidates"). Bounded by the inner pattern's domain. | Bounded-domain witness format; tighter integration with `ts.js` test data |
| IN / NOT IN | Easy | Already documented as `OR` expansion at preprocess time. Just lift into `expr_to_noir_code` directly. | None |
| IF / COALESCE | Easy | Encode as `if x { a } else { b }` in Noir; for COALESCE iterate args until first non-error. | EBV plumbing already exists |
| isNumeric | Easy | Reuse `arith::get_numeric_type_level`; emit predicate. | None |
| BIND with expressions | Hard | Means `expr_to_noir_code` runs in pattern position too; must thread bindings through subsequent triple patterns. Currently Extend only takes Variable/NamedNode/Literal. | Refactor §6 |
| Sequence path `/` (multi-hop) | Easy | Mechanical chained-BGP rewrite already in `expand_path::Sequence` for direct named-node legs; extend to recursive case at preprocess time. | None |
| `+`, `*` (Kleene paths) | Hard | Bounded unrolling to MAX_DEPTH = path_segment_max (config has it; preprocess.md §3.3 specifies). Path length leaks (already documented as disclosed). | Config plumbing into transform |
| `^p` (already supported for direct), `^(p1/p2)` | Hard | Recursive reverse — algebraic identity `^(p1/p2) ≡ ^p2/^p1`, but iteration over `PropertyPathExpression::Reverse` not yet recursive. | Refactor §6 |
| NPS `!p` | Hard | Requires enumerating "anything except". Could be encoded by witnessing the actual predicate and asserting inequality with each excluded one — bounded by exclude-set size. | None hard |
| VALUES | Easy | Documented preprocess → UNION. | None |
| Subqueries (SELECT inside WHERE) | Hard | Inner SELECT reduces to a sub-BGP scope with projection/post-processing inside; bounded but doubles algebra-IR plumbing. | Refactor §6 |
| Aggregates (COUNT, SUM, AVG, MIN, MAX, GROUP_CONCAT, SAMPLE) | Hard | Requires proving over a witness-multiset. SUM/COUNT are linear and tractable; AVG needs division (use `arith::div_floats`); MIN/MAX need a sorting-network or "witnessed extremum + each input ≥/≤ it" proof; GROUP_CONCAT requires bounded string handling; SAMPLE is non-deterministic. Best done after ORDER BY in-circuit lands (sort proof). | Sort proof; multiset cardinality witness |
| GROUP BY / HAVING | Hard | Same machinery as aggregates: groups are partitions of the witness-multiset. | Aggregates |
| ORDER BY in-circuit (instead of post) | Hard | Sort proof: prover supplies sorted permutation π; circuit asserts `π` is a permutation of input (via multiset equality / hashing) and adjacent pairs are ordered. Bounded by result size. | Witness format change |
| DISTINCT in-circuit | Hard | Requires sort-and-dedupe proof (same machinery as ORDER BY) or a hash-set membership witness. Currently post-processed; could stay post but in-circuit DISTINCT enables COUNT DISTINCT. | Sort proof |
| LIMIT / OFFSET in-circuit | Hard if combined with ORDER BY in-circuit; otherwise N/A | Once ORDER BY is in-circuit, slicing is just an array prefix. | ORDER BY |
| REGEX | Hard | Bounded NFA over fixed-size string buffer. Substantial work; depends on a UTF-8 byte representation and pattern compilation. | String buffer witnesses; see §3 string functions |
| String functions (CONTAINS, SUBSTR, STRSTARTS, STRENDS, STRBEFORE, STRAFTER, UCASE, LCASE, CONCAT, REPLACE, ENCODE_FOR_URI) | Hard | Need byte-level string witnesses (length + bounded buffer) attached to literal terms. Hash-only encoding can't support these. Redesign of `Triple.terms` field 2 ("special encoding") to optionally carry a bounded byte array. | Encoding redesign |
| STRLEN | Hard | Same prerequisite as above. |
| `IRI(...)`, `BNODE(...)` | Hard | Constructive; produce a fresh term. Relies on string functions for IRI(). |
| `STRDT(...)`, `STRLANG(...)` | Hard | Construct typed/lang literal; same prerequisite. |
| `MD5`, `SHA1`, `SHA256`, `SHA384`, `SHA512` | Hard but possible | Noir stdlib has SHA256/Blake2 etc.; would need byte-level string input. Probably leave SHA1/MD5 unsupported (legacy + collision-broken). |
| `UUID`, `STRUUID`, `NOW`, `RAND`, `TZ` | OOS | Non-deterministic / external state. Cannot be ZK-reproduced without an oracle, which defeats the purpose. |
| `SERVICE` | OOS | Federated query; out of scope. |
| Update language (INSERT/DELETE/CLEAR/DROP/COPY/MOVE/ADD) | OOS | Mutation of signed data is incompatible with the signing+inclusion model. |
| Federated syntax | OOS | Same as SERVICE. |
| Entailment regimes (RDFS, OWL, RIF) | OOS for now | Would require materialising entailed triples and proving the entailment. Future research; not on roadmap. |
| CONSTRUCT, DESCRIBE | Hard | Output is a graph rather than a binding set; requires a different proof shape. Probably worth it only after SELECT is rock-solid. |

### Formal anchors (PAG / W3C)

- BGP and Join: PAG §3.1; W3C §18.2.2.6 (Join), §18.2.2.5 (BGP).
- LeftJoin (OPTIONAL): PAG §3.2; W3C §18.5 (OPTIONAL evaluation, `compatible` on solutions).
- Filter / EBV: W3C §17.2.2 (EBV) — already implemented in `noir/lib/ebv`.
- Numeric type promotion: W3C §17.3, XPath F&O type hierarchy. Currently violated; see §2.3.
- Property paths: W3C §18.5 / §9.2 — Kleene-bounded unrolling is the standard ZK-friendly reformulation.
- Aggregation: W3C §18.5 (Group/Aggregation); the multiset semantics of GROUP BY combined with the sort-and-witness pattern is the canonical ZK approach.

---

## 4. W3C test-suite reachability

Approximate counts derived from the manifest layouts surveyed via `analyze-bn.mjs`/`analyze-functions.mjs` and the public manifests at `https://w3c.github.io/rdf-tests/sparql/`. Concrete numbers will need to be re-measured when `check-tests.mjs` is wired into CI; treat the table as a planning estimate.

### 4.1 SPARQL 1.0 evaluation suite (`data-r2`)

| Category | Approx. tests | Currently reachable | Blocker |
|---|---|---|---|
| `basic` | ~25 | Mostly Y | OK |
| `triple-match` | ~10 | Y | OK |
| `algebra` | ~15 | Mostly Y | UNION + Join already covered |
| `optional` | ~13 | Partial | Power-set OPTIONAL is correct but expensive; some tests in skip-list (`Complex optional semantics: 1/2/4`, `OPTIONAL - Inner FILTER...`) |
| `optional-filter` | ~7 | Partial | Inner-FILTER-with-outer-vars edge cases |
| `graph` | ~13 | Y | Some `Join operator with Graph and Union` skipped |
| `dataset` | ~14 | Partial | FROM / FROM NAMED currently relies on signed-dataset boundary; tests OK if dataset modelling holds |
| `bound` | ~7 | Y | OK |
| `expr-builtin` | ~30 | Partial | LANG/STR/DATATYPE/LANGMATCHES Y; rest depends on string ops |
| `expr-ops` | ~10 | Partial | && \|\| ! Y; arithmetic in FILTER not in transform |
| `expr-equals` | ~5 | Partial | RDFterm-equal subtle (1 ≠ 1.0 in our hash encoding) |
| `regex` | ~7 | N | needs in-circuit REGEX |
| `cast` | ~12 | Partial | xsd casts work for numeric; numeric→string rejected |
| `boolean-effective-value` | ~12 | Y | EBV library covers this |
| `bnode-coreference` | ~7 | Y | `__blank_*` internal vars |
| `sort` | ~6 | Y (post-processed) | Verifier-side |
| `distinct` | ~5 | Y (post-processed) | Verifier-side |
| `reduced` | ~2 | Y (post-processed) | Verifier-side |
| `solution-seq` | ~3 | Y | Slice/Distinct/OrderBy as post |
| `construct` | ~14 | N | Different result shape |
| `ask` | ~5 | Y | OK |
| `i18n` | ~3 | Partial | Depends on language tag handling |
| `open-world` | ~10 | Partial | `open-cmp-01/02` skipped (cross-type comparisons) |
| `type-promotion` | ~9 | Partial | Numeric promotion broken for non-integer ABS/ROUND/CEIL/FLOOR |
| `syntax-sparql{1..5}` | ~70 | n/a | Negative syntax tests; not relevant to circuit transform |

**Estimate:** of ~270 evaluation tests in SPARQL 1.0 (excluding pure syntax), the current circuit can in principle pass on the order of 110–140 once test scaffolding is fully wired (the project's test runner has not produced an authoritative pass-rate number — `check-tests.mjs` collects manifest-info but does not run; `ts.js` runs subset only). Closing the string-function and arithmetic gaps would push that to ~180–200. Construct/regex/aggregates/federation will not be reached.

### 4.2 SPARQL 1.1 manifest (`data-sparql11`)

| Sub-manifest | In ZK scope? | Comment |
|---|---|---|
| `bind` | Yes | Blocked on BIND-with-expressions |
| `bindings` | Yes | Blocked on VALUES preprocess |
| `cast` | Yes | Numeric cast working; string cast hard |
| `construct` | Maybe later | Different result shape |
| `exists` | Yes (Hard) | EXISTS / NOT EXISTS |
| `functions` | Yes | Most §17 built-ins live here |
| `negation` | Yes (Hard) | MINUS + NOT EXISTS |
| `project-expression` | Yes | Project with expressions, blocked on BIND-expressions |
| `property-path` | Partial | Kleene paths Hard |
| `subquery` | Yes (Hard) | Nested SELECT |
| `aggregates`, `grouping` | Yes (Hard) | Group + Aggregate |
| `service`, `syntax-fed`, `service-description` | OOS | Federation |
| `add`, `basic-update`, `clear`, `copy`, `delete*`, `drop`, `move`, `update-silent`, `syntax-update-1/2`, `http-rdf-update` | OOS | Update / Graph Store HTTP — incompatible with signed-dataset model |
| `entailment` | OOS for now | Future research |
| `csv-tsv-res`, `json-res`, `protocol` | OOS | Result format and protocol layers — orthogonal to ZK |
| `syntax-query` | n/a | Parser-level, not transform |

---

## 5. Optimisation candidates (`unconstrained` + `_verified` pattern)

The pattern (cf. `noir_IEEE754::unconstrained_ops.nr`): compute the answer in an `unconstrained fn`, then assert a cheap relation that proves the answer is correct. Targets in this repo, ordered by expected gate-cost reduction. Gate counts are estimates — the project has no benchmark wired; `npm run benchmark` exists but isn't routinely run.

| Function | Current shape | Unconstrained sketch | Eventual NAVe/Lampe story |
|---|---|---|---|
| `utils::verify_inclusion` (~L25–35) | Serial `for i in 1..MERKLE_DEPTH` of `consts::hash2`. ~MERKLE_DEPTH × pedersen_hash gates per triple, multiplied across BGP. | **Soundness note:** the Merkle hash chain itself MUST stay constrained, and the final `assert_eq(current, root_value)` MUST stay — that equality is the actual membership check tying the constrained recomputation to the committed root, not a redundant line. Moving the hashes unconstrained, or removing the final equality, would let a malicious prover accept arbitrary paths. **The only legitimate wins here are at the call-site, not inside `verify_inclusion`:** (a) batching path verification across BGP triples that share a Merkle prefix (rare in practice), and (b) deduplicating the work when the same triple appears in multiple OPTIONAL combinations once §6.4 lands. The function body itself should not change. **Listed only because it's on every hot path; deprioritise.** | Not a Lampe candidate — the relation is already as tight as the security goal allows. |
| `arith::div_floats` (~L283) | Long division loop over `FLOAT_PRECISION` digits, mantissa scaling. | `unconstrained` compute `(q, r) = a/b` with `r < b`; constrained check `q*b + r == a` and `r < b`. Classic integer-division-as-multiplication. **High win** — replaces a 7-iteration loop with a multiplication+comparison. | Lampe-friendly relation (single multiplicative identity); good first target. |
| `arith::truncate` (~L168) | Loops to find leading-digit magnitude (`for i in 0..25`). | `unconstrained` returns `(magnitude, divisor)`; constrained checks `divisor ≤ mantissa < divisor*10`. Replaces 25-iteration loop with two range checks. | Lampe straightforward. |
| `arith::pow10` (~L152) | Lookup for `n < 25`, iterative for ≥ 25. | `unconstrained` returns `pow10(n)`; constrained loop multiplies by 10 in unconstrained mode and asserts the result. Minor win because lookup already covers the common case. | Low priority. |
| `ebv::ebv` and `arith::get_numeric_type_level` | Both unroll a list of `encode_datatype_iri("...")` comparisons (~16 per call). | Precompute the datatype-IRI hashes at compile time as `global` constants; replace string-encoding hashes with constant comparisons. **No `unconstrained` needed** — pure constant folding. **High win** — every filter that touches numeric/EBV pays this today. | n/a |
| `xpath::*_int` calls in `expr_to_noir_code` (numeric ABS/ROUND/CEIL/FLOOR) | One call per use; computation in `noir_xpath`. | Current path is fine; the win is wiring float/double versions correctly (see §3) rather than unconstrained. | n/a |
| Future: sort proof for in-circuit ORDER BY / DISTINCT / aggregates | n/a (not built) | `unconstrained` returns a permutation π (and a sorted copy); constrained checks (i) π is a permutation (multiset hash equal to input multiset hash) and (ii) sorted[i] ≤ sorted[i+1]. This is the canonical ZK sort. | Lampe excellent fit; the permutation relation is exactly the kind of thing it was made for. |
| Future: bounded REGEX (NFA-on-bounded-string) | n/a | `unconstrained` runs the NFA, returns accepting state path; constrained re-walks the path and checks transitions are valid. | Long-term. |

The **most leverage for least effort** is the constant-folding of datatype-IRI hashes in `ebv` and `arith`: every filter that compares against a datatype today recomputes ~16 string hashes. Lift them to `global`s (or a generated `const` table from `setup.ts`) and the gate cost drops sharply with no unconstrained machinery needed. Do this as part of the IR refactor.

---

## 6. Refactoring punch list

These are the structural changes that, if made, unblock everything else. Listed by impact / cost; a smaller curated set rather than a smell-by-smell catalogue.

1. **Split `transform/src/lib.rs` into a layered IR.** It is currently 2,483 lines with parse, algebra-IR, expression-to-Noir, pattern processing, optional power-set generation, JSON metadata, and template expansion all in one file. Proposed layout under `transform/src/`:
   - `parse.rs` — spargebra wrapper, query-form dispatch.
   - `ir.rs` — the algebra-level IR (`PatternInfo`, `OptionalBlock`, `Term`, `Assertion`, `QueryInfo`); pure data.
   - `expr.rs` — `expr_to_noir_code`, `filter_to_noir`, comparison helpers — emits Noir code strings from expression IR.
   - `lower.rs` — `process_query`, `process_graph_pattern`, path expansion.
   - `emit.rs` — `generate_sparql_nr_from_query_info`, template-filling for `main.nr`, Nargo.toml.
   - `metadata.rs` — JSON serialisation.
   - `lib.rs` — re-exports + WASM bindings.
   This is the single highest-impact change. Every feature on §3's list lands cleanly afterwards; before the split, every new function/operator becomes another arm in the same `match expr` stack. **Cost:** 1–2 days mechanical refactor + thorough snapshot tests so behaviour is unchanged. **Impact:** unblocks rounds 2 and 3.

2. **Decide on a single float representation and delete the loser.** `noir/lib/arith` (`Float` with sign/mantissa/exponent, base-10) and `noir/lib/xpath` (re-exports `noir_xpath`'s IEEE 754 `XsdFloat`/`XsdDouble`) coexist; the transform only calls into the latter. Either:
   - Adopt IEEE 754 throughout (likely choice — matches SPARQL 1.1 §17.3 which references XPath F&O), and rewrite the surviving parts of `noir/lib/arith` (type-promotion machinery, `ArithResult`) to call `noir_xpath` rather than its own `Float`. Delete `add_floats`/`sub_floats`/`mul_floats`/`div_floats`/`truncate*`/encode_float and most of the comparison helpers (~700 lines deleted).
   - Or use `arith::Float` for `xsd:decimal` (arbitrary-precision-ish, base 10) and `xpath::XsdFloat`/`XsdDouble` for `xsd:float`/`xsd:double`. Doable but more code paths.
   I recommend the first option. **Cost:** 2–3 days. **Impact:** removes the most painful inconsistency in the codebase, prerequisite to fixing ABS/ROUND/CEIL/FLOOR for non-integers.

3. **Re-design `Triple.terms[1]`'s "special encoding" to carry a bounded byte string when needed.** Today literals collapse to a single `Field` ("special_encoding") that is either an integer, an epoch-ms, or `consts::encode_string`. To support real string functions (CONTAINS, REGEX, SUBSTR, etc.) we need access to the actual bytes inside the circuit, behind a length witness. Proposal: the witness for a triple containing a string-typed object additionally provides a bounded `[u8; STRING_LEN_MAX]` and a `length: u32 < STRING_LEN_MAX`, plus a hash binding `assert(consts::encode_string_bytes(bytes, length) == terms[1])`. STRING_LEN_MAX is configurable, similar to MERKLE_DEPTH; default e.g. 64. **Cost:** 3–5 days (encoding changes in TS + Rust + Noir + verifier). **Impact:** unlocks all real string ops, REGEX, hash functions, IRI()/STRDT/STRLANG.

4. **Investigate folding the optional power-set generation into a single circuit with `is_matched` flags — but only if a sound non-existence proof can be wired in.** The current `2^n` circuit generation strategy in `transform_query_with_options` (~L2376) is correct for small n but doubles with each new OPTIONAL. A single circuit with one `is_matched: bool` per optional block sounds attractive in artefact-size terms — but **a naive "if `is_matched=false`, skip the inner assertions" is unsound under SPARQL OPTIONAL semantics**: per W3C §18.5 / PAG §3.2, when there exists at least one binding compatible with the inner OPTIONAL the result MUST extend with that binding. A prover who chooses `is_matched=false` despite a compatible match existing would produce an incorrect (but proof-validating) result, hiding rows that should appear. To collapse the power set we must therefore prove, in the unmatched arm, that **no compatible inner binding exists in the dataset** — i.e. an in-circuit NOT EXISTS over the inner pattern. That is essentially the same primitive needed for `MINUS` / `NOT EXISTS` (round 3 of §7). Concretely: do not collapse OPTIONAL until round 3 lands, at which point the same NOT-EXISTS witness format powers both. Until then, keep the power-set strategy and just add a sanity guard rejecting queries with too many OPTIONALs (configurable cap, default e.g. 4).

5. **Constant-fold datatype-IRI hashes.** Lift the dozen `encode_datatype_iri("http://www.w3.org/2001/XMLSchema#X")` calls in `ebv::is_*_datatype` and `arith::get_numeric_type_level` to `global`s, ideally generated by `setup.ts` (which already configures `noir/lib/consts`). Removes a constant-but-significant overhead from every filter that tests a numeric/string/EBV type. **Cost:** half a day. **Impact:** measurable gate reduction across most generated circuits.

(Smells we are deliberately not chasing in this round: TypeScript / Rust naming inconsistencies in `metadata` (both `inputPatterns` and `input_patterns` shipped); legacy templates in `transform/template/`; the various undocumented `noir/lib/signatures/babyjubjubOpt` etc. — useful but tangential.)

---

## 7. Recommended ordering

Three rounds, each shaped to land as a coherent PR with an associated demo / coverage delta.

### Round 1 (~1–2 weeks): IR refactor + low-effort wins

Land structural changes that unblock everything else, plus the cheap functional gaps that are pure additive work.

- §6.1: split `transform/src/lib.rs` into the proposed five-module IR. Snapshot tests guard behaviour parity.
- §6.5: constant-fold datatype-IRI hashes.
- §3 IN / NOT IN, IF, COALESCE, isNumeric — all "Easy" + clean fits in the new IR.
- §3 VALUES preprocessing → UNION, in the transform itself rather than as a separate preprocess pass.
- §3 sequence path `/` and recursive `^` — small algebraic rewrites.
- Wire `check-tests.mjs` (or its successor — coordinate with the parallel test-cleanup agent on `/tmp/wt-sparql-tests`) to produce an authoritative SPARQL 1.0 pass/fail table in CI. Without this, "coverage" is conjecture.

**Definition of done:** transform module split lands; SPARQL 1.0 pass-rate reported (publicly, in `SPARQL_COVERAGE.md` or successor); IN/IF/COALESCE/VALUES tests pass.

### Round 2 (~1–2 weeks): proper SPARQL 1.1 numeric/datetime + OPTIONAL collapse

Make the existing partial features actually correct, and clean up OPTIONAL so it scales.

- [x] §6.2: pick IEEE 754 (recommended) and delete `arith::Float`'s arithmetic; rewire ABS/ROUND/CEIL/FLOOR to type-aware float/double/integer paths. **Landed in PR #38.**
- [x] §3 Kleene paths `+` and `*` with config-driven max depth (`path_segment_max`). **Landed in PR #40 (round 2 remaining).** Bounded unrolling to `TransformOptions::path_segment_max` (default 4); `+` is `UNION` over depths 1..=N, `*` adds an explicit zero-step branch (`FILTER(true)` for ground-equal endpoints, `FILTER(false)` for ground-unequal).
- [x] §3 NPS `!p` (small win, mostly mechanical). **Landed in PR #40.** Single triple `s ?np o` plus a conjunction of inequality filters. `^!{…}` and Reverse-pushdown handled via `normalise_path`.
- [ ] §5 unconstrained `div_int`/`div_float` and `truncate` rewrites. **Deferred** to a later round — out of scope for round 2 remaining; not on the critical path now that IEEE 754 has landed.
- [x] Wire numeric arithmetic in FILTER expressions (`?x + ?y > 5`, etc.) — `arith::add`/`sub`/`mul`/`div` already exist behind a clean API; just call them from the new `expr.rs`. **Wired in PR #38** (IEEE 754 throughout); end-to-end snapshot coverage added in PR #40.
- [x] Defensive cap on the number of OPTIONAL blocks accepted by the transform (e.g. 4) to prevent accidental `2^n` circuit generation. Full collapse is deferred to round 3 because, per §6.4, it requires a sound NOT-EXISTS primitive. **Landed in PR #40** as `TransformOptions::optional_cap` (default 4).

**Definition of done:** SPARQL 1.0 `type-promotion` and `cast` suites pass; numeric arithmetic in filters works; queries with > N OPTIONALs are explicitly rejected with a clear error rather than silently exploding.

### Round 3 (~1–2 weeks): EXISTS, MINUS, BIND-expressions, sort proof scaffolding

The harder semantic features, plus the foundation for aggregates / DISTINCT / ORDER BY in-circuit.

- [x] §3 EXISTS — landed in PR #41 (round-3 spike) via the witnessed inner-pattern flatten reformulation.
- [x] §3 sorted Merkle commitment — landed in round-3 main event. `noir::utils::merkle` sorts leaves by `consts::hash4` before tree construction; root commits to a permutation-invariant canonical form.
- [x] §3 NOT EXISTS — landed in round-3 main event (single-triple ground-inner only). New primitive `noir::utils::verify_non_membership_no_inclusion` powers the lowering; `transform/src/lower.rs` emits a `NonExistenceConstraint` for each `FILTER(NOT EXISTS { t })`. Multi-triple inner / non-ground inner / nested NOT-EXISTS rejected at lowering with pointers to `spec/exists.md` §7.
- [x] §3 NOT EXISTS — **non-membership boundary sentinels (round-3 follow-up landed).** Copilot's review of `sparql_noir#42` showed the original "no implicit sentinels" contract rejected valid `NOT EXISTS` queries with probability `2/(N+1)` (~18% at N=10, ~2% at N=100) — the order-statistic argument `E[X_(1)] = F/(N+1)`, `E[X_(N)] = NF/(N+1)` makes boundary-falling `absent_hash` values uniformly likely, **not** "vanishingly rare" as the spec claimed. PR `non-membership-sentinels` lands the fix: `noir::utils::merkle` now always inserts a low sentinel at sorted index 0 (leaf-hash `consts::LOW_SENTINEL_HASH = 0`) and a high sentinel at sorted index `N+1` (leaf-hash `consts::HIGH_SENTINEL_HASH = 0 - 1` = the BN254 prime minus one). Sentinel hashes are permanent ABI in `noir/lib/consts/src/lib.nr`. New primitives `verify_non_membership_low_sentinel` / `verify_non_membership_high_sentinel` (and `_no_inclusion` variants) bracket boundary-case absent hashes; property tests `test_non_membership_low_boundary` / `test_non_membership_high_boundary` cover both ends. Transform-side wiring to detect boundary cases and emit the sentinel-aware primitive call is a separate follow-up; the underlying primitives are ready. See `spec/exists.md` §3.3.
- [x] §3 MINUS — landed in round-3 main event. Algebra-level rewrite to `Filter(NOT EXISTS { Pi }, Po)` per W3C §18.5; reuses the NOT EXISTS lowering. W3C variable-disjoint freshness side-condition is documented as a small over-restriction (round-4 follow-up).
- [ ] §6.4: OPTIONAL collapse — **deferred to round 4**. The unmatched arm requires non-membership of a *pattern* with free positions (e.g. `OPTIONAL { ?p ex:age ?o }` with `?o` inner-only) — strictly harder than Stage 2's single-triple ground-inner NOT EXISTS. Three approaches considered in `questions/optional-collapse-pattern-non-membership.md`; decision pending. Until then `optional_circuits[]` and the `2^n` variant generation stay (with the round-2 `optional_cap` guard).
- [ ] **Round-4 prefix-tree commitment scaffolding.** `noir::utils::prefix3` lands the prefix-3 (`(s, p, g)`-keyed) Merkle commitment + non-membership primitives + property tests, alongside the round-3 leaf-hash sorted commitment (per the modular-commitment directive in workspace memory). Design doc at `spec/prefix-tree-commitment.md`; primitive set: `merkle_prefix3`, `verify_inclusion_prefix3`, `verify_non_membership_prefix3{,_no_inclusion}`, `verify_non_membership_prefix3_low_sentinel{,_no_inclusion}`, `verify_non_membership_prefix3_high_sentinel{,_no_inclusion}`. Domain-separated `hash3_sp_g(s, p, g) = hash4([s, p, g, PREFIX3_SP_G_DOMAIN_SEPARATOR])` reuses the existing Pedersen primitive — no new cryptographic assumption. **Transform-side dispatch** (`lower.rs` / `emit.rs` recognising prefix-3 cases and emitting `PrefixNonExistenceConstraint`) is the follow-up round; design documented in `spec/prefix-tree-commitment.md` Sec.8. **Other 15 prefix variants** (subset-of-`{s, p, o, g}`) follow the same template (Sec.7) and land as concrete query classes call for them.
- [ ] §3 BIND with arbitrary expressions — out of scope for this PR, separate round-3 follow-up.
- ~~§5 sort proof scaffolding in `noir/lib/utils` (multiset-hash + monotone-pairs primitives), behind a `_verified`-style API. No SPARQL feature uses it yet; this builds the foundation.~~ **Removed** per Q6 decision (2026-05-03): under the "don't ZK-prove revealed properties" principle (see §8.6), sort proofs are only needed for non-revealed orderings, of which we currently have none. Defer until a concrete non-revealed-output use case is identified.
- [ ] §3 subqueries — out of scope for this PR, separate round-3 follow-up.

**Definition of done (round-3 main event, partial):** EXISTS/NOT EXISTS/MINUS tests pass; sorted Merkle commitment lands; the soundness argument for non-membership is documented (`spec/exists.md` §3.3, §5). OPTIONAL collapse + BIND-expressions + subqueries are explicit follow-ups (see `questions/optional-collapse-pattern-non-membership.md`). `COUNT(DISTINCT ?x)` already landed in PR #39 by disclosing the underlying multiset (per Q6 decision — no in-circuit DISTINCT primitive). Sort-proof scaffolding deliberately deferred per Q6.

(REGEX, general string functions, and encoding redesign §6.3 are explicitly **not** in this 3-round plan. They are larger pieces of work each, to be sized once round 3 lands. Aggregates that follow the "disclose-the-underlying-multiset, verify-externally" pattern from Q6 — `COUNT`, `COUNT(DISTINCT ?x)`, `SUM`, `MIN`, `MAX`, `AVG`, plus revealed `ORDER BY` / `LIMIT` — land as small additions whenever the surrounding round permits, since they require no new circuit primitives.)

---

## 8. Open questions for Jesse

1. ~~**Float representation choice.**~~ **DECIDED (2026-05-03):** adopt IEEE 754 (XPath F&O / `noir_xpath`) throughout and delete `arith::Float`'s arithmetic. Round 2 §6.2 lands as the option-(a) variant: rewire `arith`'s type-promotion + `ArithResult` to call `noir_xpath`, delete `add_floats` / `sub_floats` / `mul_floats` / `div_floats` / `truncate*` / `encode_float` and most comparison helpers (~700 LoC removed). This forces Q7 to "no arbitrary-precision decimal compliance" — see Q7 below.
2. ~~**OPTIONAL circuit strategy.**~~ **DECIDED (2026-05-03):** collapse is safe — only one consumer of `optional_circuits[]` exists, and its migration is mechanical. Empirical check (`grep -rn "optional_circuits\|optionalCircuits" --include="*.ts" --include="*.mjs" --include="*.js" --include="*.rs"`) found:

   - **`ts.js:945-969`** — the test runner's "try circuit variants" loop. Sorts `optional_circuits` by `matched_optionals.length` descending and pushes one `circuitVariants[]` entry per element, then iterates compiling each. **This is the only external consumer.**
   - `transform/src/lib.rs:128, 2374, 2435, 2448` — internal definition + producer; not a consumer in the eviction-path sense.
   - No hits in `src/scripts/verify.ts`, the `prove` path, the snapshot test runner, the W3C analysis scripts, or anywhere else.

   **Eviction path** (originally scoped to round 3, §6.4 — **partially deferred to round 4**):

   - ~~Round 3 lands the collapse + the NOT-EXISTS primitive in the `is_matched=false` arm.~~ **Round 3 main event** (2026-05-03) ships only the single-triple ground-inner NOT EXISTS primitive (Stage 2). OPTIONAL collapse requires non-membership over a *pattern* with free positions (e.g. `OPTIONAL { ?p ex:age ?o }` introduces `?o` as inner-only) — strictly harder. See `questions/optional-collapse-pattern-non-membership.md` for the three candidate approaches and the round-4 decision needed.
   - `transform/src/lib.rs` continues to produce `Vec<OptionalCircuit>` until the round-4 decision lands. `ts.js:945-969`'s consumer **stays** in round 3.
   - The test-cleanup branch's plan to split `runTest` in `ts.js` (the agent's step 5 of 7) is unchanged — variant-iteration logic continues to be the OPTIONAL handling path until round 4's collapse ships.
3. ~~**String-witness encoding (§6.3).**~~ **DECIDED (2026-05-03):** `STRING_LEN_MAX` is **configurable in the public API** — not a hardcoded constant. The transform / circuit emitter accepts the bound as a parameter; downstream protocol deployments choose their own value for the privacy / gate-cost trade-off they want.

   Default value picked at API design time (recommended: **64**) is the value used when callers don't override; the public surface exposes both the parameter and the default.

   **TODO 1 — recursive-composition spike for length-hiding configurability.** Investigate whether Noir's recursive / composition features (`#[recursive]`, proof aggregation) can let a single outer proof aggregate over multiple inner-circuit length buckets without revealing which bucket was used. Standard recursive verification reveals the inner circuit's hash and so leaks the bucket; the spike is whether a circuit-hash-hiding aggregation pattern exists (witness encryption, commit-to-bucket, or similar). If yes, configurability becomes free of length-leak; if no, the gradient below is the fallback.

   **TODO 2 — "only-disclose-when-exceeded" gradient.** If TODO 1's spike turns out negative or expensive, design a tiered disclosure model: the default `STRING_LEN_MAX` stays the privacy-preserving floor (e.g. 64); strings within that bound disclose nothing about their length; strings *exceeding* the default require the prover to switch to a larger-bound circuit, and only that switch is observable to the verifier. This is a binary disclosure (within-default vs over), not exact-length leak. Most strings stay within default in practice, so the privacy gradient only degrades for the long tail.

   Both TODOs are *future* work — round 1's §6.3 implementation lands the configurable-bound public API with a single `STRING_LEN_MAX = 64` default, and the recursive-composition / tiered-disclosure refinements come in a later round once the spike has run.
4. ~~**Test-suite authority.**~~ **DECIDED (2026-05-03):** `ts.js` is canonical for SPARQL 1.0 pass-rate reporting. Round 1's CI wiring step targets `ts.js`. The other entry points (`test/run-sparql-tests.ts`, `test/run-snapshot-tests.ts`, `check-tests.mjs`, `analyze-*.mjs`) are not authoritative; some may be straight redundant. Tracking the broader cleanup as a living artefact at `DELETION_CANDIDATES.md` rather than scoping it to any one round, since the codebase needs broad cleanup that doesn't fit cleanly into the §7 round structure.
5. ~~**Lampe scope.**~~ **DECIDED (2026-05-03):** land plain `unconstrained` + assertion now and retrofit Lampe relations later. Round 2's §5 unconstrained primitives (`div_int`, `div_float`, `truncate` rewrites) ship with the L3 pattern (doc-comment `SAFETY PROOF` + adversarial `should_fail_with` tests, mirroring `noir_xpath::unsigned_to_string_verified` and `noir_ieee754::count_leading_zeros_u23_verified`). Lean retrofitting via Lampe is a separate later round, and only happens for primitives whose measured cost profile justifies keeping them — see the experimental-API directive in workspace memory.
6. ~~**In-circuit DISTINCT vs post-processing — strategic.**~~ **DECIDED (2026-05-03):** `COUNT(DISTINCT ?x)` ships *near-term* — but **not** by adding an in-circuit DISTINCT primitive. Instead, the design follows the workspace-level principle (memory: `feedback_zkp_no_proof_of_revealed_properties.md`):

   > Information revealed in the disclosed output must not be ZK-proven inside the circuit. The verifier checks revealed properties directly.

   Concretely: `COUNT(DISTINCT ?x)` discloses the underlying multiset of `?x` bindings (the same disclosure shape we already use for SELECT). The verifier computes `|distinct(disclosed_bindings)|` externally on the disclosed output. The circuit's only obligation is the same as for plain `SELECT` — that the disclosed multiset is the genuine evaluation against the committed credentials.

   Same logic applies to **revealed** `ORDER BY`, `LIMIT k`, `MAX`, `MIN`, etc. — the verifier checks the property externally on the disclosed output.

   **Implication for round 3.** §7 round 3 currently lists "sort proof scaffolding in `noir/lib/utils` (multiset-hash + monotone-pairs primitives), behind a `_verified`-style API" as foundation work for future aggregates. Under this principle, sort proofs are only needed for *non-revealed* orderings (e.g. proving an internal multiset has a property without revealing it). Defer the sort-proof scaffolding until a concrete non-revealed-output use case is identified; round 3's scope shrinks accordingly.
7. ~~**Support for `xsd:decimal` arbitrary precision.**~~ **DECIDED (2026-05-03):** support decimals up to *at least* what fits in the prover's field element (BN254 ~254 bits, Grumpkin ~380 bits — far more than any sensible real-world `xsd:decimal` value). True XSD-arbitrary precision (unbounded mantissa) is the stretch goal, deferred as a TODO picked up after `noir_IEEE754` is stable. A research agent has been dispatched to survey `noir-lang/awesome-noir` for existing arbitrary-precision-decimal packages; output lands at `docs/decimal-support-survey.md` on workspace `main`.

   **Strategic frame** (per Jesse, 2026-05-03): we likely need either an extension to `noir_IEEE754` (since IEEE 754-2008/2019 includes `decimal32` / `decimal64` / `decimal128` types alongside binary), or a sibling library that imports the same generic primitives `noir_IEEE754` exposes. Either way, the work follows the same patterns we've established for `binary32` / `binary64`: doc-comment annotations for codegen (per `docs/ieee754-input-prep-redesign.md`), independent extraction via `struct.pack` / `decimal.Decimal` + cross-checked, doc-comment SAFETY PROOF blocks for any `_verified` primitives.

   **Until the TODO is picked up:** the IEEE 754 path's fixed-precision bound is the operative limit. W3C tests that exercise true XSD-arbitrary precision (rare, almost none) become known-skipped; list them in the paper appendix as a deliberate scope deviation. Most real-world `xsd:decimal` values fit easily in 254 bits, so functional impact is minimal.

---

## References

- W3C, *SPARQL 1.1 Query Language (Recommendation, 21 March 2013)*. https://www.w3.org/TR/sparql11-query/
- Pérez, J., Arenas, M., Gutiérrez, C. *Semantics and Complexity of SPARQL*. ACM Transactions on Database Systems 34(3), 2009. (Compositional algebra for SPARQL; basis for §3 above.)
- W3C SPARQL Working Group, *SPARQL 1.1 Test Cases*. https://w3c.github.io/rdf-tests/sparql/
- Schmidt, M. *et al.*, *Foundations of SPARQL Query Optimisation*. ICDT 2010. (Bag-vs-set semantics for OPTIONAL/UNION; informs §3 OPTIONAL collapse.)
- W3C, *XPath and XQuery Functions and Operators 3.1*. https://www.w3.org/TR/xpath-functions/ — reference for §17.3 numeric promotion and the XSD type system used by both SPARQL 1.1 and `noir_xpath`.
