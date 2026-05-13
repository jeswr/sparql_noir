//! Readable-algebra bench row for
//! `transform/tests/snapshots/filter_comparison.*`.
//!
//! Readable shape: `Project<Filter<Bgp<1>, And<NeqF, GtI64>>>`. The
//! filter is a mixed conjunction -- hash-domain inequality on
//! `hidden[0]`/`hidden[1]` plus an i64 ordered comparison on
//! `hidden[2]`/`hidden[3]`. Mirrors the monolithic emit one-for-one
//! (see `filter_comparison.sparql.nr` line 17).

use dep::consts;
use dep::consts::signature::PubKey;
use dep::types::{Root, Triple};
use dep::utils::verify_signature;

use dep::algebra::algebra::bgp::{Bgp, PatternPos, TriplePattern};
use dep::algebra::algebra::filter::Filter;
use dep::algebra::algebra::project::Project;
use dep::algebra::algebra::traits::Algebra;
use dep::algebra::expr::atoms::VarI64;
use dep::algebra::expr::cmp::{GtI64, NeqF};
use dep::algebra::expr::logical::And;

pub struct Variables {
    pub s: Field,
    pub o: Field,
}

pub type Hidden = [Field; 4];

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

    let q: Project<Filter<Bgp<1>, And<NeqF, GtI64>>> = Project {
        inner: Filter {
            inner: Bgp { triples: bgp, patterns: [pat], root_value: roots[0].value },
            expr: And {
                left: NeqF { left: hidden[0], right: hidden[1] },
                right: GtI64 {
                    left: VarI64 { value: hidden[2] as i64 },
                    right: VarI64 { value: hidden[3] as i64 },
                },
            },
        },
    };

    assert(q.evaluate(), "Readable algebra filter_comparison query unsatisfied");
}
