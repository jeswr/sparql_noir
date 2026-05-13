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

use dep::consts;
use dep::consts::signature::PubKey;
use dep::types::{Root, Triple};
use dep::utils::verify_signature;

use dep::algebra::algebra::bgp::{Bgp, PatternPos, TriplePattern};
use dep::algebra::algebra::filter::Filter;
use dep::algebra::algebra::project::Project;
use dep::algebra::algebra::traits::Algebra;
use dep::algebra::expr::cmp::NeqF;

pub struct Variables {
    pub s: Field,
    pub o: Field,
}

pub type Hidden = [Field; 2];

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
        subject: PatternPos { expected: variables.s },
        predicate: PatternPos { expected: ex_knows_hash() },
        object: PatternPos { expected: variables.o },
    };

    let q: Project<Filter<Bgp<1>, NeqF>> = Project {
        inner: Filter {
            inner: Bgp { triples: bgp, patterns: [pat], root_value: roots[0].value },
            expr: NeqF { left: hidden[0], right: hidden[1] },
        },
    };

    assert(q.evaluate(), "Readable algebra filter_inequality query unsatisfied");
}
