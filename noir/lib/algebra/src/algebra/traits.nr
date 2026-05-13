//! Core traits implemented by every algebra and expression operator.
//!
//! See `spec/algebra-structs.md` sec.1 for the design rationale.
//!
//! Two traits cover the round-1 surface:
//!
//! - `Algebra` -- implemented by every algebra-level operator
//!   (BGP, Filter, Join, Union, LeftJoin, Extend, Project, GraphCtx,
//!   path atoms, post-process modifiers). `evaluate` returns the
//!   satisfaction predicate of the operator on its self-contained
//!   witness data.
//! - `ExprBool` -- implemented by every boolean expression head
//!   (atom, comparison, logical combinator, term test, hash-equality
//!   string-fn shortcut). `evaluate` returns a `bool` corresponding
//!   to the expression's effective boolean value.
//!
//! `ExprField` (value expressions returning a `Field` hash) is a
//! round-2 extension; the round-1 surface only needs `ExprBool` and
//! delegates "non-boolean" expression heads to direct field reads in
//! the operator structs themselves (see `expr::atoms::Var`).
//!
//! Noir requires trait bounds to call methods on generic type
//! parameters (see `/noir-lang/noir` docs, "Calling functions on
//! generic parameters"). These traits are therefore load-bearing --
//! without them, `Filter<P, E>::evaluate` cannot dispatch into
//! `inner.evaluate()` / `expr.evaluate()`.

/// Algebra-level operator. Each implementation is self-contained:
/// the operator owns the witness triples, root values, sentinels,
/// and pre-baked pattern positions it needs. `evaluate` consumes
/// `self` and returns the satisfaction predicate.
///
/// The top-level circuit calls `q.evaluate()` once and `assert`s the
/// result.
pub trait Algebra {
    fn evaluate(self) -> bool;
}

/// Boolean expression head (FILTER predicate, BIND/Extend assignment
/// predicate, etc.). `evaluate` returns the expression's effective
/// boolean value as a plain `bool` -- round-1 expression heads
/// either succeed cleanly or are expected to be pre-validated by the
/// transform (see `spec/algebra-structs.md` sec.3.5 for the EBV-error
/// note).
pub trait ExprBool {
    fn evaluate(self) -> bool;
}
