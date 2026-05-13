//! Readable-algebra bench row for
//! `transform/tests/snapshots/filter_isiri.*`.
//!
//! ```sparql
//! SELECT ?s WHERE { ?s <http://example.org/knows> ?o . FILTER (isIRI(?s)) }
//! ```
//!
//! Readable shape: `Project<Filter<Bgp<1>, IsIri>>`. `IsIri.type_witness`
//! is sourced from a hidden-input `u8` witness (the term's encoded
//! type code) -- the monolithic surface does the same with
//! `assert(hidden[0] == 0)` (see `filter_isiri.sparql.nr` line 15).

use dep::types::{Root, Triple};
use dep::utils::verify_signature;
use dep::consts::signature::PubKey;
use dep::consts;

use dep::algebra::algebra::traits::Algebra;
use dep::algebra::algebra::bgp::{Bgp, TriplePattern, PatternPos};
use dep::algebra::algebra::filter::Filter;
use dep::algebra::algebra::project::Project;
use dep::algebra::expr::term_tests::IsIri;

pub struct Variables {
    pub s: Field,
}

pub type Hidden = [Field; 1];

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
    object_var: Field, // ?o unprojected
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

    let q: Project<Filter<Bgp<1>, IsIri>> = Project {
        inner: Filter {
            inner: Bgp {
                triples: bgp,
                patterns: [pat],
                root_value: roots[0].value,
            },
            expr: IsIri { type_witness: hidden[0] as u8 },
        },
    };

    assert(q.evaluate(), "Readable algebra filter_isiri query unsatisfied");
}
