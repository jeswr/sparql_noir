//! Readable-algebra bench row for
//! `transform/tests/snapshots/graph_named.*`.
//!
//! ```sparql
//! SELECT ?s WHERE {
//!   GRAPH <http://example.org/g1> { ?s <http://example.org/p> ?o }
//! }
//! ```
//!
//! `GraphCtx` is a no-op wrapper: the transform substitutes the graph
//! IRI into the inner `TriplePattern.graph` slot at build time (see
//! `spec/algebra-structs.md` sec.3.9). The wrapper exists so the
//! algebra tree faithfully records the `GRAPH` boundary for the Lean
//! correspondence.

use dep::types::{Root, Triple};
use dep::utils::verify_signature;
use dep::consts::signature::PubKey;
use dep::consts;

use dep::algebra::algebra::traits::Algebra;
use dep::algebra::algebra::bgp::{Bgp, TriplePattern, PatternPos};
use dep::algebra::algebra::graph::GraphCtx;
use dep::algebra::algebra::project::Project;

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
        subject:   PatternPos { expected: variables.s },
        predicate: PatternPos { expected: ex_p_hash() },
        object:    PatternPos { expected: object_var },
        graph:     graph_pos,
    };

    let q: Project<GraphCtx<Bgp<1>>> = Project {
        inner: GraphCtx {
            inner: Bgp {
                triples: bgp,
                patterns: [pat],
                root_value: roots[0].value,
            },
            graph_iri: graph_pos,
        },
    };

    assert(q.evaluate(), "Readable algebra graph_named query unsatisfied");
}
