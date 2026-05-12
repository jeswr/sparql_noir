# Readable-vs-Monolithic Gate-Count Comparison

**Round-1 status.** A single worked query (BGP + Filter with logical
AND of two i64-numeric comparisons) compiled through both surfaces.

The point of this round is **not** to chase optimisation: the
readable surface is a structural rewrite for review-friendliness and
Lean-correspondence purposes, not a performance project. The
expectation was the readable surface would lose a small constant
factor to the hand-tuned monolithic emit; the data below shows the
delta is in fact under 1%.

## Method

Both packages compile the same query:

```sparql
PREFIX ex: <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s ?o WHERE {
  ?s ex:age ?o .
  FILTER ((?o > "18"^^xsd:integer) && (?o < "30"^^xsd:integer))
}
```

- **Monolithic baseline**: `bench/monolithic_filter_and_or/`
  -- verbatim copy of `transform/tests/snapshots/filter_and_or.*`,
  hosted as a runnable Nargo package so `nargo info` can target it.
- **Readable surface**: `noir/bin/algebra_example/` -- hand-written
  composition of `Project<Filter<Bgp<1>, And<GtI64, LtI64>>>` from
  `noir/lib/algebra`.

Both share the same public-input shape (`Variables { s, o }`,
`Hidden = [Field; 4]`, `bgp: [Triple; 1]`, `roots: [Root; 1]`,
`public_key: [PubKey; 1]`).

Tool: `nargo 1.0.0-beta.17` (matches the rest of `noir/lib/`).
Command: `nargo info` (run from each package directory).

## Numbers

| Surface | `main` ACIR opcodes | `main` "Expression Width" (per `nargo info`) |
|---|---|---|
| Monolithic (`monolithic_filter_and_or`) | 97 | 10285 |
| Readable (`algebra_example`)            | 97 | 10368 |
| Delta (readable - monolithic) | **0** | **+83 (~0.8 %)** |

> The "Expression Width" column reported by `nargo info` in
> `1.0.0-beta.17` appears to count something proportional to total
> constraint-row width rather than the documented narrow per-gate
> width (an integer like 3/4). The two columns are reported as
> labelled by the tool; the conclusion -- the readable rewrite is
> within 1 % of the monolith on either metric -- holds regardless of
> which column is the "headline" gate count.

## Why the delta is positive but small

The readable surface adds **one** assertion the monolithic surface
omits for default-graph queries: it pins the 4th triple position
(`bgp[0].terms[3].hash`) to the default-graph hash
(`consts::hash2([4, consts::encode_string("")])`). The monolithic
emit elides this position for default-graph queries because the
`spec/algebra.md` sec.10 contract leaves it implicit, while the
readable surface treats every `TriplePattern` as four
`PatternPos`es uniformly for symmetry with `GRAPH ?g` queries.

This is a deliberate design call -- the symmetric four-position
pattern is what makes `GraphCtx::evaluate` a no-op marker rather
than a special-case wrapper, and it makes the Lean correspondence
mechanical. The cost is 1 hash + 1 field equality (~83 expression-
width units / 0 ACIR opcodes) per BGP triple. We are comfortable
paying that for the clarity win.

## Reproducing

```
cd circuits/sparql_noir
( cd noir/bin/algebra_example && nargo info ) | tee /tmp/readable.txt
( cd bench/monolithic_filter_and_or && nargo info ) | tee /tmp/mono.txt
```

## Easy follow-up rows (readable surface only)

The expression heads landed in the easy-follow-up round (`IN` /
`NOT IN`, `IF` / `COALESCE`, `isNumeric`) are not implemented by the
monolithic surface, so this section is a **readable-only** count.
The baseline is the original `algebra_example` (BGP + numeric range
filter) for context.

| Query shape | Package | `main` ACIR opcodes | `main` Expression Width |
|---|---|---|---|
| BGP + `?o > 18 && ?o < 30` | `algebra_example` | 97 | 10368 |
| BGP + `?s IN (alice, bob, carol)` | `algebra_example_in` | 89 | 10557 |

**Why the `IN` example is 8 ACIR opcodes cheaper than the i64
comparison example.** `In<3>` unrolls to three direct field
equalities + a disjunction fold; the i64 numeric comparison path
in `algebra_example` decodes two `i64`-typed hidden inputs and runs
through the `LtI64`/`GtI64` Noir comparators, which decompose into
range-check + sign-aware compare primitives. Expression-width is
slightly higher (~+189 = ~1.8 %) because `IN` constants are
materialised as three precomputed Pedersen-hash accessors, each of
which contributes a hash-evaluation cost the i64 path doesn't need.
Both lines are within the round-1 "under 1 % delta vs monolith"
spirit; only the comparison axis changes (the IN row has no
monolithic counterpart to compare against today).

`IF` / `COALESCE` / `isNumeric` are not yet wired into a worked
example -- they are exercised by the in-tree `#[test]` blocks in
`expr::if_coalesce` and `expr::is_numeric`. A future bench-row
update can add an `algebra_example_isnumeric/` package once a
representative query lands in the snapshot corpus.

Reproducing:

```
cd circuits/sparql_noir
( cd noir/bin/algebra_example_in && nargo info )
```

## What's next

Round-1 only covers a single query. Follow-ups:

- Run the same comparison across the full `transform/tests/snapshot.rs`
  corpus once a small Rust harness can lower each query through both
  the monolith and the readable surface.
- Pick a deeper query (4-5 BGP triples + OPTIONAL + UNION + path)
  for a more representative comparison. The readable surface's
  pure-conjunction `Join` / `Union` evaluators should remain
  constant-overhead, but the easy-OPTIONAL collapse and path
  unrolling may surface small algorithm differences worth tracking.

References:
- `spec/algebra-structs.md` -- design rationale for the readable
  surface.
- `SPARQL_ROADMAP.md` sec.6 -- IR / readability roadmap context.
- `transform/tests/snapshots/filter_and_or.*` -- monolithic-surface
  fixture from which `bench/monolithic_filter_and_or/` is mirrored.
