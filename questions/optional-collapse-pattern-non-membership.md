# OPTIONAL collapse — non-membership over a *pattern* with free positions

**Status:** open question. Round-3 main event landed Stages 1–3 (sorted commitment, `verify_non_membership_no_inclusion`, NOT EXISTS / MINUS for **single-triple ground-inner** patterns). Stage 4 (OPTIONAL collapse) is **deferred** because it requires a strictly harder primitive than Stage 2 ships.

**Owner:** noir-circuits + sparql-semantics agent (round 3 main event, 2026-05-03).
**Blocking:** §7 round 3 "OPTIONAL collapse" item; eviction of `optional_circuits[]` from `transform/src/lib.rs` and the `ts.js:945-969` consumer.

## 1. Why Stage 2's NOT EXISTS does not unlock Stage 4

Stage 2 lowers `FILTER(NOT EXISTS { t })` to a `NonExistenceConstraint` only when the inner triple `t` is **fully ground after substituting the outer μ** — every position in `t` is either a constant or a variable already bound by the outer scope. The lowered absent hash is a single `consts::hash4(absent_terms)`, and the prover supplies one `(left, right)` adjacent-leaf pair per constraint.

OPTIONAL, by contrast, introduces *new* variables in the inner pattern. The canonical case:

```sparql
SELECT ?s ?o WHERE {
  ?s ex:knows ?p .
  OPTIONAL { ?p ex:age ?o . }
}
```

Here `?o` is inner-only (introduced by the OPTIONAL). The unmatched arm of a sound OPTIONAL collapse must witness: "for the outer μ — which fixes `?s`, `?p` — there is **no** binding of `?o` such that `(μ(?p), ex:age, ?o, default_graph)` is in the dataset". This is non-membership of a *pattern* (3 positions fixed, 1 position free), not a single concrete triple.

A per-substitution single-triple non-membership proof would require iterating over every possible value of `?o` — i.e. the entire codomain of the hash function. This is intractable.

## 2. Three approaches considered

### 2.1 Disclose the absent positions and verify externally (rejected)

Have the prover disclose `(μ(?s), μ(?p), ex:age, default_graph)` and let the verifier check absence externally against an authoritative dataset listing.

**Verdict.** Violates `feedback_zkp_no_proof_of_revealed_properties.md` only when applied to revealed query outputs. Since the OPTIONAL's truth is *consumed* (gates `?o`'s presence in the row) rather than itself disclosed, this approach genuinely leaks the predicate-set membership of the outer-bound terms — which is additional information beyond what the SELECT discloses. **Reject** (same reasoning as `spec/exists.md` §3.4 for NOT EXISTS).

### 2.2 Multi-position sparse Merkle tree indexed by triple-prefix

Build a *second* Merkle commitment indexed by triple-prefixes `(s, p, *, g)` so non-membership of any three-position prefix can be witnessed by adjacent-leaf bracketing in the prefix index.

- The signer builds two trees: the existing leaf-hash sorted tree (`hash4(s,p,o,g)`) plus a **prefix tree** keyed by `hash3(s, p, g)` whose leaves are `hash4(s, p, o, g)` of the o-position binding.
- "No `?o` matches `(s, p, _, g)`" reduces to "the prefix `hash3(s, p, g)` is absent from the prefix tree" — Stage 2's primitive applied to the prefix tree.

**Cost.** Doubles signing-time work and dataset size. Adds one new sorted-tree primitive (the prefix tree) and one new commitment (separate signed root). Cleanly composable with the existing design.

**Generalisation.** SPARQL OPTIONAL inner patterns can have multiple free positions. The general case needs `2^4 = 16` prefix trees (one per subset of `{s, p, o, g}` to leave free), or a single recursive tree variant. This is a substantial commitment redesign.

**Verdict.** Sound and tractable, but a meaningful chunk of additional work and disclosure (the prover discloses *which* prefix-tree it's witnessing absence in, which leaks "how many positions of the inner pattern were already constrained"). Worth doing for round 4 main event; out of scope for round 3.

### 2.3 In-circuit enumeration over a bounded `?o` codomain

Enumerate every triple in the BGP and prove none of them shares `(s, p, _, g)` with the OPTIONAL inner. Sound when the prover can witness *every* leaf of the dataset, but the cost is `O(N)` per OPTIONAL — far worse than the leaf-hash sorted tree's `O(MERKLE_DEPTH)`.

**Verdict.** Doesn't scale. Reject.

## 3. Decision required from Jesse

**Q1: Take approach 2.2 in round 4?** Adopt prefix-tree commitments alongside the leaf-hash tree. Adds signing-time cost and a small disclosure (which prefix) but cleanly unlocks OPTIONAL collapse + multi-triple NOT EXISTS + general-shape MINUS.

**Q2: Punt OPTIONAL collapse indefinitely?** Keep the `2^n` power-set generation with the round-2 `optional_cap` guard and accept the variant blow-up as the price of sound semantics. `optional_circuits[]` and `ts.js:945-969`'s consumer stay; round-3's collapse goal is unmet.

**Q3: Adopt a tiered approach?** Single-triple OPTIONAL collapses via Stage 2's primitive (so the OPTIONAL inner must be ground-inner — narrows the supported queries but yields a single-circuit shape for those queries); multi-triple OPTIONAL stays on the power-set path. This is a partial collapse and unblocks the common cases at the cost of a more complex transform (two emission paths).

**Recommendation.** Q3 (tiered). Round-3-main-event delivers a partial collapse for the easy cases (every OPTIONAL whose inner pattern is single-triple ground-inner against the outer μ). Multi-triple OPTIONAL keeps the power-set strategy until round 4 ships approach 2.2.

## 4. What landed in round 3 anyway

Round 3 main event ships Stages 1–3 (sorted commitment + `verify_non_membership_no_inclusion` + NOT EXISTS + MINUS) without OPTIONAL collapse. The `optional_circuits[]` eviction stays open. `SPARQL_ROADMAP.md` §7 is updated to reflect this.

The Stage 4 implementation work (transform-side dispatch on OPTIONAL inner shape, single-block collapse for the easy case) is sized at ~1–2 days once the decision lands.

## 5. References

- W3C SPARQL 1.1 §18.5 (LeftJoin / Minus algebra evaluation): https://www.w3.org/TR/sparql11-query/#sparqlAlgebraEval
- `spec/exists.md` §3 (sorted-commitment design), §4 (round-3 delivery), §7 (open questions).
- `SPARQL_ROADMAP.md` §6.4 (OPTIONAL collapse rationale), §7 round 3, §8.2 (Q.A.2 eviction-path).
- Pérez J., Arenas M., Gutiérrez C., *Semantics and Complexity of SPARQL*, ACM TODS 34(3), 2009.
- Schmidt M. et al., *Foundations of SPARQL Query Optimisation*, ICDT 2010 (multiset semantics for OPTIONAL).
