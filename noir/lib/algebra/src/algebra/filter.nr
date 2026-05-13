//! Filter -- `spec/algebra-structs.md` sec.3.5.
//!
//! `Filter<P, E>` wraps a child algebra `P` and a boolean expression
//! `E`. `evaluate` conjoins the two. The expression is responsible
//! for its own EBV behaviour; round-1 expressions either succeed or
//! are rejected at transform-lowering time (see `spec/algebra.md`
//! sec.6 and `SPARQL_ROADMAP.md` sec.2.3 for the supported expression
//! fragment).

use crate::algebra::traits::Algebra;
use crate::algebra::traits::ExprBool;

pub struct Filter<P, E> {
    pub inner: P,
    pub expr: E,
}

impl<P, E> Algebra for Filter<P, E> where P: Algebra, E: ExprBool {
    fn evaluate(self) -> bool {
        self.inner.evaluate() & self.expr.evaluate()
    }
}
