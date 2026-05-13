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
//!
//! Round-2 adds `IsIriField` -- a sibling that takes the type witness
//! as a `Field` rather than a `u8`. Callers that source the witness
//! from `hidden[i]` (a `Field`-typed public-input slot) save the
//! `Field -> u8` range-check (8-bit decomposition) by using
//! `IsIriField`; callers that already have a `u8` in hand keep
//! `IsIri`. This closes the `filter_isiri` +10 Expression Width
//! delta documented in `bench/readable-vs-monolithic.md`. `IsLiteral`
//! / `IsBlank` only gain a `*Field` sibling once a bench row shows
//! the analogous regression -- the round-2 follow-up brief asks us
//! not to add them speculatively.

use crate::algebra::traits::ExprBool;

/// `BOUND(?x)` -- returns `true` iff the variable is bound. The
/// transform sets `bound` from its static analysis (variables in
/// the projected list are always bound; OPTIONAL-only variables
/// are bound iff the OPTIONAL matched).
pub struct Bound {
    pub bound: bool,
}

impl ExprBool for Bound {
    fn evaluate(self) -> bool {
        self.bound
    }
}

/// `isIRI(?x)` over a `u8` type-witness -- `type_witness == 0`.
///
/// Use this variant when the type witness is already in `u8` form at
/// the call site. Callers reading the type witness directly from a
/// `Field`-typed hidden input (e.g. `hidden[i]`) should prefer
/// `IsIriField`, which compares against `Field 0` and avoids the
/// `Field -> u8` 8-bit range check.
pub struct IsIri {
    pub type_witness: u8,
}

/// `isLiteral(?x)` -- `type_witness == 2`.
pub struct IsLiteral {
    pub type_witness: u8,
}

/// `isBlank(?x)` -- `type_witness == 1`.
pub struct IsBlank {
    pub type_witness: u8,
}

impl ExprBool for IsIri {
    fn evaluate(self) -> bool {
        self.type_witness == 0
    }
}
impl ExprBool for IsLiteral {
    fn evaluate(self) -> bool {
        self.type_witness == 2
    }
}
impl ExprBool for IsBlank {
    fn evaluate(self) -> bool {
        self.type_witness == 1
    }
}

/// `isIRI(?x)` over a `Field` type-witness -- `type_witness == 0`.
///
/// Round-2 follow-up: the `Field`-typed sibling of `IsIri`. The
/// monolithic surface emits `assert(hidden[0] == 0)` directly on a
/// `Field`-typed hidden-input slot; the round-1 `IsIri` variant
/// allocates an 8-bit range check on the implicit `Field -> u8`
/// cast at the call site, costing +8 ACIR opcodes / +10 Expression
/// Width on `filter_isiri` (see `bench/readable-vs-monolithic.md`).
/// `IsIriField` compares against `Field 0` directly, matching the
/// monolithic surface byte-for-byte.
///
/// The type-code semantics (0 = IRI) are identical between the two
/// variants; only the witness type differs.
pub struct IsIriField {
    pub type_witness: Field,
}

impl ExprBool for IsIriField {
    fn evaluate(self) -> bool {
        self.type_witness == 0
    }
}

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

#[test]
fn is_iri_field_matches_type_code() {
    // Field-typed sibling: same semantics as `IsIri`, no `Field -> u8`
    // range check on the witness path.
    let t = IsIriField { type_witness: 0 };
    assert(t.evaluate());
    let l = IsIriField { type_witness: 2 };
    assert(!l.evaluate());
    let b = IsIriField { type_witness: 1 };
    assert(!b.evaluate());
}
