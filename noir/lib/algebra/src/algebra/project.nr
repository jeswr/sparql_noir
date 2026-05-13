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

use crate::algebra::traits::Algebra;

pub struct Project<P> { pub inner: P }
pub struct Distinct<P> { pub inner: P }
pub struct Reduced<P> { pub inner: P }
pub struct Order<P> { pub inner: P }
pub struct Slice<P> { pub inner: P, pub offset: u32, pub limit: u32 }

impl<P> Algebra for Project<P> where P: Algebra {
    fn evaluate(self) -> bool { self.inner.evaluate() }
}

impl<P> Algebra for Distinct<P> where P: Algebra {
    fn evaluate(self) -> bool { self.inner.evaluate() }
}

impl<P> Algebra for Reduced<P> where P: Algebra {
    fn evaluate(self) -> bool { self.inner.evaluate() }
}

impl<P> Algebra for Order<P> where P: Algebra {
    fn evaluate(self) -> bool { self.inner.evaluate() }
}

impl<P> Algebra for Slice<P> where P: Algebra {
    fn evaluate(self) -> bool { self.inner.evaluate() }
}
