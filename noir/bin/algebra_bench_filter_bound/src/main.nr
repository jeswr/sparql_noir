//! Readable-algebra bench row for
//! `transform/tests/snapshots/filter_bound.*`.
//!
//! ```sparql
//! SELECT ?s WHERE { ?s <http://example.org/knows> ?o . FILTER (BOUND(?s)) }
//! ```
//!
//! `BOUND` is folded by the transform's static analysis: variables
//! in the projection list are always bound, so the monolithic emit
//! reduces to `assert(true)` (see `filter_bound.sparql.nr` line 14).
//! The readable surface mirrors that with `Bound { bound: true }`.

use dep::types::{Root, Triple};
use dep::utils::verify_signature;
use dep::consts::signature::PubKey;
use dep::consts;

use dep::algebra::algebra::traits::Algebra;
use dep::algebra::algebra::bgp::{Bgp, TriplePattern, PatternPos};
use dep::algebra::algebra::filter::Filter;
use dep::algebra::algebra::project::Project;
use dep::algebra::expr::term_tests::Bound;

pub struct Variables {
    pub s: Field,
}

fn default_graph_hash() -> Field {
    consts::hash2([4, consts::encode_string("")])
}

fn ex_knows_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/knows")])
}

fn main(
    public_key: [PubKey; 1],
    roots: [Root; 1],
    bgp: [Triple; 1],
    variables: pub Variables,
    object_var: Field, // ?o unprojected -- unconstrained on the monolithic side
) {
    for i in 0..1 {
        verify_signature(public_key[0], roots[i]);
    }

    let pat = TriplePattern {
        subject:   PatternPos { expected: variables.s },
        predicate: PatternPos { expected: ex_knows_hash() },
        object:    PatternPos { expected: object_var },
        graph:     PatternPos { expected: default_graph_hash() },
    };

    let q: Project<Filter<Bgp<1>, Bound>> = Project {
        inner: Filter {
            inner: Bgp {
                triples: bgp,
                patterns: [pat],
                root_value: roots[0].value,
            },
            expr: Bound { bound: true },
        },
    };

    assert(q.evaluate(), "Readable algebra filter_bound query unsatisfied");
}
