//! `IN` / `NOT IN` expressions -- `spec/algebra-structs.md` sec.4.7.
//!
//! SPARQL 1.1 sec.17.4.1.9: `expr IN (e1, e2, ..., en)` is syntactic
//! sugar for `(expr = e1) || (expr = e2) || ... || (expr = en)`.
//! `NOT IN` is its boolean inverse.
//!
//! The readable surface compares a single value (`var`) against a
//! fixed-width set (`set`) over the *hash domain*. This mirrors
//! `EqF` from `expr::cmp`: both sides are `Field` term-hashes, and
//! equality is direct identity. The transform projects each set
//! element into a `Field` at lowering time (either a precomputed
//! literal hash via `consts::hash2`, or a `variables.<var>` public
//! input).
//!
//! ### Why over `Field`, not over a generic `E: ExprBool`?
//!
//! `IN` is *equality-shaped*, not boolean-shaped. The natural type
//! of each set member is the same as the LHS -- a term identity.
//! Carrying a generic `E: ExprBool` for the set would re-derive
//! equality through a child expression and double the constraint
//! footprint per element. Direct `Field`-equality matches the
//! monolithic surface's `hash_equality` shortcut and keeps the
//! constraint cost at one field comparison per set element.
//!
//! Typed-value `IN` (mixing IRIs / literals / numeric coercions per
//! XPath 2.0 value comparison) follows the same gap as `LtI64` /
//! `GtI64`: when the transform proves it has two numerics it lowers
//! to `EqI64`; for term-identity it lowers to `EqF`. The current
//! struct handles the hash-domain case -- the common one in
//! practice today.
//!
//! ### EBV / error semantics
//!
//! SPARQL sec.17.4.1.9 says `IN` raises an error if any element of
//! the list errors during evaluation *and* the matching element is
//! not found before that error. Round-1 expression heads are
//! pre-validated by the transform (see `traits.nr` doc-comment), so
//! the readable surface treats `IN` as a clean disjunction of
//! equalities. This matches the round-1 stance taken by `And` /
//! `Or` / `Not` in `expr::logical`.

use crate::algebra::traits::ExprBool;

/// `?x IN (e1, e2, ..., eN)` -- hash-domain disjunction of
/// equalities. `var` is the LHS term hash; `set` carries the
/// pre-projected RHS term hashes.
pub struct In<let N: u32> {
    pub var: Field,
    pub set: [Field; N],
}

/// `?x NOT IN (e1, e2, ..., eN)` -- boolean inverse of `In`.
pub struct NotIn<let N: u32> {
    pub var: Field,
    pub set: [Field; N],
}

impl<let N: u32> ExprBool for In<N> {
    fn evaluate(self) -> bool {
        // Fold equality over the set. `false` is the disjunctive
        // identity; equality of `var` against any element flips the
        // accumulator to `true`. Constraint cost: `N` field
        // comparisons -- matches the monolithic surface's
        // `hash_equality` chain.
        let mut hit = false;
        for i in 0..N {
            hit = hit | (self.var == self.set[i]);
        }
        hit
    }
}

impl<let N: u32> ExprBool for NotIn<N> {
    fn evaluate(self) -> bool {
        // Composition by value: re-evaluate `In` and negate. The
        // monomorphic transform could short-circuit by inlining
        // `!hit` directly, but the per-operator surface prefers the
        // explicit composition for review-friendliness.
        let inner = In { var: self.var, set: self.set };
        !inner.evaluate()
    }
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[test]
fn in_two_hit_first() {
    let e: In<2> = In { var: 5, set: [5, 7] };
    assert(e.evaluate());
}

#[test]
fn in_two_hit_second() {
    let e: In<2> = In { var: 7, set: [5, 7] };
    assert(e.evaluate());
}

#[test]
fn in_two_miss() {
    let e: In<2> = In { var: 9, set: [5, 7] };
    assert(!e.evaluate());
}

#[test]
fn in_three_hit_middle() {
    let e: In<3> = In { var: 11, set: [3, 11, 17] };
    assert(e.evaluate());
}

#[test]
fn in_three_miss() {
    let e: In<3> = In { var: 4, set: [3, 11, 17] };
    assert(!e.evaluate());
}

#[test]
fn in_four_hit_last() {
    let e: In<4> = In { var: 19, set: [3, 11, 17, 19] };
    assert(e.evaluate());
}

#[test]
fn in_four_miss() {
    let e: In<4> = In { var: 21, set: [3, 11, 17, 19] };
    assert(!e.evaluate());
}

#[test]
fn not_in_two_miss_is_true() {
    let e: NotIn<2> = NotIn { var: 9, set: [5, 7] };
    assert(e.evaluate());
}

#[test]
fn not_in_two_hit_is_false() {
    let e: NotIn<2> = NotIn { var: 5, set: [5, 7] };
    assert(!e.evaluate());
}

#[test]
fn not_in_four_miss_is_true() {
    let e: NotIn<4> = NotIn { var: 21, set: [3, 11, 17, 19] };
    assert(e.evaluate());
}

#[test]
fn in_one_singleton_hit() {
    // Edge case: a singleton list collapses to a single `EqF`. The
    // monolithic transform would lower this directly; the readable
    // surface preserves the `In<1>` shape for tree faithfulness.
    let e: In<1> = In { var: 42, set: [42] };
    assert(e.evaluate());
}

#[test]
fn in_one_singleton_miss() {
    let e: In<1> = In { var: 42, set: [99] };
    assert(!e.evaluate());
}
