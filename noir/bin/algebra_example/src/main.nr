//! Hand-written worked example: BGP + Filter via the readable
//! per-operator algebra surface.
//!
//! Query (the same one captured in
//! `transform/tests/snapshots/filter_and_or.*` for the monolithic
//! surface):
//!
//! ```sparql
//! PREFIX ex: <http://example.org/>
//! PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
//! SELECT ?s ?o WHERE {
//!   ?s ex:age ?o .
//!   FILTER ((?o > "18"^^xsd:integer) && (?o < "30"^^xsd:integer))
//! }
//! ```
//!
//! Compare this `main.nr` to
//! `transform/tests/snapshots/filter_and_or.sparql.nr` (the
//! monolithic `checkBinding` body) -- the readable surface
//! reorganises the same constraints as a tree of typed operator
//! structs whose `evaluate()` methods are documented one per file
//! in `dep::algebra::algebra::*` and `dep::algebra::expr::*`.

use dep::consts;
use dep::consts::signature::PubKey;
use dep::types::{Root, Triple};
use dep::utils::verify_signature;

use dep::algebra::algebra::bgp::{Bgp, PatternPos, TriplePattern};
use dep::algebra::algebra::filter::Filter;
use dep::algebra::algebra::project::Project;
use dep::algebra::algebra::traits::Algebra;
use dep::algebra::expr::atoms::VarI64;
use dep::algebra::expr::cmp::{GtI64, LtI64};
use dep::algebra::expr::logical::And;

// Public-input layout for this query. The shape matches the
// monolithic `Variables` / `Hidden` types one-for-one (compare
// `filter_and_or.sparql.nr`).
pub struct Variables {
    pub s: Field,
    pub o: Field,
}

// Four hidden inputs: `?o`-value, "18", `?o`-value, "30". The
// transform's monolithic emit allocates these per FILTER
// comparison; we mirror the layout exactly so a verifier built
// against the monolithic snapshot can also drive this circuit.
pub type Hidden = [Field; 4];

// Predicate IRI encoding for `<http://example.org/age>`. Type-code 0
// for NamedNode + Pedersen-hashed lexical form.
fn ex_age_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://example.org/age")])
}

fn main(
    public_key: [PubKey; 1],
    roots: [Root; 1],
    bgp: [Triple; 1],
    variables: pub Variables,
    hidden: Hidden,
) {
    // Signature verification on the dataset root. The readable
    // algebra surface owns the *Merkle inclusion* check via
    // `Bgp::evaluate`; signature verification stays at the top
    // level because it is a one-shot check per root, not a
    // per-triple operation. (Matches the monolithic template
    // shape; see `transform/template/main-verify.template.nr`.)
    for i in 0..1 {
        verify_signature(public_key[0], roots[i]);
    }

    // -----------------------------------------------------------
    // Build the algebra tree -- one struct per operator. Compare
    // this to `filter_and_or.sparql.nr` (the monolithic body):
    // the same five assertions live here, but each lives next to
    // a documented type definition rather than being concatenated
    // into a single string-templated `checkBinding`.
    // -----------------------------------------------------------
    let pat = TriplePattern {
        subject: PatternPos { expected: variables.s },
        predicate: PatternPos { expected: ex_age_hash() },
        object: PatternPos { expected: variables.o },
    };

    let q: Project<Filter<Bgp<1>, And<GtI64, LtI64>>> = Project {
        inner: Filter {
            inner: Bgp { triples: bgp, patterns: [pat], root_value: roots[0].value },
            expr: And {
                left: GtI64 {
                    left: VarI64 { value: hidden[0] as i64 },
                    right: VarI64 { value: hidden[1] as i64 },
                },
                right: LtI64 {
                    left: VarI64 { value: hidden[2] as i64 },
                    right: VarI64 { value: hidden[3] as i64 },
                },
            },
        },
    };

    assert(q.evaluate(), "Readable algebra query unsatisfied");
}
