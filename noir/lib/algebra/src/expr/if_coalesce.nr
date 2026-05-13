//! `IF` / `COALESCE` expressions -- `spec/algebra-structs.md` sec.4.8.
//!
//! SPARQL 1.1 sec.17.4.1.2 (`IF`) and sec.17.4.1.3 (`COALESCE`).
//!
//! **Boolean-context only.** Round-1 surface lacks a typed-value
//! expression family (no `ExprField` -- see `traits.nr`). Both
//! operators here therefore take *boolean-typed* branches (`T`, `F`,
//! `primary`, `fallback` all implement `ExprBool`) and return a
//! `bool`. The typed-value forms (`IF(?c, ?x, ?y)` returning a
//! Field) are deferred to round 2 with the rest of the typed-value
//! expression family.
//!
//! This is consistent with the round-1 stance taken on numeric
//! arithmetic (`AddF64` et al. are stubs pending `ExprField`) and
//! with the spec's coverage matrix in sec.8.
//!
//! ### `IfBool` semantics
//!
//! `IfBool { cond, then_branch, else_branch }`. `cond` is itself
//! an `ExprBool`. When `cond.evaluate()` is `true`, the result is
//! `then_branch.evaluate()`; otherwise `else_branch.evaluate()`.
//!
//! ### `CoalesceBool` semantics
//!
//! `CoalesceBool { primary_bound, primary, fallback }`. SPARQL
//! `COALESCE(e1, e2)` returns the first `ei` whose evaluation does
//! not raise an error; in our typed world the only error mode the
//! transform tracks today is "unbound variable". `primary_bound` is
//! the same static-analysis bool that `expr::term_tests::Bound`
//! carries -- the transform sets it `true` when the primary
//! expression's variable inputs are all bound on the current solution
//! row, `false` otherwise.
//!
//! Round-1 surface restricts `COALESCE` to two arguments. Wider
//! coalesces (`COALESCE(e1, e2, e3, ...)`) lower to a right-nested
//! `CoalesceBool` chain at transform time -- the same shape today's
//! monolithic surface uses for nested `OR` lowering. This avoids
//! a second const-generic on `CoalesceBool` while preserving full
//! arity coverage.

use crate::algebra::traits::ExprBool;

/// `IF(cond, then_branch, else_branch)` in boolean context.
pub struct IfBool<C, T, F> {
    pub cond: C,
    pub then_branch: T,
    pub else_branch: F,
}

impl<C, T, F> ExprBool for IfBool<C, T, F>
where
    C: ExprBool,
    T: ExprBool,
    F: ExprBool,
{
    fn evaluate(self) -> bool {
        // Noir's `if` is a circuit conditional. Both arms are
        // evaluated unconditionally and the result is selected; this
        // matches the monolithic surface's behaviour and is the only
        // shape compatible with the static-circuit model. The
        // constraint cost is therefore `cost(cond) + cost(then) +
        // cost(else) + 1 selector` -- there is no short-circuit.
        if self.cond.evaluate() {
            self.then_branch.evaluate()
        } else {
            self.else_branch.evaluate()
        }
    }
}

/// `COALESCE(primary, fallback)` in boolean context.
///
/// `primary_bound` is the transform-supplied static-analysis flag
/// (matches `expr::term_tests::Bound`). When true, `primary` is
/// returned; when false, `fallback` is.
pub struct CoalesceBool<L, R> {
    pub primary_bound: bool,
    pub primary: L,
    pub fallback: R,
}

impl<L, R> ExprBool for CoalesceBool<L, R>
where
    L: ExprBool,
    R: ExprBool,
{
    fn evaluate(self) -> bool {
        // Same circuit-conditional shape as `IfBool` -- both arms are
        // evaluated and the bound flag selects. If a future round
        // wires `ExprBool` errors (EBV-error path), `CoalesceBool`
        // will switch the selector from `primary_bound` to the
        // primary arm's error sentinel; the operator surface keeps
        // the same shape.
        if self.primary_bound {
            self.primary.evaluate()
        } else {
            self.fallback.evaluate()
        }
    }
}

// -----------------------------------------------------------------
// Tests -- combine with the existing Field-domain `EqF` atom to
// produce ExprBool branches.
// -----------------------------------------------------------------

use crate::expr::cmp::EqF;

#[test]
fn if_true_picks_then_true() {
    let e: IfBool<EqF, EqF, EqF> = IfBool {
        cond: EqF { left: 1, right: 1 },          // true
        then_branch: EqF { left: 2, right: 2 },   // true
        else_branch: EqF { left: 3, right: 4 },   // false
    };
    assert(e.evaluate());
}

#[test]
fn if_true_picks_then_false() {
    let e: IfBool<EqF, EqF, EqF> = IfBool {
        cond: EqF { left: 1, right: 1 },          // true
        then_branch: EqF { left: 2, right: 3 },   // false
        else_branch: EqF { left: 4, right: 4 },   // true
    };
    assert(!e.evaluate());
}

#[test]
fn if_false_picks_else_true() {
    let e: IfBool<EqF, EqF, EqF> = IfBool {
        cond: EqF { left: 1, right: 2 },          // false
        then_branch: EqF { left: 3, right: 4 },   // false
        else_branch: EqF { left: 5, right: 5 },   // true
    };
    assert(e.evaluate());
}

#[test]
fn if_false_picks_else_false() {
    let e: IfBool<EqF, EqF, EqF> = IfBool {
        cond: EqF { left: 1, right: 2 },          // false
        then_branch: EqF { left: 3, right: 3 },   // true
        else_branch: EqF { left: 4, right: 5 },   // false
    };
    assert(!e.evaluate());
}

#[test]
fn coalesce_bound_returns_primary_true() {
    let e: CoalesceBool<EqF, EqF> = CoalesceBool {
        primary_bound: true,
        primary:  EqF { left: 1, right: 1 },      // true
        fallback: EqF { left: 2, right: 3 },      // false
    };
    assert(e.evaluate());
}

#[test]
fn coalesce_bound_returns_primary_false() {
    let e: CoalesceBool<EqF, EqF> = CoalesceBool {
        primary_bound: true,
        primary:  EqF { left: 1, right: 2 },      // false
        fallback: EqF { left: 3, right: 3 },      // true
    };
    // Even though fallback would be `true`, primary_bound forces the
    // primary branch -- documents the SPARQL "first non-error wins"
    // semantics under our bound-flag model.
    assert(!e.evaluate());
}

#[test]
fn coalesce_unbound_falls_back_true() {
    let e: CoalesceBool<EqF, EqF> = CoalesceBool {
        primary_bound: false,
        primary:  EqF { left: 1, right: 1 },      // true (irrelevant)
        fallback: EqF { left: 2, right: 2 },      // true
    };
    assert(e.evaluate());
}

#[test]
fn coalesce_unbound_falls_back_false() {
    let e: CoalesceBool<EqF, EqF> = CoalesceBool {
        primary_bound: false,
        primary:  EqF { left: 1, right: 1 },      // true (irrelevant)
        fallback: EqF { left: 2, right: 3 },      // false
    };
    assert(!e.evaluate());
}
