//! Readable-algebra bench row for
//! `transform/tests/snapshots/filter_inequality.*`.
//!
//! ```sparql
//! SELECT ?s ?o WHERE { ?s <http://example.org/knows> ?o . FILTER (?s != ?o) }
//! ```
//!
//! Readable shape: `Project<Filter<Bgp<1>, NeqF>>`. The `NeqF`
//! expression mirrors the monolithic surface's
//! `assert(!(hidden[0] == hidden[1]))` -- both sides are read out of
//! the same hidden-input slots the transform allocates today.

use dep::types::{Root, Triple};
use dep::utils::verify_signature;
use dep::consts::signature::PubKey;
use dep::consts;

use dep::algebra::algebra::traits::Algebra;
use dep::algebra::algebra::bgp::{Bgp, TriplePattern, PatternPos};
use dep::algebra::algebra::filter::Filter;
use dep::algebra::algebra::project::Project;
use dep::algebra::expr::cmp::NeqF;

pub struct Variables {
    pub s: Field,
    pub o: Field,
}

pub type Hidden = [Field; 2];

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
    hidden: Hidden,
) {
    for i in 0..1 {
        verify_signature(public_key[0], roots[i]);
    }

    let pat = TriplePattern {
        subject:   PatternPos { expected: variables.s },
        predicate: PatternPos { expected: ex_knows_hash() },
        object:    PatternPos { expected: variables.o },
        graph:     PatternPos { expected: default_graph_hash() },
    };

    let q: Project<Filter<Bgp<1>, NeqF>> = Project {
        inner: Filter {
            inner: Bgp {
                triples: bgp,
                patterns: [pat],
                root_value: roots[0].value,
            },
            expr: NeqF { left: hidden[0], right: hidden[1] },
        },
    };

    assert(q.evaluate(), "Readable algebra filter_inequality query unsatisfied");
}
