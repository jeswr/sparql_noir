//! Readable-algebra bench row for `transform/tests/snapshots/basic_bgp.*`.
//!
//! ```sparql
//! SELECT ?s ?p ?o WHERE { ?s ?p ?o }
//! ```
//!
//! Compare this `main.nr` against
//! `bench/monolithic_basic_bgp/src/sparql.nr` -- the readable surface
//! expresses the same three position-equalities and one Merkle
//! inclusion as `Project<Bgp<1>>`.

use dep::types::{Root, Triple};
use dep::utils::verify_signature;
use dep::consts::signature::PubKey;
use dep::consts;

use dep::algebra::algebra::traits::Algebra;
use dep::algebra::algebra::bgp::{Bgp, TriplePattern, PatternPos};
use dep::algebra::algebra::project::Project;

pub struct Variables {
    pub s: Field,
    pub p: Field,
    pub o: Field,
}

// Default-graph encoding -- type-code 4, empty string. See
// `algebra_example::default_graph_hash`.
fn default_graph_hash() -> Field {
    consts::hash2([4, consts::encode_string("")])
}

fn main(
    public_key: [PubKey; 1],
    roots: [Root; 1],
    bgp: [Triple; 1],
    variables: pub Variables,
) {
    for i in 0..1 {
        verify_signature(public_key[0], roots[i]);
    }

    let pat = TriplePattern {
        subject:   PatternPos { expected: variables.s },
        predicate: PatternPos { expected: variables.p },
        object:    PatternPos { expected: variables.o },
        graph:     PatternPos { expected: default_graph_hash() },
    };

    let q: Project<Bgp<1>> = Project {
        inner: Bgp {
            triples: bgp,
            patterns: [pat],
            root_value: roots[0].value,
        },
    };

    assert(q.evaluate(), "Readable algebra basic_bgp query unsatisfied");
}
