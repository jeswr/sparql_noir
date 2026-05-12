//! Graph -- `spec/algebra-structs.md` sec.3.9.
//!
//! `GraphCtx<P>` is a marker wrapper. The transform substitutes the
//! graph IRI / variable into the 4th position of every inner
//! `TriplePattern` at build time, so by the time we evaluate the
//! tree there is no additional check to do here. The wrapper exists
//! to keep the algebra tree faithful and for the Lean
//! correspondence to find the operator boundary cleanly.

use crate::algebra::traits::Algebra;
use crate::algebra::bgp::PatternPos;

// The graph position is held inside the wrapper for the algebra
// tree's documentation value -- `evaluate` does not consult it
// directly because the transform has already substituted it into
// the inner `TriplePattern.graph` slots.
pub struct GraphCtx<P> {
    pub inner: P,
    pub graph_iri: PatternPos,
}

impl<P> Algebra for GraphCtx<P> where P: Algebra {
    fn evaluate(self) -> bool { self.inner.evaluate() }
}
