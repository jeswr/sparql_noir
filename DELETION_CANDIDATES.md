# Deletion candidates

Living tracking file for files / modules in `sparql_noir` that are
candidates for deletion or consolidation. The codebase was assembled
quickly and carries non-trivial AI-generated bloat; this list is the
running cleanup todo so candidates don't get lost between rounds.

Entries are added freely as the codebase is read; the bar to land here
is "plausibly worth removing", not "definitely remove now". Removal
itself is a separate, deliberate action — most entries should grow a
**Trigger** field that names the round / event when removal becomes
safe, then move to the *Removed* section once that round lands.

The repository is marked **experimental** (workspace memory:
`feedback_zkp_sparql_repos_experimental.md`) — breaking-changes don't
need a deprecation cycle.

## Definitely delete (mechanical, no dependencies)

| Path | Reason | Trigger |
| --- | --- | --- |
| `transform/src/main.rs.bak` | Stale backup left by a previous round; no live reference. | Any commit that touches the `transform/` tree. |

## Consolidate, then delete

These are the one-off W3C-manifest probes / analysis scripts. The
test-cleanup plan's step 3 (per the merged refactor branch's agent
report) consolidates them into a single `analyze-w3c-manifest.mjs`.
After that, the originals go.

| Path | Reason | Trigger |
| --- | --- | --- |
| `analyze-bn.mjs` | One-off W3C-manifest probe; overlaps with `analyze-functions.mjs` and `check-tests.mjs`. | Step 3 of the test-cleanup plan ships. |
| `analyze-functions.mjs` | Same. | Same. |
| `check-tests.mjs` | Same. | Same. |
| `test-wasm-compile.mjs` | One-off WASM compile probe; unclear whether it has a current consumer. | Verify-then-delete (no live caller). |

## Doc / metadata candidates (verify before deleting)

Several Markdown files at the repo root were AI-generated summaries.
Some are now superseded by `SPARQL_ROADMAP.md`; some still carry useful
context. **Verify before deleting** — read the file, check for unique
content not captured elsewhere, then either retire or fold into the
remaining canonical doc.

| Path | Reason to consider | Trigger |
| --- | --- | --- |
| `IMPLEMENTATION_SUMMARY.md` | Likely superseded by `SPARQL_ROADMAP.md` + `ARCHITECTURE.md`. | Verify-then-decide. |
| `API_IMPLEMENTATION.md` | Same; possibly stale snapshot of an earlier API surface. | Verify-then-decide. |
| `XPATH_INTEGRATION_SUMMARY.md` | Possibly superseded once the IEEE 754 / XPath redesign docs in workspace `docs/` land their own implementation rounds. | Verify-then-decide; defer until at least one round of §6.2 work. |
| `NOTES.md` | Generic notes file; check whether anything is load-bearing. | Verify-then-decide. |
| `SPARQL_COVERAGE.md` | Predecessor to `SPARQL_ROADMAP.md`'s coverage table. | Decide whether to delete or fold any unique content into the roadmap. |

## Test-entry-point redundancy (verify before deleting)

Per `SPARQL_ROADMAP.md` §8.4 (DECIDED 2026-05-03 — `ts.js` canonical),
the other test entry points may be redundant.

| Path | Reason to consider | Trigger |
| --- | --- | --- |
| `test/run-sparql-tests.ts` | If `ts.js` covers SPARQL 1.0 evaluation tests authoritatively, this entry point may be redundant. Could also be the cleaner long-term replacement once `ts.js` is split — verify which way. | After the test-cleanup plan's step 5 (`ts.js` `runTest` split). |
| `test/run-snapshot-tests.ts` | Snapshot-regression specifically; possibly not subsumed by `ts.js`. | Verify the use case before deleting. |

## Removed

### Q1-driven deletions (`arith::Float` arithmetic — IEEE 754 throughout)

Per `SPARQL_ROADMAP.md` §8.1 (DECIDED 2026-05-03 — adopt IEEE 754
throughout). Removed in round 2 §6.2 (commit `64e0466`).

| Path / surface | Removed by |
| --- | --- |
| `noir/lib/arith/Float` struct + impl | `64e0466` |
| `noir/lib/arith/add_floats` | `64e0466` |
| `noir/lib/arith/sub_floats` | `64e0466` |
| `noir/lib/arith/mul_floats` | `64e0466` |
| `noir/lib/arith/div_floats` | `64e0466` |
| `noir/lib/arith/truncate`, `truncate_float`, `truncate_double` | `64e0466` |
| `noir/lib/arith/pow10`, `pow10_lookup` | `64e0466` |
| `noir/lib/arith/encode_float`, `decode_float` | `64e0466` |
| `noir/lib/arith/float_eq`, `float_gt`, `float_lt`, `float_gte`, `float_lte` | `64e0466` |
| `noir/lib/arith/FloatSpecial` struct + impl | `64e0466` |
| `noir/lib/arith/{add,sub,mul,div,neg,pos,abs}_float` (companion `Float`-typed overloads) | `64e0466` |
| `noir/lib/arith/round_float`, `floor_float`, `ceil_float` | `64e0466` |
| Float-internal globals (`MAX_MANTISSA`, `EXPONENT_BIAS`, `FLOAT_PRECISION`, `DOUBLE_PRECISION`) | `64e0466` |

Net deletion: 1,039 LoC removed; 413 LoC of replacement IEEE 754 wiring
added; net ‑626 LoC. The roadmap's "~700 LoC" estimate matches within a
margin attributable to the refreshed test surface.

The replacements (calls into `noir_xpath`'s IEEE 754 types) live at
`noir/lib/arith/src/lib.nr`'s reshaped `add` / `sub` / `mul` / `div` /
`neg` / `pos` / `abs` / `round` / `ceil` / `floor` and the new
`coerce_to_float` / `coerce_to_double` helpers.

## Maintenance

- An entry stays here until the file / surface is removed; then it moves
  to the *Removed* section with a one-line note pointing at the commit
  that removed it.
- New entries land freely as future agents notice candidates. Don't
  make removal a precondition of landing the entry.
- Every entry should have a clear **Reason** and an explicit **Trigger**
  (round, event, or "verify-then-decide"); otherwise an agent reading
  this list won't know whether it's safe to act on.
