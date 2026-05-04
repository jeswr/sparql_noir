# IEEE 754 migration inventory (round 2 §6.2)

Tracking artefact for the migration described in `SPARQL_ROADMAP.md`
§6.2 + §8.1 (Q1 decision, 2026-05-03 — IEEE 754 throughout).

The decision: rewire `noir/lib/arith`'s type-promotion + `ArithResult` to
call `noir_xpath`'s IEEE 754 `XsdFloat` / `XsdDouble`; delete
`arith::Float`'s arithmetic surface (~700 LoC removed). Round 2 §6.2
also wires numeric arithmetic into FILTER expressions in
`transform/src/expr.rs`.

This document is the working record of the migration so the per-call-site
commits remain easy to review.

## Survey result — `arith::Float` consumers

A repository-wide search for any consumer of `arith::*` Float-specific
surface returned **no live references** outside `noir/lib/arith` itself:

```
$ rg "dep::arith|use arith|use crate::arith|arith::" \
     --glob '!noir/lib/arith/**' --type-add 'noir:*.nr' -t noir -t rust -t ts -t toml
# (empty)
```

Implications:

- The deletion of the `Float`-arithmetic surface cannot break any
  outside caller — there are none.
- The transform layer (`transform/src/expr.rs`) does not call `arith` at
  all. Its current ABS / ROUND / CEIL / FLOOR paths go directly to
  `xpath::abs_int` / `round_int` / `ceil_int` / `floor_int` (integer
  variants only). The roadmap §6.2 work to wire type-aware float / double
  paths is therefore an addition to `expr.rs`, not a substitution of one
  call-site for another.
- `arith` itself is therefore best treated as an internal-only helper
  module ready to be reshaped: keep the type-promotion / `ArithResult`
  shell, swap the IEEE 754 implementation in.

## Surface to delete from `noir/lib/arith/src/lib.nr`

Per `SPARQL_ROADMAP.md` §8.1 — the option-(a) deletion list:

| Symbol | Lines | Reason |
| --- | --- | --- |
| `Float` struct + `impl Float` (`zero`, `from_integer`, `from_negative_integer`, `is_zero`, `is_negative`, `negate`, `abs`) | ~50 | Hand-rolled base-10 mantissa-exponent; replaced by `noir_xpath::XsdFloat` / `XsdDouble`. |
| `pow10_lookup`, `pow10` | ~45 | Only used by `truncate` / `div_floats`. |
| `truncate`, `truncate_float`, `truncate_double` | ~50 | Float-renormalisation helper; obsolete under IEEE 754. |
| `add_floats`, `sub_floats`, `mul_floats`, `div_floats` | ~95 | Replaced by `noir_xpath::numeric_{add,subtract,multiply,divide}_{float,double}`. |
| `float_gt`, `float_lt`, `float_gte`, `float_lte`, `float_eq` | ~60 | Replaced by `noir_xpath::numeric_{equal,less_than,greater_than,le,ge}_{float,double}`. |
| `FloatSpecial` struct + impl | ~30 | Was a Float-side stub for IEEE 754 specials; superseded by `noir_xpath`'s genuine IEEE 754 specials inside `XsdFloat` / `XsdDouble`. |
| `encode_float`, `decode_float` | ~20 | Pack-into-Field helpers for the deleted struct. |
| `add_float`, `sub_float`, `mul_float`, `div_float`, `neg_float`, `pos_float`, `abs_float` (the `_float` variants taking `Float`) | ~120 | Companion overloads taking the deleted `Float`; the bare `add`/`sub`/`mul`/`div`/`neg`/`pos`/`abs` stay (rewired). |
| `round_float`, `floor_float`, `ceil_float` (those taking `Float`) | ~90 | Replaced by `noir_xpath::round_float` / `floor_float` / `ceil_float` and their `_double` siblings. |
| `MAX_MANTISSA`, `EXPONENT_BIAS`, `FLOAT_PRECISION`, `DOUBLE_PRECISION` globals | ~10 | All Float-internal constants. |
| The `#[test]` cases for the deleted surface (`test_float_zero`, `test_float_from_integer`, `test_float_negate`, `test_float_addition`, `test_float_subtraction`, `test_float_multiplication`, `test_float_division`, `test_float_comparison_*`, `test_truncate_float`, `test_negative_float_arithmetic`, `test_float_abs`) | ~120 | Test the surface that is going away. |

