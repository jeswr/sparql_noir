//! Core traits implemented by every algebra and expression operator.
//!
//! See `spec/algebra-structs.md` sec.1 for the design rationale.
//!
//! Three traits cover the round-2 surface:
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
//! - `GraphAssertable` -- implemented by every algebra operator that
//!   carries witness triples whose 4th (graph) term-hash position
//!   must be pinned to a `GRAPH`-qualified IRI. Lets `GraphCtx<P>`
//!   compose over arbitrary inner algebras (`Bgp`, `Join`, `Union`,
//!   `LeftJoin`, `Filter`, `Extend`, `Project`, path atoms) rather
//!   than being specialised to `Bgp<N>`. See `spec/algebra-structs.md`
//!   sec.3.9 for the composition rules and the per-operator notes.
//!
//! `ExprField` (value expressions returning a `Field` hash) is a
//! round-2+ extension; the round-1 surface only needs `ExprBool` and
//! delegates "non-boolean" expression heads to direct field reads in
//! the operator structs themselves (see `expr::atoms::Var`).
//!
//! Noir requires trait bounds to call methods on generic type
//! parameters (see `/noir-lang/noir` docs, "Calling functions on
//! generic parameters"). These traits are therefore load-bearing --
//! without them, `Filter<P, E>::evaluate` cannot dispatch into
//! `inner.evaluate()` / `expr.evaluate()`, and `GraphCtx<P>` cannot
//! reach into a generic child to pin its 4th-position hashes.

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

/// Algebra operators whose witness triples can have their 4th
/// (graph) term-hash position pinned to a `GRAPH`-qualified IRI.
///
/// `assert_graph_position(expected)` returns `true` iff every witness
/// triple owned by `self` has `terms[3].hash == expected`. The
/// per-operator implementations recurse into children:
///
/// - `Bgp<N>` iterates over its `N` triples (the leaf case).
/// - `Join<L, R>` / `Union<L, R>` conjoin both children's
///   assertions: the witness arrays of both branches must come from
///   the named graph regardless of which branch's `evaluate` is the
///   one that satisfies the disjunction at the top level. The graph
///   binding lives in the dataset commitment, not in the algebra
///   tree's disjunctive shape.
/// - `LeftJoin<L, A>` pins only the mandatory side's witnesses; the
///   optional arm's `matched` predicate is itself an `ExprBool` and
///   the caller bakes any graph-position pinning into it (see
///   `algebra::leftjoin` module docs for the round-1 OPTIONAL
///   collapse contract).
/// - `Filter<P, E>` / `Extend<P, B>` / `Project<P>` / `Distinct<P>`
///   / `Reduced<P>` / `Order<P>` / `Slice<P>` / `PathInverse<P>` /
///   `PathNps<M>` delegate to the inner algebra; the boolean
///   expression / modifier layer has no witness triples of its own.
/// - `PathLink` is the single-triple leaf case (mirrors `Bgp<1>`).
///
/// `GraphCtx<P>` itself does **not** implement `GraphAssertable`:
/// the type system already pins its inner triples through the
/// `inner.assert_graph_position(self.graph_iri.expected)` call in
/// `evaluate`, and nested `GRAPH` clauses are W3C-illegal (SPARQL
/// 1.1 sec.18.2.5.5). The transform rejects them at lowering time.
pub trait GraphAssertable {
    fn assert_graph_position(self, expected: Field) -> bool;
}
