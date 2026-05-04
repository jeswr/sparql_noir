# Prefix-tree commitment (rounds 4 + 5 + 6)

**Status:** **shipped end-to-end** -- round 4 (commitment scaffolding + prefix-3 primitive), round 5 (transform-side dispatch + two-root signer ABI), and round 6 (runtime glue: signer issues two signatures, prover populates `bgp_prefix3` / sentinels / boundary cases against the live binding). The prefix-3 commitment is wired end-to-end for `NOT EXISTS` / `MINUS` / OPTIONAL collapse over single-triple inner patterns with one inner-only `o` position. Other 15 prefix variants follow the same template; land as new query classes call for them.
**Owner:** noir-circuits + sparql-semantics agents (round 4 branch `prefix-tree-commitment-round4`; round 5 branch `prefix-tree-transform-dispatch`; round 6 branch `prefix-tree-runtime-glue`).
**References:** `spec/exists.md` Sec.3.3 / Sec.6 (round-3 OPTIONAL collapse punt); `decisions/non-membership-sentinels-transform-wiring.md` (Approach A locked in for round 4); `paper/PLAN.md` Sec.4.3 (prefix-tree commitment claims); `feedback_modular_commitment_signature_design.md` (modular commitment-shape directive).

## 1. Background

The **leaf-hash sorted Merkle commitment** in `noir::utils::merkle` (`spec/exists.md` Sec.3.3) keys leaves on `consts::hash4(s, p, o, g)` and supports non-membership proofs against an *exact* would-be quad (`absent_hash` is the hash of a fully-ground 4-tuple). This is sufficient for **single-triple ground-inner** `NOT EXISTS` and `MINUS` (round 3 main event).

It is **not** sufficient for:

- **Multi-triple `NOT EXISTS { t_1 . t_2 . ... }`** with shared inner-only variables. The pattern of triples can be absent without any individual triple being absent.
- **OPTIONAL collapse over patterns with free positions** — `OPTIONAL { ?p ex:age ?o }` introduces `?o` as inner-only; the unmatched arm requires "no `(?p, ex:age, ?, g)` exists in the dataset", a non-membership over a *prefix* of the quad space, not a fully-ground quad.
- **`MINUS` over `UNION`** — same shape: the unmatched-by-every-branch condition is a multi-prefix non-membership.

Round 4 unlocks these by committing a **second tree, keyed by a prefix of the quad's positions**. Soundness of "no `(s, p, ?, g)` exists" reduces to non-membership of the prefix `(s, p, g)` in the prefix-3 tree, i.e. the same two-leaf bracketing argument the round-3 sorted-leaf primitive already uses, but in the prefix-key space.

## 2. Design — prefix-3 (proof of concept)

Round 4 ships the **prefix-3** variant: prefix key = `hash3(s, p, g)`, free position = `o`. This is the smallest non-trivial case (single free position, single fixed-graph fixed-subject-predicate prefix) and is sufficient to unlock `OPTIONAL { ?p ex:age ?o }` collapse over a fixed graph with bound `?p`. The general prefix-N variant (for N free positions) follows the same pattern; see Sec.7 for the generalisation path.

### 2.1 Tree shape

Alongside the leaf-hash sorted tree (`tree_4` keyed on `hash4(s, p, o, g)`), the signer builds a **prefix-3 sorted tree** (`tree_3sp_g`, keyed on `hash3(s, p, g)` — i.e. drop position `o`). Both trees commit to the same dataset:

| Tree | Leaf-hash | Sorted by | Purpose |
|---|---|---|---|
| `tree_4` | `hash4(s, p, o, g)` | leaf-hash ascending | per-quad inclusion / non-inclusion (round 3) |
| `tree_3sp_g` | `hash3(s, p, g)` | leaf-hash ascending, deduplicated | per-`(s, p, g)`-prefix non-inclusion (round 4) |

