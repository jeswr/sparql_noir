//! Extend (BIND) -- `spec/algebra-structs.md` sec.3.6.
//!
//! `Extend<P, B>` wraps a child algebra `P` and a boolean assignment
//! predicate `B`. The transform constructs `B` as a `Eq { left: Var
//! { value: variables.<new_var> }, right: <expr> }` -- the assignment
//! is encoded by asserting equality between the new variable's
//! public-input field and the computed expression's value.
//!
//! Round-1 restriction (inherited from the monolithic surface,
//! `SPARQL_ROADMAP.md` sec.2.1): only Variable / NamedNode / Literal
//! right-hand sides are supported. Arithmetic / function-call RHS is
//! deferred to round 2 when `ExprField` lands.

use crate::algebra::traits::{Algebra, ExprBool};

pub struct Extend<P, B> {
    pub inner: P,
    pub binding: B,
}

impl<P, B> Algebra for Extend<P, B> where P: Algebra, B: ExprBool {
    fn evaluate(self) -> bool {
        self.inner.evaluate() & self.binding.evaluate()
    }
}
