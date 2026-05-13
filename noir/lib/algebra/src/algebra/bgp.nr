//! Basic Graph Pattern. See `spec/algebra-structs.md` sec.3.1.
//!
//! A `Bgp<N>` owns `N` witness triples (with their Merkle inclusion
//! paths), `N` pattern descriptors (one per triple), and the
//! `root_value` of the dataset commitment those triples live in.
//! `evaluate` runs inclusion checks against the committed root and
//! asserts each pattern position (subject, predicate, object) matches
//! its witness slot.
//!
//! Soundness anchor: identical to the monolithic surface's
//! per-triple `verify_inclusion(triple, root.value)` plus
//! `assert(bgp[i].terms[j].hash == expected)` lines for j in {0,1,2}
//! (see `transform/src/emit.rs::generate_sparql_nr_from_query_info` and
//! `transform/template/main-verify.template.nr`). The graph slot
//! (position 3) is **not** asserted here; for `GRAPH`-qualified
//! patterns the `GraphCtx` wrapper attaches a per-triple
//! `terms[3].hash == graph_iri.expected` assertion. Default-graph
//! queries inherit the monolithic-surface elision -- no per-triple
//! graph assertion is emitted at all. This matches the monolithic
//! `checkBinding` emit one-for-one and closes the `basic_bgp`
//! lookup-pool regression documented in
//! `bench/readable-vs-monolithic.md` (round-2 follow-up).

use crate::algebra::traits::Algebra;
use dep::types::Triple;
use dep::utils::verify_inclusion;

/// One position in a triple pattern. `expected` is the term-hash
/// that the witness slot at this position must equal. For a
/// constant in the query, the transform sets `expected` to the
/// precomputed `consts::hash2([type, encode_string(...)])`; for a
/// SPARQL variable, the transform sets `expected` to the
/// `variables.<var>` public input.
pub struct PatternPos {
    pub expected: Field,
}

/// A single SPARQL triple pattern. The three positions
/// (`subject`, `predicate`, `object`) cover the BGP semantics for
/// default-graph queries -- the graph slot is carried by
/// `GraphCtx` when the pattern is wrapped in a `GRAPH` operator
/// (see `algebra::graph`). Default-graph queries do not assert the
/// 4th term position at all, matching the monolithic surface's
/// elision (see `spec/algebra-structs.md` sec.3.9 and the
/// `basic_bgp` bench analysis in `bench/readable-vs-monolithic.md`).
pub struct TriplePattern {
    pub subject: PatternPos,
    pub predicate: PatternPos,
    pub object: PatternPos,
}

/// `N`-pattern Basic Graph Pattern. Owns its witness triples,
/// pattern descriptors, and the dataset root they sit in.
pub struct Bgp<let N: u32> {
    pub triples: [Triple; N],
    pub patterns: [TriplePattern; N],
    pub root_value: Field,
}

impl<let N: u32> Algebra for Bgp<N> {
    fn evaluate(self) -> bool {
        // For each pattern: (a) Merkle inclusion of the witness
        // triple against the dataset commitment, (b) position
        // equality against the three subject/predicate/object
        // `PatternPos.expected` fields. The 4th (graph) position is
        // handled by `GraphCtx` when applicable -- see module docs.
        //
        // The conjunction over positions is folded into `result`.
        // Inclusion is performed by `verify_inclusion`, which itself
        // `assert`s -- so a failing inclusion check halts evaluation
        // and the boolean conjunction is never observed. This matches
        // the monolithic surface's behaviour (inclusion is hard-asserted
        // in `main.nr`).
        let mut result = true;
        for i in 0..N {
            verify_inclusion(self.triples[i], self.root_value);
            // Project through `.hash`: BGP equality only ever needs
            // the term's identity. The bounded-byte witness is bound
            // separately at string-operator call sites (see
            // `spec/encoding.md` sec.6.6).
            let s_ok = self.triples[i].terms[0].hash == self.patterns[i].subject.expected;
            let p_ok = self.triples[i].terms[1].hash == self.patterns[i].predicate.expected;
            let o_ok = self.triples[i].terms[2].hash == self.patterns[i].object.expected;
            result = result & s_ok & p_ok & o_ok;
        }
        result
    }
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

#[test]
fn pattern_pos_round_trip() {
    let pos = PatternPos { expected: 42 };
    assert(pos.expected == 42);
}

#[test]
fn triple_pattern_round_trip() {
    let pat = TriplePattern {
        subject: PatternPos { expected: 1 },
        predicate: PatternPos { expected: 2 },
        object: PatternPos { expected: 3 },
    };
    assert(pat.subject.expected == 1);
    assert(pat.predicate.expected == 2);
    assert(pat.object.expected == 3);
}
