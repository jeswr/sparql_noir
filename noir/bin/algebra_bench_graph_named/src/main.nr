//! Readable-algebra bench row for
//! `transform/tests/snapshots/graph_named.*`.
//!
//! ```sparql
//! SELECT ?s WHERE {
//!   GRAPH <http://example.org/g1> { ?s <http://example.org/p> ?o }
//! }
//! ```
//!
//! `GraphCtx<P>` owns the per-triple graph-position assertion
//! `triple.terms[3].hash == graph_iri.expected`, delegated to the
//! inner algebra `P` through the `GraphAssertable` trait. Here
//! `P = Bgp<1>`; round-2 also lets `P` be `Join`, `Union`, `Filter`,
//! etc. (see `spec/algebra-structs.md` sec.3.9). Default-graph
//! patterns do not construct a `GraphCtx`, so they pay none of that
//! cost (see the `basic_bgp` bench analysis in
//! `bench/readable-vs-monolithic.md`).

use dep::consts;
use dep::consts::signature::PubKey;
use dep::types::{Root, Triple};
use dep::utils::verify_signature;

use dep::algebra::algebra::bgp::{Bgp, PatternPos, TriplePattern};
use dep::algebra::algebra::graph::GraphCtx;
use dep::algebra::algebra::project::Project;
use dep::algebra::algebra::traits::Algebra;

pub struct Variables {
    pub s: Field,
}

fn ex_p_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/p")])
}

fn ex_g1_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/g1")])
}

fn main(
    public_key: [PubKey; 1],
    roots: [Root; 1],
    bgp: [Triple; 1],
    variables: pub Variables,
    object_var: Field, // ?o is implicit -- not projected, sourced from witness
) {
    for i in 0..1 {
        verify_signature(public_key[0], roots[i]);
    }

    let graph_pos = PatternPos { expected: ex_g1_hash() };
    let pat = TriplePattern {
        subject: PatternPos { expected: variables.s },
        predicate: PatternPos { expected: ex_p_hash() },
        object: PatternPos { expected: object_var },
    };

    let q: Project<GraphCtx<Bgp<1>>> = Project {
        inner: GraphCtx {
            inner: Bgp { triples: bgp, patterns: [pat], root_value: roots[0].value },
            graph_iri: graph_pos,
        },
    };

    assert(q.evaluate(), "Readable algebra graph_named query unsatisfied");
}
