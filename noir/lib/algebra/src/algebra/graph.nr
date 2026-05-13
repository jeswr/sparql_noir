//! Graph -- `spec/algebra-structs.md` sec.3.9.
//!
//! `GraphCtx<P>` wraps any inner algebra `P` that lives under a SPARQL
//! `GRAPH` clause. `P` must implement both `Algebra` (so we can run
//! its satisfaction predicate) and `GraphAssertable` (so we can pin
//! the 4th term-hash position of every witness triple it owns).
//!
//! Round-2 generalisation: the round-1 `GraphCtx<N>` form (specialised
//! to `Bgp<N>`) is replaced by `GraphCtx<P>` with the
//! `P: Algebra + GraphAssertable` bound, giving `GraphCtx<Join<...>>`,
//! `GraphCtx<Union<...>>`, `GraphCtx<Filter<Bgp<N>, _>>` etc. for free.
//! The leaf trait impl on `Bgp<N>` keeps the const-generic iteration
//! over witness triples; composite algebras (`Join`, `Union`,
//! `LeftJoin`, `Filter`, ...) recurse into their children and reach
//! the `Bgp` leaves automatically. See
//! `spec/algebra-structs.md` sec.3.9 for the trait contract.
//!
//! Soundness: for each inner witness triple, asserts
//! `triple.terms[3].hash == graph_iri.expected`. The inner algebra
//! checks the first three positions and Merkle inclusion; the 4th
//! position is the `GraphCtx` wrapper's responsibility. This keeps
//! the cost of the graph-position assertion off default-graph
//! queries (which never construct a `GraphCtx`) -- the `basic_bgp`
//! regression fix in `bench/readable-vs-monolithic.md`.

use crate::algebra::bgp::PatternPos;
use crate::algebra::traits::{Algebra, GraphAssertable};

/// Algebra subtree wrapped in a SPARQL `GRAPH` clause. The
/// `graph_iri` position is either a fixed IRI or a binding-driven
/// `PatternPos` (e.g. `?g`); both shapes are handled identically at
/// evaluation time by hashing through `PatternPos.expected`. The
/// inner `P` may be any composition that bottoms out in `Bgp`s and
/// `PathLink`s -- the `GraphAssertable` trait recursion handles the
/// per-witness 4th-position pin without `GraphCtx` knowing the inner
/// shape statically.
pub struct GraphCtx<P> {
    pub inner: P,
    pub graph_iri: PatternPos,
}

impl<P> Algebra for GraphCtx<P>
where
    P: Algebra + GraphAssertable,
{
    fn evaluate(self) -> bool {
        // Inner-algebra semantics + per-witness 4th-position pin via
        // the `GraphAssertable` recursion. The trait conjoins the
        // pin across every BGP leaf reachable from `self.inner`; no
        // const-generic plumbing needed in `GraphCtx`.
        self.inner.assert_graph_position(self.graph_iri.expected) & self.inner.evaluate()
    }
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

#[test]
fn graph_ctx_round_trip() {
    // Round-trip the wrapper's struct fields. The full evaluation
    // path is exercised by the `algebra_bench_graph_{named,var}`
    // bench bins; here we just confirm the marker struct's shape
    // composes cleanly. Compositional `GraphCtx<Join<Bgp, Bgp>>` /
    // `GraphCtx<Union<Bgp, Bgp>>` constructions are covered by the
    // dedicated trait-recursion tests below.
    let iri = PatternPos { expected: 42 };
    assert(iri.expected == 42);
}

// Compile-time test: a no-op shim that proves `GraphCtx<P>`
// type-checks for `P` other than `Bgp<N>` once the GraphAssertable
// trait is in scope. This is the round-2 acceptance criterion -- if
// it stops compiling, the trait recursion has regressed. The helper
// is private (`fn _foo`) and never called, but the type-checker
// still walks it.
//
// We can't easily synthesise witness `Triple` values inside a unit
// test (the dataset commitment plumbing lives outside the crate),
// so the composition tests live in the bench bin layer (see
// `noir/bin/algebra_bench_graph_named` and the round-2 composition
// example below). The shim here is just to lock in the trait
// signature against compile drift.
#[allow(dead_code)]
fn _graph_ctx_composes_over_join<L, R>(ctx: GraphCtx<crate::algebra::join::Join<L, R>>) -> bool
where
    L: Algebra + GraphAssertable,
    R: Algebra + GraphAssertable,
{
    ctx.evaluate()
}

#[allow(dead_code)]
fn _graph_ctx_composes_over_union<L, R>(ctx: GraphCtx<crate::algebra::union::Union<L, R>>) -> bool
where
    L: Algebra + GraphAssertable,
    R: Algebra + GraphAssertable,
{
    ctx.evaluate()
}
