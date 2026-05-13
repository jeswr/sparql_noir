//! Project + post-process modifiers -- `spec/algebra-structs.md`
//! sec.3.7-3.8.
//!
//! `Project` and the four modifiers (`Distinct`, `Reduced`, `Order`,
//! `Slice`) are **no-op markers** at the circuit level. Projection
//! happens by *which* fields the per-query `variables` public-input
//! struct carries; the four modifiers are post-process -- enforced by
//! the verifier outside the circuit (see `SPARQL_ROADMAP.md` sec.2.1).
//!
//! The structs exist so the algebra tree is faithful to the SPARQL
//! algebra and the Lean correspondence can mirror it one-for-one.

use crate::algebra::traits::{Algebra, GraphAssertable};

pub struct Project<P> {
    pub inner: P,
}
pub struct Distinct<P> {
    pub inner: P,
}
pub struct Reduced<P> {
    pub inner: P,
}
pub struct Order<P> {
    pub inner: P,
}
pub struct Slice<P> {
    pub inner: P,
    pub offset: u32,
    pub limit: u32,
}

impl<P> Algebra for Project<P>
where
    P: Algebra,
{
    fn evaluate(self) -> bool {
        self.inner.evaluate()
    }
}

impl<P> Algebra for Distinct<P>
where
    P: Algebra,
{
    fn evaluate(self) -> bool {
        self.inner.evaluate()
    }
}

impl<P> Algebra for Reduced<P>
where
    P: Algebra,
{
    fn evaluate(self) -> bool {
        self.inner.evaluate()
    }
}

impl<P> Algebra for Order<P>
where
    P: Algebra,
{
    fn evaluate(self) -> bool {
        self.inner.evaluate()
    }
}

impl<P> Algebra for Slice<P>
where
    P: Algebra,
{
    fn evaluate(self) -> bool {
        self.inner.evaluate()
    }
}

// `GraphAssertable` is a no-op forward through the marker wrappers
// for the same reason `evaluate` is: projection and the four
// post-process modifiers don't touch the witness array's graph slot.

impl<P> GraphAssertable for Project<P>
where
    P: GraphAssertable,
{
    fn assert_graph_position(self, expected: Field) -> bool {
        self.inner.assert_graph_position(expected)
    }
}

impl<P> GraphAssertable for Distinct<P>
where
    P: GraphAssertable,
{
    fn assert_graph_position(self, expected: Field) -> bool {
        self.inner.assert_graph_position(expected)
    }
}

impl<P> GraphAssertable for Reduced<P>
where
    P: GraphAssertable,
{
    fn assert_graph_position(self, expected: Field) -> bool {
        self.inner.assert_graph_position(expected)
    }
}

impl<P> GraphAssertable for Order<P>
where
    P: GraphAssertable,
{
    fn assert_graph_position(self, expected: Field) -> bool {
        self.inner.assert_graph_position(expected)
    }
}

impl<P> GraphAssertable for Slice<P>
where
    P: GraphAssertable,
{
    fn assert_graph_position(self, expected: Field) -> bool {
        self.inner.assert_graph_position(expected)
    }
}
