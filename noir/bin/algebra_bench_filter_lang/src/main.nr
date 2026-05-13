//! Readable-algebra bench row for
//! `transform/tests/snapshots/filter_lang.*`.
//!
//! ```sparql
//! SELECT ?s WHERE { ?s <http://example.org/label> ?o . FILTER (LANG(?o) = "en") }
//! ```
//!
//! Readable shape: `Project<Filter<Bgp<1>, EqF>>`. `LANG` lowers via
//! the hash-equality shortcut today (see `SPARQL_ROADMAP.md` sec.2.3)
//! -- the transform allocates a hidden witness for `LANG(?o)` and
//! the readable surface compares it to the precomputed
//! `consts::encode_string("en")` constant.

use dep::consts;
use dep::consts::signature::PubKey;
use dep::types::{Root, Triple};
use dep::utils::verify_signature;

use dep::algebra::algebra::bgp::{Bgp, PatternPos, TriplePattern};
use dep::algebra::algebra::filter::Filter;
use dep::algebra::algebra::project::Project;
use dep::algebra::algebra::traits::Algebra;
use dep::algebra::expr::cmp::EqF;

pub struct Variables {
    pub s: Field,
}

pub type Hidden = [Field; 1];

fn ex_label_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/label")])
}

fn en_string_hash() -> Field {
    consts::encode_string("en")
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
        subject: PatternPos { expected: variables.s },
        predicate: PatternPos { expected: ex_label_hash() },
        object: PatternPos { expected: object_var },
    };

    let q: Project<Filter<Bgp<1>, EqF>> = Project {
        inner: Filter {
            inner: Bgp { triples: bgp, patterns: [pat], root_value: roots[0].value },
            expr: EqF { left: hidden[0], right: en_string_hash() },
        },
    };

    assert(q.evaluate(), "Readable algebra filter_lang query unsatisfied");
}
