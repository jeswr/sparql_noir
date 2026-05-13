//! Property-path atoms -- `spec/algebra-structs.md` sec.3.10.
//!
//! `PathLink` represents a single triple-pattern leg of a property
//! path (e.g., `?s ex:knows ?o`). `PathInverse` and `PathNps` are
//! marker wrappers; the transform performs the position-swap (for
//! inverse) and the exclusion-set inequality assertions (for NPS)
//! at lowering time, so the wrappers' `evaluate` is the inner's
//! `evaluate`. Holding them as explicit types keeps the algebra
//! tree faithful and lets Lean tag the operator boundaries.
//!
//! Sequence / `+` / `*` paths are unrolled to a `Union` of `Join`s
//! of `PathLink`s at transform-time -- no dedicated struct (see
//! `spec/algebra.md` sec.8 and the bounded-unroll behaviour in the
//! monolithic surface).

use crate::algebra::bgp::TriplePattern;
use crate::algebra::traits::Algebra;
use dep::types::Triple;
use dep::utils::verify_inclusion;

/// A single property-path leg: one triple match against one witness.
///
/// `PathLink` is structurally identical to a 1-triple `Bgp<1>`; it
/// exists as a separate type so the algebra tree distinguishes "a
/// BGP" (a conjunction of triple patterns) from "a path leg" (a
/// step in a property-path expansion). The Lean correspondence
/// preserves the distinction for clean operator mirroring.
pub struct PathLink {
    pub triple: Triple,
    pub pattern: TriplePattern,
    pub root_value: Field,
}

impl Algebra for PathLink {
    fn evaluate(self) -> bool {
        verify_inclusion(self.triple, self.root_value);
        let s_ok = self.triple.terms[0].hash == self.pattern.subject.expected;
        let p_ok = self.triple.terms[1].hash == self.pattern.predicate.expected;
        let o_ok = self.triple.terms[2].hash == self.pattern.object.expected;
        // Graph position is `GraphCtx`'s responsibility -- see
        // `algebra::graph` and `algebra::bgp` module docs. A path leg
        // under `GRAPH` is wrapped in `GraphCtx` by the caller;
        // default-graph paths inherit the monolithic-surface elision.
        s_ok & p_ok & o_ok
    }
}

/// Inverse property path `^p`. Marker wrapper: the transform swaps
/// subject/object in the inner `PathLink.pattern` at lowering time.
pub struct PathInverse<P> {
    pub inner: P,
}
impl<P> Algebra for PathInverse<P>
where
    P: Algebra,
{
    fn evaluate(self) -> bool {
        self.inner.evaluate()
    }
}

/// Negated property set `!p`. Holds the inner `PathLink` plus an
/// array of `M` excluded predicate hashes. `evaluate` asserts the
/// witness predicate is not any of the excluded hashes.
pub struct PathNps<let M: u32> {
    pub inner: PathLink,
    pub excluded: [Field; M],
}

impl<let M: u32> Algebra for PathNps<M> {
    fn evaluate(self) -> bool {
        let mut result = self.inner.evaluate();
        let predicate_hash = self.inner.triple.terms[1].hash;
        for k in 0..M {
            result = result & (predicate_hash != self.excluded[k]);
        }
        result
    }
}