`tree_3sp_g`'s leaves are **deduplicated** at sign time: if multiple quads share the same `(s, p, g)` prefix (which happens whenever the dataset has more than one object value for the same subject-predicate-graph triple), only one leaf is emitted. Without deduplication, the sorted tree would have adjacent equal-hash leaves at every multi-`o` `(s, p, g)` prefix, and non-membership at a present prefix's neighbour would still pass the strict-`<` check — soundness intact, but witness shape ambiguous. Deduplication keeps the tree's `(left, right)` adjacency proof unambiguous.

The signer commits to **both roots** in the same signature payload: `(root_4, root_3sp_g)` is the signed message. The verifier learns both roots; circuits check inclusion / non-inclusion against whichever root the SPARQL operator dispatches to.

### 2.2 `hash3` definition

We define `hash3(s, p, g) := consts::hash4([s, p, g, PREFIX3_SP_G_DOMAIN_SEPARATOR])` where `PREFIX3_SP_G_DOMAIN_SEPARATOR` is a fixed BN254 field constant chosen by the protocol (e.g. `0x70726566697833 = "prefix3"` ASCII-packed). This re-uses the existing `hash4` Pedersen primitive — no new hash gates, no new cryptographic assumption — and the domain-separator prevents cross-tree collision (a `hash3(s, p, g)` value in `tree_3sp_g` cannot be confused with a `hash4(s, p, o, g)` value in `tree_4`, even if some adversarial choice of `o == DOMAIN_SEPARATOR` were attempted, because the position layout differs).

### 2.3 Sentinels

`tree_3sp_g` carries the **same low / high sentinel pair** as the leaf-hash sorted tree, with hashes `consts::LOW_SENTINEL_HASH = 0` and `consts::HIGH_SENTINEL_HASH = p - 1`. Same order-statistic argument applies (boundary-falling absent prefixes need explicit bracketing); same `verify_low_sentinel_inclusion` / `verify_high_sentinel_inclusion` primitives apply (sentinel hashes are ABI-fixed, not derived from any triple).

The **ABI for `tree_3sp_g` sentinels is shared** with `tree_4`'s — both trees use the same `consts::LOW_SENTINEL_HASH` / `consts::HIGH_SENTINEL_HASH` constants. This is safe because the trees have separate roots; the constants distinguish "boundary leaf in this tree" not "boundary leaf in any tree".

### 2.4 Sentinel boundary cases

Identical three-case structure to round 3:

| Boundary case | Bracketing | Primitive |
|---|---|---|
| `Lower` (0) | low sentinel, smallest real prefix | `verify_non_membership_prefix3_low_sentinel_no_inclusion` |
| `Middle` (1) | two adjacent real prefix leaves | `verify_non_membership_prefix3_no_inclusion` |
| `Upper` (2) | largest real prefix, high sentinel | `verify_non_membership_prefix3_high_sentinel_no_inclusion` |

Same runtime-dispatch convention as `decisions/non-membership-sentinels-transform-wiring.md` Approach A: a single circuit, gated on a public `boundary_case` field per constraint. The transform layer's dispatch wiring (Sec.6) is structurally identical to the round-3 wiring — just dispatching against `tree_3sp_g`'s root instead of `tree_4`'s.

## 3. Witness shape

For `NOT EXISTS { ?p ex:age ?o }` (graph fixed, `?p` bound by outer mapping, `?o` inner-only):

1. The transform substitutes outer bindings: prefix `(?p_value, ex:age, default_graph)` is now ground in the three positions covered by `tree_3sp_g`.
2. Prover computes `absent_prefix_hash := hash3(?p_value, ex:age, default_graph)`.
3. Prover supplies one of:
   - **Middle case:** two adjacent `tree_3sp_g` leaves `(left_prefix, right_prefix)` with inclusion paths to `root_3sp_g`, and the boundary-case tag `1`.
   - **Lower case:** the low sentinel + smallest real prefix leaf; tag `0`.
   - **Upper case:** the largest real prefix + the high sentinel; tag `2`.
4. Circuit calls the corresponding `verify_non_membership_prefix3_*` primitive against `root_3sp_g`.
5. **No additional inner-pattern triples in `bgp`** — the prefix-tree absence proof short-circuits the per-triple inclusion path that round 3's `NonExistenceConstraint` uses.

