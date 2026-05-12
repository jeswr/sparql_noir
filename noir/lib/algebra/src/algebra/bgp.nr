//! Basic Graph Pattern. See `spec/algebra-structs.md` sec.3.1.
//!
//! A `Bgp<N>` owns `N` witness triples (with their Merkle inclusion
//! paths), `N` pattern descriptors (one per triple), and the
//! `root_value` of the dataset commitment those triples live in.
//! `evaluate` runs inclusion checks against the committed root and
//! asserts each pattern position matches its witness slot.
//!
//! Soundness anchor: identical to the monolithic surface's
//! per-triple `verify_inclusion(triple, root.value)` plus
//! `assert(bgp[i].terms[j].hash == expected)` lines (see
//! `transform/src/emit.rs::generate_sparql_nr_from_query_info` and
//! `transform/template/main-verify.template.nr`). The only structural
//! change is that those two checks now live next to each other
//! inside this module instead of being split between `main.nr` and
//! `sparql.nr`.

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

/// A single SPARQL triple pattern. Each position is a `PatternPos`.
/// The `graph` position is fixed to a "default-graph" sentinel when
/// the query is over the default graph; the transform substitutes it
/// per `GraphCtx` wrapping (see `algebra::graph`).
pub struct TriplePattern {
    pub subject: PatternPos,
    pub predicate: PatternPos,
    pub object: PatternPos,
    pub graph: PatternPos,
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
        // equality against the four `PatternPos.expected` fields.
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
            let g_ok = self.triples[i].terms[3].hash == self.patterns[i].graph.expected;
            result = result & s_ok & p_ok & o_ok & g_ok;
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
        graph: PatternPos { expected: 4 },
    };
    assert(pat.subject.expected == 1);
    assert(pat.predicate.expected == 2);
    assert(pat.object.expected == 3);
    assert(pat.graph.expected == 4);
}
