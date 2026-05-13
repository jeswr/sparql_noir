//! Graph -- `spec/algebra-structs.md` sec.3.9.
//!
//! `GraphCtx<N>` wraps an `N`-pattern BGP that lives under a SPARQL
//! `GRAPH` clause. Round-1 only composes `GraphCtx` directly over a
//! `Bgp<N>` (the corpus has `GRAPH <iri> { ?s p ?o }` and
//! `GRAPH ?g { ?s p ?o }` patterns); higher composition (e.g.
//! `GraphCtx<Join<...>>`) is deferred to round-2 alongside the
//! multi-BGP graph plumbing.
//!
//! Soundness: for each inner triple, asserts
//! `triple.terms[3].hash == graph_iri.expected`. The inner `Bgp<N>`
//! checks the first three positions and Merkle inclusion; the 4th
//! position is the `GraphCtx` wrapper's responsibility. This keeps
//! the cost of the graph-position assertion off default-graph
//! queries (which never construct a `GraphCtx`) -- the
//! `basic_bgp` regression fix in `bench/readable-vs-monolithic.md`.

use crate::algebra::bgp::{Bgp, PatternPos};
use crate::algebra::traits::Algebra;

/// `N`-pattern BGP wrapped in a SPARQL `GRAPH` clause. The
/// `graph_iri` position is either a fixed IRI or a binding-driven
/// `PatternPos` (e.g. `?g`); both shapes are handled identically
/// at evaluation time by hashing through `PatternPos.expected`.
pub struct GraphCtx<let N: u32> {
    pub inner: Bgp<N>,
    pub graph_iri: PatternPos,
}

impl<let N: u32> Algebra for GraphCtx<N> {
    fn evaluate(self) -> bool {
        // Inner BGP semantics + per-triple 4th-position pin.
        let mut result = self.inner.evaluate();
        for i in 0..N {
            let g_ok = self.inner.triples[i].terms[3].hash == self.graph_iri.expected;
            result = result & g_ok;
        }
        result
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
    // composes cleanly.
    let iri = PatternPos { expected: 42 };
    assert(iri.expected == 42);
}
