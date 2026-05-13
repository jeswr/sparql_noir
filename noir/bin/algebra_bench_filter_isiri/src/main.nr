//! Readable-algebra bench row for
//! `transform/tests/snapshots/filter_isiri.*`.
//!
//! ```sparql
//! SELECT ?s WHERE { ?s <http://example.org/knows> ?o . FILTER (isIRI(?s)) }
//! ```
//!
//! Readable shape: `Project<Filter<Bgp<1>, IsIriField>>`. The
//! type witness is sourced directly from the `Field`-typed hidden
//! input -- the monolithic surface does the same with
//! `assert(hidden[0] == 0)` (see `filter_isiri.sparql.nr` line 15).
//! Round-2 switched from `IsIri { type_witness: hidden[0] as u8 }`
//! to `IsIriField { type_witness: hidden[0] }` to close the +10
//! Expression Width delta documented in
//! `bench/readable-vs-monolithic.md`; the `Field -> u8` cast carried
//! an 8-bit range check that the monolithic surface elides by
//! comparing on the `Field` witness directly.

use dep::consts;
use dep::consts::signature::PubKey;
use dep::types::{Root, Triple};
use dep::utils::verify_signature;

use dep::algebra::algebra::bgp::{Bgp, PatternPos, TriplePattern};
use dep::algebra::algebra::filter::Filter;
use dep::algebra::algebra::project::Project;
use dep::algebra::algebra::traits::Algebra;
use dep::algebra::expr::term_tests::IsIriField;

pub struct Variables {
    pub s: Field,
}

pub type Hidden = [Field; 1];

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
        subject: PatternPos { expected: variables.s },
        predicate: PatternPos { expected: ex_knows_hash() },
        object: PatternPos { expected: object_var },
    };

    let q: Project<Filter<Bgp<1>, IsIriField>> = Project {
        inner: Filter {
            inner: Bgp { triples: bgp, patterns: [pat], root_value: roots[0].value },
            expr: IsIriField { type_witness: hidden[0] },
        },
    };

    assert(q.evaluate(), "Readable algebra filter_isiri query unsatisfied");
}