Witness shape parallels round 3 exactly:

| Round | Bracket leaves | Absent value | Root |
|---|---|---|---|
| 3 (leaf-hash) | `(left_quad, right_quad)` Triples | `hash4(s, p, o, g)` | `root_4` |
| 4 (prefix-3) | `(left_prefix, right_prefix)` PrefixTriples | `hash3(s, p, g)` | `root_3sp_g` |

The new `PrefixTriple` type (in `noir::types`) carries `terms: [Field; 3]`, `path`, `directions` — same shape as `Triple` but with three terms instead of four. We keep it as a separate type rather than reusing `Triple` so the type system enforces the prefix vs full-quad distinction at the call site.

## 4. Soundness argument

**Claim.** If the prover supplies a valid `verify_non_membership_prefix3_*` proof for `absent_prefix_hash := hash3(s*, p*, g*)` against `root_3sp_g`, then **no quad with prefix `(s*, p*, g*)` is in the committed dataset** — i.e. for every `o`, `(s*, p*, o, g*) ∉ D`.

**Proof.**

1. **Tree binding.** `tree_3sp_g` is a deterministic function of the dataset `D`: build the multiset `{ hash3(s, p, g) : (s, p, o, g) ∈ D }`, deduplicate, sort, sentinel-bracket, build the Merkle tree. The signer's signature commits to `root_3sp_g`. By Pedersen-hash collision-resistance, no efficient adversary can produce a different leaf set with the same root.
2. **Bracketing implies non-membership in the prefix tree.** Following the round-3 sorted-leaf argument (`spec/exists.md` Sec.3.3): if `left.path[0] < absent_prefix_hash < right.path[0]` and `right_idx == left_idx + 1`, then `absent_prefix_hash` cannot equal any leaf in `tree_3sp_g`. (Same applies to the sentinel boundary cases, with the sentinel as one of the brackets.)
3. **Non-membership in the prefix tree implies prefix non-membership in the dataset.** By construction, `tree_3sp_g`'s leaves are `{ hash3(s, p, g) : (s, p, o, g) ∈ D }` (after deduplication). If `hash3(s*, p*, g*)` is not a leaf, then by Pedersen collision-resistance no `(s, p, g)` triple in `D` hashes to `hash3(s*, p*, g*)`, which (under the same collision-resistance assumption applied to `hash3` = domain-separated `hash4`) means no `(s, p, g)` triple equals `(s*, p*, g*)`. So no quad `(s*, p*, o, g*)` for any `o` is in `D`.

**Soundness reduces to** Pedersen-hash collision-resistance (already assumed for `tree_4`) + the round-3 sorted-leaf bracketing argument applied to a different keying. No new cryptographic assumption.

**Subtlety — deduplication is part of the binding.** Step 3 relies on `tree_3sp_g`'s leaf set being exactly `{ hash3(s, p, g) : (s, p, o, g) ∈ D }`. If the signer omits a real prefix from `tree_3sp_g` (deduplicates incorrectly, or simply misses one), an honest verifier would accept a non-membership proof for a prefix that *is* in the dataset — soundness break. Mitigation: the signer's circuit (`bin/signature/`) includes an assertion that every quad in the dataset has its `hash3` prefix present in `tree_3sp_g`'s leaf set. This is an `O(|D|^2)` cross-check at sign time but is one-shot per dataset; tractable. Documented as a follow-up assertion.

## 5. Disclosure

The verifier learns:

- **Both roots** `(root_4, root_3sp_g)` — same disclosure level as round 3's single root.
- **Which prefix tree the prover witnessed absence in** — for prefix-3, this is "the `(s, p, g)`-prefix tree, i.e. `o` is the inner-only position". The verifier learns the **subset of quad positions** that the inner pattern's free positions cover. This is **already public**: the SPARQL query text (and metadata.json) names the variables, and the transform layer's emit step lists which positions are inner-only. So this is no additional disclosure.
- **Each bracket leaf's `hash3(s, p, g)` value** — the two prefix hashes adjacent to the absent prefix. These are committed leaves (anyone who observed many proofs against the same dataset could correlate brackets across queries to learn the prefix multiset structure). Same disclosure shape as round 3's leaf-hash bracket leaves.

