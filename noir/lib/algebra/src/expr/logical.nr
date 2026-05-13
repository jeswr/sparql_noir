//! Logical combinators -- `spec/algebra-structs.md` sec.4.3.
//!
//! Pure boolean `&` / `|` / `!` over child `ExprBool`s.

use crate::algebra::traits::ExprBool;

pub struct And<L, R> { pub left: L, pub right: R }
pub struct Or<L, R> { pub left: L, pub right: R }
pub struct Not<E> { pub inner: E }

impl<L, R> ExprBool for And<L, R> where L: ExprBool, R: ExprBool {
    fn evaluate(self) -> bool { self.left.evaluate() & self.right.evaluate() }
}

impl<L, R> ExprBool for Or<L, R> where L: ExprBool, R: ExprBool {
    fn evaluate(self) -> bool { self.left.evaluate() | self.right.evaluate() }
}

impl<E> ExprBool for Not<E> where E: ExprBool {
    fn evaluate(self) -> bool { !self.inner.evaluate() }
}

// -----------------------------------------------------------------
// Tests -- combine with simple Field-domain Eq atoms
// -----------------------------------------------------------------

use crate::expr::cmp::EqF;

#[test]
fn and_true_true() {
    let e: And<EqF, EqF> = And {
        left:  EqF { left: 1, right: 1 },
        right: EqF { left: 2, right: 2 },
    };
    assert(e.evaluate());
}

#[test]
fn and_true_false() {
    let e: And<EqF, EqF> = And {
        left:  EqF { left: 1, right: 1 },
        right: EqF { left: 2, right: 3 },
    };
    assert(!e.evaluate());
}

#[test]
fn or_false_true() {
    let e: Or<EqF, EqF> = Or {
        left:  EqF { left: 1, right: 2 },
        right: EqF { left: 3, right: 3 },
    };
    assert(e.evaluate());
}

#[test]
fn not_false_to_true() {
    let e: Not<EqF> = Not { inner: EqF { left: 1, right: 2 } };
    assert(e.evaluate());
}
