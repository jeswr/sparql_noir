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
use crate::algebra::traits::GraphAssertable;

pub struct Filter<P, E> {
    pub inner: P,
    pub expr: E,
}

impl<P, E> Algebra for Filter<P, E>
where
    P: Algebra,
    E: ExprBool,
{
    fn evaluate(self) -> bool {
        self.inner.evaluate() & self.expr.evaluate()
    }
}

impl<P, E> GraphAssertable for Filter<P, E>
where
    P: GraphAssertable,
{
    /// Delegate to the inner algebra. The filter expression is over
    /// hash-domain / typed-value witnesses, not over the triple's
    /// graph slot, so the expression contributes nothing to the
    /// graph-position pin.
    fn assert_graph_position(self, expected: Field) -> bool {
        self.inner.assert_graph_position(expected)
    }
}
