# W3C SPARQL conformance harness

Drives `sparql_noir` through the **W3C SPARQL 1.0 evaluation manifest**
and emits an authoritative pass-rate report — the table cited in the
ISWC 2026 paper §8.2.

The harness is intentionally separate from `ts.js` (the legacy curated
runner). `ts.js` ships a hand-maintained skip-list and exits non-zero
on any failure; this harness records every outcome and never gates CI
on the pass-rate, so the §8.2 number reflects what we actually
support today.

## Layout

```
test/conformance/
├── README.md                   # this file
├── feature-classifier.ts       # parses each query into algebra and tags
│                               # a headline SPARQL feature for the table
├── run-w3c-sparql10.ts         # the harness itself
├── types.ts                    # shared TestRecord / ConformanceReport
└── w3c-sparql10-report.json    # last run output (gitignored)
```

## Running locally

The harness is `tsx`-runnable, so no build step is needed for the
TypeScript itself. The Rust→WASM transform must be built first:

```sh
# One-time per checkout: build the WASM transform bridge.
npm run build:wasm

# Transform-only mode, all ~270 evaluation tests, JSON report.
npx tsx test/conformance/run-w3c-sparql10.ts

# Bootstrap: run a small subset (faster).
npx tsx test/conformance/run-w3c-sparql10.ts --limit=20

# Filter by name / URI substring.
npx tsx test/conformance/run-w3c-sparql10.ts --filter=optional
```

The default manifest URL is
`https://w3c.github.io/rdf-tests/sparql/sparql10/manifest.ttl`.
Override with `--manifest=<url>`.

The manifest + per-test data is cached under
`temp/conformance-manifest-cache-v1/` — a versioned path that does
**not** share storage with `ts.js`'s `temp/manifest-cache/`. The two
runners cache different schemas (this harness needs `queryResult.type`
+ `queryResult.value`; `ts.js` only stores `queryResultValue`), and a
shared cache silently corrupts whichever runner reads after the other
writes. `--no-cache-manifest` forces a re-fetch.

Only `transform-only` mode is exposed today. The full prove + verify
pipeline (matching `ts.js`'s end-to-end flow) is tracked under the
§8.2 hardening follow-up; landing it requires driving the pipeline
directly from the manifest record (rather than shelling to `ts.js`,
which can mark a non-running test as passed) and a per-test selector
that asserts exactly one test ran.

## What's tested

Only `mf:QueryEvaluationTest` entries with `dawg:Approved` status are
exercised. For each, the harness:

1. **Parses** the query into the `sparqlalgebrajs` algebra.
2. **Classifies** it under exactly one headline feature (BGP / Filter /
   Optional / Union / Minus / Graph / Path / Bind / Values / Aggregate /
   OrderBy / Distinct / Slice / Construct / Describe / Ask / Service /
   Subquery / Project) for §8.2's per-feature row. The full feature set
   observed in the algebra is also recorded so derived breakdowns (e.g.
   "tests that combine Filter and Optional") are reproducible from the
   JSON.
3. **Lowers** the query through the WASM-compiled `transform/` module
   and records `passed` if lowering succeeds; this is the §8.2
   "supported algebra fragment" rate.

The full prove + verify pipeline is intentionally out of scope for
this harness today — see the bullet at the top of *Running locally*.

## What's skipped (and why)

| Category | Reason |
|---|---|
| `CONSTRUCT` / `DESCRIBE` queries | Out of paper scope — §8.2 reports SELECT / ASK conformance only; `CONSTRUCT` is §9 future work. |
| `SERVICE` queries | Federation is permanently OOS for ZK (`SPARQL_ROADMAP.md` §1). |
| Tests with empty `queryData` | Empty-input semantics need separate witness handling; tracked under §6.4 honest map. |
| Non-`Approved` manifest entries | The W3C suite includes withdrawn / proposed entries; §8.2 only counts approved tests. |
| Syntax-only manifest entries (`PositiveSyntaxTest11`, etc.) | The harness is an *evaluation* runner; syntax-only tests are out of §8.2's frame. |

Tests that the transform rejects with a recognisable feature-gap error
(arithmetic in expression position, REGEX, MINUS, VALUES, aggregates,
XSD casts, etc.) are bucketed as **`unsupported`** rather than
**`failed`**, so the §8.2 table cleanly distinguishes "the engine
cannot do this yet" from "the engine got this wrong".

## Status taxonomy

| Status | Meaning |
|---|---|
| `passed` | Transform lowering succeeded. |
| `failed` | Transform produced no `sparql.nr` despite no error — should be 0 in steady state. |
| `unsupported` | Transform rejected the query with a known feature-gap error. |
| `errored` | Unexpected internal error — bug in the harness, missing build artefact, etc. Should be 0 in steady state. |
| `skipped` | Out of scope per the table above. |

## Output

A JSON report at `test/conformance/w3c-sparql10-report.json` plus a
markdown summary printed to stdout (and to
`$GITHUB_STEP_SUMMARY` in CI). The JSON has the shape declared in
`types.ts`:

```ts
{
  generatedAt: string;
  manifestUrl: string;
  mode: 'transform-only';
  commitSha: string | null;
  totals: { total, passed, failed, unsupported, errored, skipped, passRate };
  byFeature: FeatureSummary[];   // §8.2 table rows
  tests:    TestRecord[];        // one row per test
}
```

## CI integration

`.github/workflows/w3c-sparql10-conformance.yml` runs the harness on
every PR and on push-to-`main`, in `transform-only` mode. The JSON
report is uploaded as a build artefact (`w3c-sparql10-report` —
retained for 90 days) and the markdown summary is appended to the
workflow's step summary so the §8.2 figure is one click away from any
PR page.

The CI job is **non-gating**: `--threshold=0`, exit-zero on any
non-zero pass-rate. Ratcheting up the threshold (e.g. to lock in a
"do not regress below 40%" floor) is a deliberate paper-pass decision,
not the harness's job.
