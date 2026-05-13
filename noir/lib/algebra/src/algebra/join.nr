//! Join -- `spec/algebra-structs.md` sec.3.2.
//!
//! A `Join<L, R>` is pure conjunction of two child algebras. Binding
//! consistency between the children is *not* enforced here -- it is
//! enforced at the leaf, because both children's `TriplePattern`s
//! reference the same `variables.<var>` public input for any shared
//! SPARQL variable, and the public input is a single witness value.

use crate::algebra::traits::{Algebra, GraphAssertable};

pub struct Join<L, R> {
    pub left: L,
    pub right: R,
}

impl<L, R> Algebra for Join<L, R>
where
    L: Algebra,
    R: Algebra,
{
    fn evaluate(self) -> bool {
        self.left.evaluate() & self.right.evaluate()
    }
}

impl<L, R> GraphAssertable for Join<L, R>
where
    L: GraphAssertable,
    R: GraphAssertable,
{
    /// Conjoin both children's graph-position pins. A `Join` shares
    /// its `GRAPH`-clause context with both subterms, so the
    /// expected IRI flows through unchanged to each side.
    fn assert_graph_position(self, expected: Field) -> bool {
        self.left.assert_graph_position(expected) & self.right.assert_graph_position(expected)
    }
}
