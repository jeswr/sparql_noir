//! Readable-algebra bench row for
//! `transform/tests/snapshots/graph_var.*`.
//!
//! ```sparql
//! SELECT ?s ?g WHERE { GRAPH ?g { ?s <http://example.org/p> ?o } }
//! ```
//!
//! `GraphCtx`'s `graph_iri` is now a binding-driven `PatternPos`
//! (`variables.g`) rather than a constant -- the same shape, the
//! transform just plugs a binding-ref into `expected`.

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
    pub g: Field,
}

fn ex_p_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/p")])
}

fn main(
    public_key: [PubKey; 1],
    roots: [Root; 1],
    bgp: [Triple; 1],
    variables: pub Variables,
    object_var: Field, // ?o is unprojected -- unconstrained on the monolithic side
) {
    for i in 0..1 {
        verify_signature(public_key[0], roots[i]);
    }

    let graph_pos = PatternPos { expected: variables.g };
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

    assert(q.evaluate(), "Readable algebra graph_var query unsatisfied");
}