Estimated total deletion: ~690 LoC (matches the roadmap's "~700 LoC"
estimate).

## Surface to keep / rewire in `noir/lib/arith/src/lib.nr`

These are the `arith` exports that survive the migration. Their
*signatures* stay; their *internals* swap to `noir_xpath`.

| Symbol | Migration |
| --- | --- |
| `encode_datatype_iri` | Unchanged. |
| `NumericTypeLevel` struct + impl | Unchanged. |
| `get_numeric_type_level` | Unchanged. |
| `promote_types` | Unchanged. |
| `level_to_datatype` | Unchanged. |
| `is_numeric_datatype`, `is_floating_point_datatype` | Unchanged. |
| `ArithResult` | **Reshaped.** The `float_result: Float` field is replaced by per-type bit-encoded fields (`u32` for `xsd:float`, `u64` for `xsd:double`); integer / decimal continue to use the bare `value: Field`. |
| `add` / `sub` / `mul` / `div` / `neg` / `pos` | **Rewired.** The float / double branch now constructs `noir_xpath::XsdFloat` / `XsdDouble` from the input bits, calls the corresponding IEEE 754 op, and stores the result bits. Integer / decimal branches stay arithmetic-on-Field. |
| `add_unchecked` / `sub_unchecked` / `mul_unchecked` / `div_unchecked` / `neg_unchecked` / `pos_unchecked` | Unchanged signatures; reuse the rewired core. |
| `abs` | **Rewired** to type-aware paths: integer → `xpath::abs_int`; decimal → field-element-floor (Q7 decision); float → `xpath::abs_float`; double → `xpath::abs_double`. |
| `round` / `ceil` / `floor` (new entry points; `_float` versions deleted) | **New** type-aware entry points calling the matching `xpath::*_int` / `*_float` / `*_double` functions. |

## Transform-layer call-sites (`transform/src/expr.rs`)

The transform never imports `arith`, so there are no call-sites to
migrate *into* `noir_xpath` — the call-sites are already correct in
spirit. What §6.2 does add to `expr.rs`:

- **ABS / ROUND / CEIL / FLOOR — type-aware dispatch.** Currently all
  four call `xpath::*_int` regardless of operand type (lines 438–456,
  816–842). Round 2 §6.2 adds a `numeric_function` helper that inspects
  the inferred operand type (via the existing `infer_expression_type` on
  L354) and dispatches to the matching `xpath::*_int` / `*_float` /
  `*_double`. Decimal stays on the integer path (Q7 floor — field
  element width).
- **Numeric arithmetic in FILTER (`?x + ?y > 5`).** New arms in
  `expr_to_noir_code` for `Expression::Add` / `Subtract` / `Multiply` /
  `Divide` / `UnaryMinus` / `UnaryPlus`, dispatching by inferred operand
  type to `xpath::numeric_{add,subtract,…}_{int,float,double}`.

## Snapshot expectations (27-query corpus)

The corpus in `transform/tests/snapshot.rs` has 27 cases. The migrations
above touch only the float / double branches of arithmetic + the type-
aware ABS/ROUND/CEIL/FLOOR dispatch. Most cases will stay byte-identical;
the float / arithmetic-bearing cases that may shift:

- `filter_float_const` — currently constant-folds to `assert(true)` via
  `ieee754_equal`. Stays byte-identical (constant-folding is unchanged).
- `filter_abs` — currently emits `xpath::abs_int(...)` against an
  unknown-type variable; the type-aware dispatch keeps integer as the
  default and so the snapshot stays byte-identical (the operand type is
  inferred-as-`None`, which falls through to the integer path).

There is no snapshot-corpus query that exercises `?x + ?y` or float-
typed ABS/ROUND/CEIL/FLOOR. The migration's behaviour-preservation gate
should therefore see **all 27 snapshots stay byte-identical**.

If a future iteration adds a corpus case that exercises arithmetic, the
type-aware paths will be hit; that case's snapshot is updated
intentionally with `UPDATE_SNAPSHOTS=1`.
