# EXISTS / NOT EXISTS — design (round 3 spike)

**Status:** spike landed for `EXISTS`. `NOT EXISTS` is documented as deferred — see §6.
**Owner:** noir-circuits + sparql-semantics agent (round 3 spike, 2026-05-03).
**References:** W3C SPARQL 1.1 [§17.4.1.5](https://www.w3.org/TR/sparql11-query/#func-filter-exists), [§18.5](https://www.w3.org/TR/sparql11-query/#sparqlAlgebraEval); Pérez–Arenas–Gutiérrez [PAG] §3.2 (compatibility of mappings); SPARQL_ROADMAP.md §3 (gap analysis), §6.4 (OPTIONAL collapse depends on this), §7 round 3.

## 1. Background

`FILTER(EXISTS { P })` over an outer mapping μ evaluates to **true** iff there exists at least one solution mapping μ' for the inner pattern `P` such that μ and μ' are compatible (PAG §3.2: agree on every shared variable). `FILTER(NOT EXISTS { P })` is `Not(Exists(P))` and evaluates to true iff no such μ' exists.

The same primitive is the load-bearing component of:
- `MINUS` (W3C §15.4 / §18.5: equivalent to `Filter(NOT EXISTS)` with the freshness condition on inner variables).
- `OPTIONAL` collapse (SPARQL_ROADMAP.md §6.4): the unmatched arm of `LeftJoin` must prove that no compatible inner binding exists, i.e. exactly `NOT EXISTS` over the inner pattern.

## 2. Witness shape — EXISTS

**Reformulation: witness-supplied compatibility, lowered into the outer BGP.**

Given `FILTER(EXISTS { P })` with inner pattern `P` containing triple patterns `t_1, …, t_k` and inner-only variables `v_1, …, v_m` (variables that do not appear in the outer pattern), we lower as follows:

1. Append each `t_i` as an additional triple in the outer BGP, with the standard inclusion / signature checks.
2. Inner-only variables `v_j` become **hidden bindings**: they appear in `Variables` neither for projection nor as outputs; they exist only as positional references `bgp[outer_n + i].terms[j]` and within unification assertions.
3. Variables shared with the outer mapping unify with the existing bindings via the same "seen-vars → variable assertion" path that `Join` already uses (`lower::process_patterns`).
4. The `FILTER(EXISTS { P })` expression itself reduces to `assert(true)` in the emit layer — the inclusion checks on the appended triples and the unification assertions are the proof.

This is sound because: a witness exists iff the prover can supply a Merkle inclusion proof for each `t_i` whose terms unify with μ. If no such μ' exists, the prover cannot satisfy the inclusion + unification constraints simultaneously, so the proof fails to verify.

### 2.1 Why this is the canonical EXISTS reformulation

Per W3C §18.5, `Filter(F, P)` over solution multiset Ω = ⟦P⟧_D returns the multiset { μ ∈ Ω | F(μ) = true }. With F = `EXISTS{P'}`, F(μ) = true iff there exists μ' ∈ ⟦P'⟧_D compatible with μ. The prover-aided reformulation is: prover supplies μ' alongside μ; circuit verifies μ' ∈ ⟦P'⟧_D (via the same per-triple inclusion + sig checks the outer pattern uses) and that μ ∼ μ' (compatibility on shared variables, via unification). This is identical in shape to a `Join` of the outer pattern with the inner pattern, except the inner-only variables are not exposed in the projection.

Concretely, this reformulation is **W3C-equivalent up to projection** to:
```
Project(outer_vars, Filter(true, Join(P_outer, P_inner)))
```
which is exactly `EXISTS`'s contribution to `[[Filter(EXISTS{P}, P_outer)]]_D` per PAG §3.2.

### 2.2 Disclosure / privacy implication

Inner-only variables `v_j` are **not** in `Variables` and so are not exposed to the verifier. They are also **renamed** at lowering time to fresh `__exists_<orig>_<id>` identifiers, so they cannot collide with outer-scope variables nor with another EXISTS block's variables of the same source name. This matters because the projection-stripping step in `process_query` (`!v.starts_with("__")`, lower.rs ~L785) would otherwise leak an inner-only name into the result if it happened to share a name with an outer-projected variable.

The **structure of the inner pattern is public** (it appears in `metadata.json` exactly as the outer triples do — it has to, so the verifier knows what shape the inclusion proofs are checking). This is the same disclosure level as the outer BGP. There is no additional privacy leakage beyond "the existence query was over this shape of pattern".

### 2.3 Outer-pattern restrictions

The flattening reformulation requires `info.bindings` to reflect the outer scope's full binding environment. This holds when the outer pattern is a BGP / Join / Filter / Extend / Graph / Path / OPTIONAL chain — they all populate `bindings` directly. It **fails for `Union`**, which yields a `PatternInfo` with `union_branches: Some(_)` and an empty top-level `bindings` (each branch owns its own bindings). EXISTS over a UNION outer is therefore rejected at lowering with a clear error pointing to this section. Per-branch EXISTS lowering is the right fix and is round-3-main-event scope; the spike's narrow rejection is the safer behaviour.

### 2.4 Cost

For an inner pattern of `k` triples:
- `k` additional `Triple` slots in `BGP`, each carrying a Merkle path.
- `k × MERKLE_DEPTH` Pedersen-hash gates from `verify_inclusion` (the existing per-outer-triple cost).
- `O(k + m)` field-equality assertions for unification / position binding.

This is the **same per-triple cost** as a regular outer BGP triple. EXISTS is essentially free relative to its inner pattern's BGP cost — there is no separate "EXISTS-overhead" in the constraint count.

For our `basic_exists` representative fixture (`SELECT ?s WHERE { ?s ex:knows ?o . FILTER(EXISTS { ?o ex:age ?age . }) }`): outer BGP has 1 triple; inner has 1 triple; total = 2 triples (≈ 2 × MERKLE_DEPTH Pedersen-hash gates from inclusion + 6 field-equality assertions for term-position bindings).

## 3. Witness shape — NOT EXISTS

`FILTER(NOT EXISTS { P })` requires proving non-existence: there is **no** compatible μ' with the inner pattern `P` against the committed dataset. This is fundamentally harder.

### 3.1 Three approaches considered

| Approach | Witness shape | Sound? | Cost | Verdict |
|---|---|---|---|---|
| (a) Bounded enumeration over candidate μ' | One slot per possible inner-binding combination; each slot proves either incompatibility-with-μ or non-membership-in-graph | Sound iff candidate set is exhaustive | `\|graph\|^m` worst-case for `m` inner-only vars; tractable only when `m = 0` (fully ground inner) | Doesn't scale |
| (b) Sorted-commitment non-membership | Prover supplies the two leaves immediately to the left and right (in canonical sort order) of the would-be inner triple's hash; inclusion proof for both, plus ordering assertion | Sound | `O(k × MERKLE_DEPTH)` — same as EXISTS | **Requires changing the dataset commitment to a sorted Merkle tree** |
| (c) Disclose-the-graph-fragment | Prover discloses the relevant inner-pattern projection of the graph; verifier checks absence externally | Sound but reveals graph fragment | Free | Violates ZK over the inner pattern's IRIs |

### 3.2 Why approach (a) doesn't fit

Bounded enumeration only works when the inner pattern's free variables are all bound by the outer mapping (`m = 0`) — otherwise the candidate set is `|graph|^m` and grows with the dataset. Even when `m = 0`, the inner pattern reduces to "is this specific triple in the graph?", which is **non-membership over a (currently unsorted) Merkle commitment** — i.e. exactly approach (b).

### 3.3 Why approach (b) is the right round-3-main-event scope

Sorted-commitment non-membership is the textbook ZK approach (cf. Merkle-Patricia trees / sparse Merkle trees with neighbouring-leaf proofs). For our setting:

- The dataset's `merkle()` builder in `noir/lib/utils/src/lib.nr` (~L41) currently inserts triples in supplied order and pads with zeros — not sorted.
- Adopting a sorted tree means: at sign time, sort the triples by `consts::hash4` of their term tuple; build the Merkle tree over the sorted leaves; the signature commits to the sorted root.
- At prove time, for `FILTER(NOT EXISTS { P })`: prover computes the would-be hash `h* = consts::hash4(t_inner_with_μ_substituted)`, discloses the two adjacent leaves `h_left, h_right` such that `h_left < h* < h_right`, supplies inclusion proofs for both, and asserts ordering. The verifier checks the chain.
- Cost per inner triple: `2 × MERKLE_DEPTH` Pedersen-hash gates + 2 field-comparisons. About 2× the EXISTS cost — well within tolerable.

This is a substantial dataset-commitment redesign (sort at sign time, validate sortedness in `verify_inclusion` or at root-construction time) and **is the right scope for the round 3 main event**. It is too much for a spike.

### 3.4 Why approach (c) is rejected

Approach (c) violates the workspace-level rule from `feedback_zkp_no_proof_of_revealed_properties.md`: information *not* in the disclosed result must not leak through the proof. The boolean output of `NOT EXISTS` is *consumed* in the FILTER (it gates the row) — it isn't itself disclosed in the SELECT result. So the underlying graph fragment that would be disclosed under approach (c) is genuinely additional disclosure beyond what the row's bindings reveal. Reject.

## 4. Spike scope — what shipped

This spike ships **EXISTS only**, via the §2 reformulation. NOT EXISTS is rejected at the lowering layer with a clear error message pointing to this document.

Concretely:

- `transform/src/lower.rs::lower_filter_exists` walks each `Filter { expr, inner }` after lowering `inner`, descends into the expression, and replaces `Expression::Exists(P)` with the lowered inner pattern's triples / bindings appended to the outer pattern. The expression node itself collapses to `Expression::Literal("true"^^xsd:boolean)`.
- `Expression::Not(Expression::Exists(_))` is detected at the same point and produces an explicit error: `"NOT EXISTS is not yet implemented — see spec/exists.md §3 for the deferred sorted-commitment design"`.
- The emit layer is **unchanged**: the appended triples flow through `process_patterns` exactly like outer triples. The metadata exposes them as additional `inputPatterns` entries.

## 5. Soundness argument — EXISTS

**Claim.** For an outer pattern `P_o` and inner pattern `P_i = { t_1, …, t_k }` with inner-only variables `v_1, …, v_m`, the lowered circuit accepts a witness `(bgp, variables)` iff there exists μ ∈ ⟦P_o⟧_D and μ' ∈ ⟦P_i⟧_D with μ ∼ μ' (compatible on shared variables), where μ projects to `variables`.

**Proof sketch.**
- **Soundness (⇒).** If the circuit accepts, then for each `t_i ∈ P_i` the Merkle-inclusion check `verify_inclusion(bgp[outer_n + i - 1], roots[0].value)` succeeds. By the inclusion-check soundness (Merkle commitment binding under the hash collision-resistance assumption), `bgp[outer_n + i - 1].terms` is one of the committed triples, so `t_i` (with the substitution implied by the position-binding assertions) is in `D`. The set of substitutions on inner-only and shared variables is exactly μ'; the position-binding assertions (`bgp[i].terms[j] == variables.x` for shared `x`) enforce μ ∼ μ'. So a compatible μ' ∈ ⟦P_i⟧_D exists.
- **Completeness (⇐).** If such μ, μ' exist, the prover supplies μ' as the additional `bgp` entries with their committed Merkle paths and the corresponding hidden inner-only-variable bindings. All inclusion + unification assertions trivially pass.

The argument reuses existing `verify_inclusion` soundness — the EXISTS primitive adds no new cryptographic assumption. The only new bit is the *flattening* rewrite, which is a syntactic transformation: it has no security parameter of its own.

**Note on bag semantics (Schmidt et al. 2010).** EXISTS evaluates over multiset semantics, but it's a *boolean* function of μ and `D`, so per-row multiplicity in the inner pattern doesn't affect the truth value. The reformulation cleanly preserves bag semantics: each μ's row in the result is independently checked; the inner-pattern binding μ' is per-row witness and is not aggregated.

## 6. Roadmap consequences

- **EXISTS:** ✓ shipped this spike.
- **NOT EXISTS:** deferred until the dataset commitment is upgraded to a sorted Merkle tree (approach b above). This is the right scope for the round-3 main event — likely 3–5 days for the sign-time sorting + commitment shape change + non-membership primitive in `noir/lib/utils`, plus the lowering update to use it.
- **MINUS:** blocked on NOT EXISTS. Once NOT EXISTS lands, MINUS is a 1-day rewrite at the algebra level (`Minus(P_o, P_i)` → `Filter(NOT EXISTS{P_i}, P_o)` per W3C §18.5 modulo the freshness side-condition).
- **OPTIONAL collapse (§6.4):** blocked on NOT EXISTS. The unmatched arm needs the same primitive.
- **Subqueries:** *not* blocked on NOT EXISTS. They're an independent piece of work involving inner SELECT scope plumbing.

## 7. Open questions

1. **Inner-pattern fresh-variable hashing.** In §2 the inner-only variables `v_j` aren't named in `Variables` but the verifier still needs to know they're inner-only. Currently this is implicit — they're variables that lower::process_patterns binds but `process_query` doesn't project. Is that contract clear enough, or should the metadata explicitly mark inner-only variables for verifier confidence? **Provisionally: leave implicit until the test-runner needs them named.**

2. **Nested EXISTS.** `FILTER(EXISTS { ?s ex:p ?o . FILTER(EXISTS { ?o ex:q ?r }) })` should recurse cleanly under §2's flattening. The current spike implementation handles this via recursive lowering — see `lower_filter_exists` test fixture `nested_exists` (TODO: not in this spike — single-level only). **Provisional: single-level EXISTS only in the spike; nested EXISTS rejected with a clear error and added to the round-3-main-event scope.** *Update — this spike shipped single-level only; nested is a small follow-up.*

3. **EXISTS inside nested boolean expressions.** `FILTER(?x = 1 || EXISTS{...})` requires lowering the EXISTS into the BGP unconditionally (otherwise the OR's truth depends on the BGP shape, which is fixed at circuit generation), but then conditionally including its contribution to the assertion. **Provisional: reject EXISTS-not-at-FILTER-root in this spike; the lowering only handles `FILTER(EXISTS{P})` and `FILTER(... && EXISTS{P} && ...)` flattenable conjunctions.** *Update — this spike accepts EXISTS only when the filter expression is exactly `EXISTS{P}` (no nesting under `And` / `Or` / `Not`). Conjunctions that include EXISTS will land alongside the round-3-main-event when the W3C `exists` test suite is wired in.*

## 8. References

- W3C SPARQL 1.1 §17.4.1.5 (FILTER EXISTS): https://www.w3.org/TR/sparql11-query/#func-filter-exists
- W3C SPARQL 1.1 §18.5 (Algebra evaluation, including LeftJoin / Minus / Filter): https://www.w3.org/TR/sparql11-query/#sparqlAlgebraEval
- Pérez J., Arenas M., Gutiérrez C., *Semantics and Complexity of SPARQL*, ACM TODS 34(3), 2009, §3.2.
- Schmidt M. et al., *Foundations of SPARQL Query Optimization*, ICDT 2010 (multiset semantics).
- SPARQL_ROADMAP.md §3, §6.4, §7 (round 3).
- `feedback_zkp_no_proof_of_revealed_properties.md` (workspace memory — the rule that motivates §3.4).
