//! Union -- `spec/algebra-structs.md` sec.3.3.
//!
//! Pure boolean disjunction. The transform sizes the underlying
//! witness BGP arrays as needed (the widest branch sets the shape;
//! see the monolithic surface's behaviour described in
//! `spec/algebra.md` sec.4 and the union snapshot fixtures).

use crate::algebra::traits::Algebra;

pub struct Union<L, R> {
    pub left: L,
    pub right: R,
}

impl<L, R> Algebra for Union<L, R> where L: Algebra, R: Algebra {
    fn evaluate(self) -> bool {
        self.left.evaluate() | self.right.evaluate()
    }
}
