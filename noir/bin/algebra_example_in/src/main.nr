//! Hand-written worked example: BGP + Filter (`IN`) via the readable
//! per-operator algebra surface.
//!
//! Companion to `algebra_example` -- same BGP shape, but with an
//! `IN (...)` filter on `?s` instead of a numeric range on `?o`.
//!
//! ```sparql
//! PREFIX ex: <http://example.org/>
//! SELECT ?s ?o WHERE {
//!   ?s ex:age ?o .
//!   FILTER (?s IN (ex:alice, ex:bob, ex:carol))
//! }
//! ```
//!
//! The `In<3>` evaluator unrolls to three field-equality
//! comparisons (`?s == alice`, `?s == bob`, `?s == carol`) joined by
//! disjunction. The monolithic surface does not implement `IN`
//! today; this package exists to capture the readable-surface ACIR
//! opcode count for the bench row in
//! `bench/readable-vs-monolithic.md`.

use dep::types::{Root, Triple};
use dep::utils::verify_signature;
use dep::consts::signature::PubKey;
use dep::consts;

use dep::algebra::algebra::traits::Algebra;
use dep::algebra::algebra::bgp::{Bgp, TriplePattern, PatternPos};
use dep::algebra::algebra::filter::Filter;
use dep::algebra::algebra::project::Project;
use dep::algebra::expr::in_set::In;

// Public-input layout mirrors `algebra_example::Variables`. Even
// though the filter no longer reads `?o`, the projection list is the
// same so the public-input shape is identical -- keeps the bench
// row comparable.
pub struct Variables {
    pub s: Field,
    pub o: Field,
}

// Default-graph encoding: type-code 4, empty string. Same constant
// as `algebra_example::default_graph_hash`.
fn default_graph_hash() -> Field {
    consts::hash2([4, consts::encode_string("")])
}

// Predicate IRI `<http://example.org/age>`.
fn ex_age_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/age")])
}

// Three constants in the `IN (...)` list.
fn ex_alice_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/alice")])
}

fn ex_bob_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/bob")])
}

fn ex_carol_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/carol")])
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
        predicate: PatternPos { expected: ex_age_hash() },
        object:    PatternPos { expected: variables.o },
        graph:     PatternPos { expected: default_graph_hash() },
    };

    let q: Project<Filter<Bgp<1>, In<3>>> = Project {
        inner: Filter {
            inner: Bgp {
                triples: bgp,
                patterns: [pat],
                root_value: roots[0].value,
            },
            expr: In {
                var: variables.s,
                set: [ex_alice_hash(), ex_bob_hash(), ex_carol_hash()],
            },
        },
    };

    assert(q.evaluate(), "Readable algebra IN query unsatisfied");
}
