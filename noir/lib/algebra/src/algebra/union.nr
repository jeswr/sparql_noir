//! Union -- `spec/algebra-structs.md` sec.3.3.
//!
//! Pure boolean disjunction. The transform sizes the underlying
//! witness BGP arrays as needed (the widest branch sets the shape;
//! see the monolithic surface's behaviour described in
//! `spec/algebra.md` sec.4 and the union snapshot fixtures).

use crate::algebra::traits::{Algebra, GraphAssertable};

pub struct Union<L, R> {
    pub left: L,
    pub right: R,
}

impl<L, R> Algebra for Union<L, R>
where
    L: Algebra,
    R: Algebra,
{
    fn evaluate(self) -> bool {
        self.left.evaluate() | self.right.evaluate()
    }
}

impl<L, R> GraphAssertable for Union<L, R>
where
    L: GraphAssertable,
    R: GraphAssertable,
{
    /// Conjoin both branches' graph-position pins. Although `evaluate`
    /// is a boolean disjunction (only one branch needs to be true for
    /// the union to satisfy), the witness arrays for **both** branches
    /// live in the dataset commitment and must therefore all sit in
    /// the named graph -- the soundness anchor is the Merkle binding
    /// of the (s, p, o, g) tuple, not the branch's truth value. This
    /// matches the monolithic surface's flattened `bgp[]` array shape
    /// (see `spec/algebra.md` sec.4): every slot's 4th position is
    /// pinned unconditionally when the union is `GRAPH`-qualified.
    fn assert_graph_position(self, expected: Field) -> bool {
        self.left.assert_graph_position(expected) & self.right.assert_graph_position(expected)
    }
}