**No additional information beyond the round-3 disclosure shape**, except the second root — which is itself a one-time per-dataset constant.

## 6. Cost

### 6.1 Sign time

Per dataset of `N` quads:

| Cost | Round 3 (leaf-hash only) | Round 4 (leaf-hash + prefix-3) |
|---|---|---|
| Tree builds | 1× | 2× |
| Tree-level hash gates | `(N + 2)` Pedersen × `MERKLE_DEPTH` | `(N + 2 + N_3 + 2)` × `MERKLE_DEPTH` |
| Leaf hashes | `N × hash4` | `N × hash4 + N_3 × hash4` (the `hash3 = hash4 ∘ pad` re-uses the same primitive) |
| Sort | `O(N²)` insertion | `O(N²)` × 2 |
| Cross-check (Sec.4) | none | `O(N²)` set-membership check |

where `N_3 = |{ (s, p, g) : (s, p, o, g) ∈ D }|` (number of distinct prefixes; `N_3 ≤ N`).

Worst case (every quad has a unique prefix): roughly **2× sign-time work and 2× tree-storage**. Best case (every quad shares a prefix with all others, e.g. a single subject's many object values): `N_3 = 1`, so the prefix tree is degenerate but still useful.

### 6.2 Prove time

Per `NOT EXISTS` constraint over a prefix:

| Round 3 (single-triple ground) | Round 4 (prefix-3 absence) |
|---|---|
| 2 × Triple inclusion (`hash4 + hash2 × MERKLE_DEPTH`) | 2 × PrefixTriple inclusion (`hash3 + hash2 × MERKLE_DEPTH`) |
| Strict `<` × 2 | Strict `<` × 2 |
| Index reconstruction | Index reconstruction |

**Same per-constraint cost** as round 3's `NotExists` lowering. The round-4 unlock is purely an **expressivity** lift, not a cost lift, for the constraint itself.

### 6.3 Dataset size

The signer's commitment now includes **two roots**, increasing the signed payload from 32 bytes to 64 bytes. Tree storage doubles in the worst case. For deployments where prefix-tree functionality isn't needed, the signer can omit `tree_3sp_g` and emit a sentinel `root_3sp_g = 0` — any prover attempting a prefix-tree non-membership proof will fail because the genuine tree-build hash won't equal `0`.

## 7. Generalisation path: prefix-N variants

The prefix-3 case (drop `o`) is one of `2^4 = 16` possible prefix subsets over a quad. The general "prefix-tree commitment" of `paper/PLAN.md` Sec.4.3 covers all 16:

| Subset of fixed positions | Tree | Use case |
|---|---|---|
| `{s, p, o, g}` | `tree_4` | round 3 — exact-quad non-membership |
| `{s, p, g}` | `tree_3sp_g` | **round 4 — `OPTIONAL { ?p ex:age ?o }`** |
| `{s, p}` | `tree_2sp` | `NOT EXISTS { ?p ex:age ?o GRAPH ?g }` over any graph |
| `{p, o}` | `tree_2po` | "no quad with this predicate-object pair anywhere" |
| `{s}` | `tree_1s` | "subject doesn't appear in dataset" |
| ... (12 more) | ... | various |

Adding a new prefix variant is mechanical:

1. New `hash_<subset>` helper, domain-separated against the others.
2. New `merkle_<subset>` builder reusing the leaf-sort + sentinel-pad pattern.
3. New `verify_non_membership_<subset>_*` primitive set (interior + low/high boundary).
4. New `PrefixTriple<K>` type with `terms: [Field; K]`.
5. Signer adds the new tree to the signed payload (root list grows).
6. Transform layer adds dispatch into the new primitive set when the constraint shape calls for it.

**Round 4 ships only the prefix-3 (`{s, p, g}`) variant.** It is the highest-impact subset (covers OPTIONAL collapse, MINUS-over-UNION, multi-triple `NOT EXISTS` with shared `?g`) and validates the design pattern. The other 15 variants land as needed in subsequent rounds, when concrete query classes call for them. Per the modular-commitment directive (`feedback_modular_commitment_signature_design.md`), each variant must justify itself by enabling a query class the others don't.

## 8. Transform-side dispatch (shipped — round 5)

Round 5 wires prefix-tree non-membership into `transform/src/lower.rs` / `emit.rs`. The shape below describes what shipped; the prefix-3 (`(s, p, g)`) variant is end-to-end and other prefix variants land via the same hooks.

### 8.1 IR (shipped)

`transform/src/ir.rs` carries the new types:

```rust
pub enum PrefixKind { Prefix3SpG /* + 15 future variants */ }

pub struct PrefixNonExistenceConstraint {
    pub prefix_kind: PrefixKind,
    pub bracket_left_idx: usize,    // index into bgp_prefix3
    pub bracket_right_idx: usize,   // index into bgp_prefix3
    pub absent_terms: [Term; 4],    // s, p, o, g; the o slot is unused for hashing
}

pub struct EasyOptional {
    /* round-3 fields ... */
    pub prefix_kind: Option<PrefixKind>,  // Some(...) for prefix-tree collapses
}

pub struct PatternInfo {
    /* ... */
    pub prefix_not_exists: Vec<PrefixNonExistenceConstraint>,
    pub bgp_prefix3_len: usize,           // total prefix-3 slots allocated
}
```

`bgp_prefix3` is a **separate slot array** from `bgp` -- prefix-3 brackets are typed `PrefixTriple3` (three terms), inclusion-checked against `roots[1]`. `PatternInfo::bgp_prefix3_len` is the single source of truth on slot allocation; merge sites shift right-side bracket indices by `left.bgp_prefix3_len`.

### 8.2 Lowering (shipped)

`lower::lower_not_exists_into` first checks `detect_prefix_kind(inner_pattern, outer_bound)`. If the inner-only shape matches a shipped prefix kind, lower to a `PrefixNonExistenceConstraint`; otherwise fall back to the round-3 ground-inner reject path with a pointer to `spec/prefix-tree-commitment.md` Sec.7.

`lower::optional_inner_easy_case` returns one of `EasyCase::{Round3, Prefix(kind), FallThrough}`. The `LeftJoin` arm dispatches:

- `Round3` -- existing collapse, three slots in `bgp` (matched + 2 brackets).
- `Prefix(kind)` -- one matched-arm slot in `bgp`, two bracket slots in `bgp_prefix3`. The matched arm pins the fixed positions; the inner-only `o` is unconstrained.
- `FallThrough` -- existing power-set machinery (`optional_circuits[]`).

### 8.3 Emit (shipped)

`emit::generate_sparql_nr_from_query_info` emits a per-`PrefixNonExistenceConstraint` three-arm dispatch:

```rust
let absent_prefix_i = utils::prefix3::hash3_sp_g(s, p, g);
if boundary_cases_prefix3[i] == 0 {
    utils::prefix3::verify_non_membership_prefix3_low_sentinel_no_inclusion(low_sentinel_3, bgp_prefix3[right], absent_prefix_i);
} else if boundary_cases_prefix3[i] == 1 {
    utils::prefix3::verify_non_membership_prefix3_no_inclusion(bgp_prefix3[left], bgp_prefix3[right], absent_prefix_i);
} else if boundary_cases_prefix3[i] == 2 {
    utils::prefix3::verify_non_membership_prefix3_high_sentinel_no_inclusion(bgp_prefix3[left], high_sentinel_3, absent_prefix_i);
} else {
    assert(false, "non-membership prefix3: boundary_cases_prefix3[i] must be 0, 1, or 2");
}
```

Prefix-3 OPTIONAL collapse uses the **boolean-returning** variants (`*_no_inclusion_check`) inside an `assert(matched | unmatched)` line, mirroring the round-3 collapse pattern. The matched arm omits the equality at `prefix_kind.free_position()` so the inner-only `o` can witness any value.

### 8.4 Public input layout

The `BoundaryCasesPrefix3` array carries one tag per prefix-3 dispatch -- first all `PrefixNonExistenceConstraint`s (in IR order), then all prefix-3 `EasyOptional`s. Same prefix-3 sentinels and `bgp_prefix3` slot array are shared across all prefix-3 constraints.

### 8.5 Signer + main.nr ABI (shipped)

The signer publishes **two roots**: `(root_4, root_3sp_g)`. `main.nr` declares `roots: [Root; 2]` when `has_prefix3` and verifies the signature on each. Additional public inputs:

- `low_sentinel_3` / `high_sentinel_3` (`SentinelLeaf`) -- prefix-3 sentinel inclusion paths.
- `bgp_prefix3: BgpPrefix3` (`[PrefixTriple3; N]`) -- bracket leaves for inclusion against `roots[1]`.
- `boundary_cases_prefix3: BoundaryCasesPrefix3` (`[Field; M]`) -- per-dispatch tag.

The TS layer's `signRdfData` (`src/scripts/sign.ts`) computes both trees in parallel and emits:

```ts
{
  root: "0x...",                           // round-3 leaf-hash sorted root
  rootPrefix3: "0x...",                    // round-4 prefix-3 sorted root
  prefix3: { prefixes, paths, direction, lowSentinel*, highSentinel* },
  /* round-3 fields preserved */
}
```

Deployments that don't need the prefix tree set `rootPrefix3 = "0x0"` and omit `prefix3`; any prover attempting a prefix-3 non-membership against an empty tree fails because the genuine tree-build hash never equals zero. See Sec.6.3.

### 8.6 Runtime glue (shipped -- round 6)

Round 5 shipped the **transform-side** wiring. Round 6 closes the two **runtime-glue** gaps so the prefix-3 commitment is exercised end-to-end on real datasets:

1. **Two signatures, one key** (was: roborev #545 high 2). `src/scripts/sign.ts` now issues **separate signatures** under the same key for `root` and `rootPrefix3`, populating `signedData.signature` and `signedData.signaturePrefix3`. The generated `main.nr` already calls `verify_signature(public_key[0], roots[i])` once per root, so no verifier-side change was needed; per-root signatures keep the existing `Root.signature` ABI unchanged and avoid the soundness review burden of a hash-of-roots scheme. Each future prefix variant adds one more `Root` slot + one more `signRoot` call; the `for i in 0..K { verify_signature(...) }` loop already accepts arbitrary `K`. See the "two signatures vs one signature on `hash2([roots])`" trade-off in `src/scripts/sign.ts::generateSignature`.

2. **Prove-time input population** (was: roborev #545 high 3). `src/scripts/prove.ts` populates `roots[1]`, `bgp_prefix3`, `low_sentinel_3`, `high_sentinel_3`, and `boundary_cases_prefix3` from `signedData.prefix3`. The substitution / hash / bracket logic lives in `src/scripts/prove-prefix3.ts`:

   - **Substitute** each `metadata.prefixNotExists[i].absentTerms[j]` -- one of `variable` (resolved against the live binding), `static` (encoded constant), or `input` (read out of `bgp[p].terms[j]`) -- into a Field-string.
   - **Hash** in one batched `runJson` call: `utils::prefix3::hash3_sp_g(s, p, g)` per constraint, matching the Noir circuit's identical call.
   - **Bracket** by sorting the prefix-3 tree's real leaves by hash (using `paths[i][0]` and the `direction[i]`-reconstructed sorted index) and locating the strict-`<` neighbours of the absent hash.
   - **Dispatch** by setting `boundary_cases_prefix3[i]` to `0` (Lower), `1` (Middle), or `2` (Upper); the matching `verify_non_membership_prefix3_*_no_inclusion` primitive fires inside the circuit. Filler slots (the dropped half of a Lower / Upper bracket) are populated with the smallest real prefix leaf so per-slot inclusion still passes.

   Bindings whose absent prefix is **present** in the dataset are dropped (the constraint is unsatisfiable, by design). The metadata schema gained `absentTerms` / `freePosition` / `fixedPositions` on each `prefixNotExists` entry so the prover can perform the substitution -- a transform-layer change the round-5 emitter didn't need.

Round-3 sentinel inputs (`low_sentinel`, `high_sentinel`, `boundary_cases`) are also surfaced from the signer at round 6, since prefix-3 circuits import the same `verify_low_sentinel_inclusion` / `verify_high_sentinel_inclusion` primitives and the round-3 sentinel scaffolding becomes load-bearing as soon as the round-3 NOT EXISTS / OPTIONAL collapse paths run on real datasets. The signer's `signedData` exposes `lowSentinelPath` / `lowSentinelDirections` / `highSentinelPath` / `highSentinelDirections`; `prove.ts` wires them into every NOT EXISTS / OPTIONAL collapse / prefix-3 circuit.

End-to-end coverage lives in `test/run-prefix3-e2e.ts` -- three sub-tests (sign emits both roots + signatures; NOT EXISTS over a prefix-3 absent object proves and verifies; OPTIONAL collapse over a prefix-3 inner-only object proves and verifies). The script exercises the full `sign → prove → verify` pipeline on an in-memory dataset shaped to land in the Lower / Middle / Upper boundary arms.

### 8.7 Soundness check on projection (shipped -- round 5; verified round 6)

The matched arm of a prefix-3 OPTIONAL collapse pins the fixed positions but leaves `bgp[matched_idx].terms[free_position]` unconstrained, so a malicious prover could pick any signed leaf's value at that position. If the inner-only variable bound to the free position is **projected** in the query's `Variables`, the verifier would accept a binding that wasn't witnessed by a live (s, p, o, g) tuple in the matched-arm sense. This is unsound.

`process_query` enforces a post-lowering check: if any prefix-3 `EasyOptional`'s `inner_only_var` appears in `circuit_vars`, reject the query with a clear error rather than silently emitting an unsound circuit. The round-6 e2e fixture (`test/run-prefix3-e2e.ts`) exercises the OPTIONAL-collapse case with the inner-only `?age` **deliberately omitted from `SELECT`** -- the rejection is unit-tested in `transform/tests/snapshot.rs::optional_inner_only_object_projected_is_rejected`. Future rounds may extend the matched arm to pin all four positions when the inner-only is projected (at the cost of a richer witness shape) and lift the rejection.

## 9. Open questions for the follow-up round

1. **Cross-tree consistency check at sign time** (Sec.4 subtlety). The `O(N²)` check is acceptable; an `O(N log N)` Merkle-multiset-equality argument would be cleaner. Defer until the prefix-tree variants multiply and the constant factor matters.
2. **Optional prefix trees.** Should every signer build all 16 prefix trees, or only the ones the deployment expects to query? Probably the latter (most signers only need `tree_4` + a small subset). Requires per-signature metadata listing which trees are committed; clarify in the round-5 follow-up.
3. **`hash3` domain separator value.** Sec.2.2 picks an ASCII-packed constant; alternatively, a low-arity hash like `Poseidon3` would avoid the padding. Re-examine when the prefix-tree variants are profiled.
4. **Cross-prefix bracket dedup.** If a query has multiple prefix-3 `NOT EXISTS` constraints over the same dataset, the bracket leaves can collide; the transform layer should hash-cons the bracket slots to avoid duplicate inclusion checks. Optimisation, not correctness.

## 10. References

- W3C SPARQL 1.1 Sec.18.5 (algebra evaluation): https://www.w3.org/TR/sparql11-query/#sparqlAlgebraEval
- `spec/exists.md` Sec.3.3 (round-3 sorted-leaf non-membership, the design template)
- `decisions/non-membership-sentinels-transform-wiring.md` (Approach A — runtime dispatch on `boundary_case`)
- `paper/PLAN.md` Sec.4.3 (prefix-tree commitment paper claims)
- `feedback_modular_commitment_signature_design.md` (workspace memory — modular-commitment directive)
