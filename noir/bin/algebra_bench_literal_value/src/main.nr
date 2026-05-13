//! Readable-algebra bench row for `transform/tests/snapshots/literal_value.*`.
//!
//! ```sparql
//! SELECT ?s WHERE { ?s <http://example.org/label> "hello" }
//! ```
//!
//! The object position is a constant simple literal -- the readable
//! surface materialises its term hash as a `PatternPos` whose
//! `expected` is the precomputed `consts::hash2 ... hash4 ...`
//! identical to the monolithic surface's emit.

use dep::consts;
use dep::consts::signature::PubKey;
use dep::types::{Root, Triple};
use dep::utils::verify_signature;

use dep::algebra::algebra::bgp::{Bgp, PatternPos, TriplePattern};
use dep::algebra::algebra::project::Project;
use dep::algebra::algebra::traits::Algebra;

pub struct Variables {
    pub s: Field,
}

fn ex_label_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/label")])
}

// "hello" simple literal -- xsd:string-typed plain literal. Same
// encoding the monolithic surface emits at this triple's object
// position.
fn hello_literal_hash() -> Field {
    consts::hash2([
        2,
        consts::hash4([
            consts::encode_string("hello"),
            consts::encode_string("hello"),
            consts::encode_string(""),
            consts::encode_string("http://www.w3.org/2001/XMLSchema#string"),
        ]),
    ])
}

fn main(public_key: [PubKey; 1], roots: [Root; 1], bgp: [Triple; 1], variables: pub Variables) {
    for i in 0..1 {
        verify_signature(public_key[0], roots[i]);
    }

    let pat = TriplePattern {
        subject: PatternPos { expected: variables.s },
        predicate: PatternPos { expected: ex_label_hash() },
        object: PatternPos { expected: hello_literal_hash() },
    };

    let q: Project<Bgp<1>> =
        Project { inner: Bgp { triples: bgp, patterns: [pat], root_value: roots[0].value } };

    assert(q.evaluate(), "Readable algebra literal_value query unsatisfied");
}
