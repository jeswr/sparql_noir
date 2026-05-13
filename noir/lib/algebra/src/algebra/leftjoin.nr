//! LeftJoin (OPTIONAL) -- `spec/algebra-structs.md` sec.3.4.
//!
//! Round-1 covers the **easy-case OPTIONAL** collapse (see
//! `spec/exists.md` sec.4.1) where every variable in the OPTIONAL is
//! either outer-bound or constant after substitution. The collapsed
//! form is:
//!
//! ```text
//! mandatory.evaluate() & (matched | unmatched)
//! ```
//!
//! where `matched` is the boolean-form of the inner BGP/pattern match
//! against a `Bgp<1>` slot, and `unmatched` is a boolean
//! non-membership predicate (sentinel-aware) attesting that the
//! substituted ground triple is absent from the dataset.
//!
//! The power-set OPTIONAL (when variables in the OPTIONAL are not
//! all outer-bound) is **deferred** -- see the spec doc sec.3.4 and
//! `SPARQL_ROADMAP.md` sec.3 for the rationale.
//!
//! The non-membership primitive (`unmatched`) is a function call
//! into `dep::utils::verify_non_membership_no_inclusion_check`. The
//! `OptionalArm` struct carries the bracket-leaf witnesses plus the
//! absent-hash that the call needs. We expose it as an explicit type
//! rather than burying it inside `LeftJoin` because Lean will mirror
//! it (it is a top-level proof obligation in the algebra tree).

use crate::algebra::traits::{Algebra, ExprBool};

/// The "matched" + "unmatched" disjunction inside an OPTIONAL.
///
/// `matched` is any `ExprBool` (typically a conjunction of
/// position-equality predicates against a single `Triple` slot;
/// see `expr::cmp::Eq` for the leaf shape). `unmatched` is also
/// an `ExprBool` whose `evaluate` performs the non-membership
/// witness check.
///
/// Splitting `OptionalArm` from `LeftJoin` keeps the algebra tree
/// readable: the OPTIONAL contributes one disjunction in the
/// satisfaction predicate, and that disjunction is a single field
/// of `LeftJoin`.
pub struct OptionalArm<M, U> {
    pub matched: M,
    pub unmatched: U,
}

impl<M, U> ExprBool for OptionalArm<M, U> where M: ExprBool, U: ExprBool {
    fn evaluate(self) -> bool {
        self.matched.evaluate() | self.unmatched.evaluate()
    }
}

pub struct LeftJoin<L, A> {
    pub mandatory: L,
    pub optional_arm: A,
}

impl<L, A> Algebra for LeftJoin<L, A> where L: Algebra, A: ExprBool {
    fn evaluate(self) -> bool {
        self.mandatory.evaluate() & self.optional_arm.evaluate()
    }
}
