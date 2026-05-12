//! Term-test expressions -- `spec/algebra-structs.md` sec.4.4.
//!
//! `Bound`, `IsIri`, `IsLiteral`, `IsBlank` consume a hidden-input
//! `type_witness: u8` (the term's encoded type code: 0=IRI,
//! 1=blank, 2=literal, etc.) and assert it. The witness binding back
//! to the term hash is the transform's responsibility -- matching
//! today's monolithic surface (`emit.rs::type_check`).
//!
//! The type-code semantics live in `noir/lib/utils::verify_type_encoding`;
//! the structs here only carry the witness and the comparison.

use crate::algebra::traits::ExprBool;

/// `BOUND(?x)` -- returns `true` iff the variable is bound. The
/// transform sets `bound` from its static analysis (variables in
/// the projected list are always bound; OPTIONAL-only variables
/// are bound iff the OPTIONAL matched).
pub struct Bound { pub bound: bool }

impl ExprBool for Bound { fn evaluate(self) -> bool { self.bound } }

/// `isIRI(?x)` -- `type_witness == 0`.
pub struct IsIri     { pub type_witness: u8 }

/// `isLiteral(?x)` -- `type_witness == 2`.
pub struct IsLiteral { pub type_witness: u8 }

/// `isBlank(?x)` -- `type_witness == 1`.
pub struct IsBlank   { pub type_witness: u8 }

impl ExprBool for IsIri     { fn evaluate(self) -> bool { self.type_witness == 0 } }
impl ExprBool for IsLiteral { fn evaluate(self) -> bool { self.type_witness == 2 } }
impl ExprBool for IsBlank   { fn evaluate(self) -> bool { self.type_witness == 1 } }

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[test]
fn bound_true() {
    let b = Bound { bound: true };
    assert(b.evaluate());
}

#[test]
fn bound_false() {
    let b = Bound { bound: false };
    assert(!b.evaluate());
}

#[test]
fn is_iri_matches_type_code() {
    let t = IsIri { type_witness: 0 };
    assert(t.evaluate());
    let f = IsIri { type_witness: 2 };
    assert(!f.evaluate());
}

#[test]
fn is_literal_matches_type_code() {
    let t = IsLiteral { type_witness: 2 };
    assert(t.evaluate());
}

#[test]
fn is_blank_matches_type_code() {
    let t = IsBlank { type_witness: 1 };
    assert(t.evaluate());
}
