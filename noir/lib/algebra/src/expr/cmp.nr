//! Comparison expressions -- `spec/algebra-structs.md` sec.4.2.
//!
//! Two flavours:
//!
//! - Hash-domain (`EqF`, `NeqF`, `SameTerm`): direct `Field`-equality.
//!   Canonical-encoding shortcut, equivalent to today's
//!   `assert(left_hash == right_hash)` -- see `spec/algebra.md`
//!   sec.6.1 for the SameTerm vs RDFterm-equal distinction.
//! - i64-domain (`LtI64`, `LeI64`, `GtI64`, `GeI64`): numeric
//!   comparison over `VarI64` operands. The transform sources the
//!   `VarI64.value` from a hidden-input witness bound to the term's
//!   numeric lexical form (matching today's monolithic surface in
//!   `transform/src/emit.rs::numeric_comparison`).
//!
//! Names are suffixed `F` (field) / `I64` (signed integer) to avoid
//! the `std::Eq` / `std::Ord` trait-name clash; the trait names are
//! reserved by Noir's prelude. The spec doc refers to them as
//! `Eq`/`Lt`/etc. for brevity; here we are explicit.

use crate::algebra::traits::ExprBool;
use crate::expr::atoms::{Var, Lit, VarI64};

// -----------------------------------------------------------------
// Hash-domain comparisons (identity)
// -----------------------------------------------------------------

pub struct EqF       { pub left: Field, pub right: Field }
pub struct NeqF      { pub left: Field, pub right: Field }
pub struct SameTerm  { pub left: Field, pub right: Field }

impl ExprBool for EqF       { fn evaluate(self) -> bool { self.left == self.right } }
impl ExprBool for NeqF      { fn evaluate(self) -> bool { self.left != self.right } }
impl ExprBool for SameTerm  { fn evaluate(self) -> bool { self.left == self.right } }

// -----------------------------------------------------------------
// i64-domain numeric comparisons (what FILTER numeric comparison emits)
// -----------------------------------------------------------------

pub struct LtI64 { pub left: VarI64, pub right: VarI64 }
pub struct LeI64 { pub left: VarI64, pub right: VarI64 }
pub struct GtI64 { pub left: VarI64, pub right: VarI64 }
pub struct GeI64 { pub left: VarI64, pub right: VarI64 }

impl ExprBool for LtI64 { fn evaluate(self) -> bool { self.left.value <  self.right.value } }
impl ExprBool for LeI64 { fn evaluate(self) -> bool { self.left.value <= self.right.value } }
impl ExprBool for GtI64 { fn evaluate(self) -> bool { self.left.value >  self.right.value } }
impl ExprBool for GeI64 { fn evaluate(self) -> bool { self.left.value >= self.right.value } }

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[test]
fn eq_field_true() {
    let e = EqF { left: 5, right: 5 };
    assert(e.evaluate());
}

#[test]
fn eq_field_false() {
    let e = EqF { left: 5, right: 6 };
    assert(!e.evaluate());
}

#[test]
fn neq_field_true() {
    let n = NeqF { left: 5, right: 6 };
    assert(n.evaluate());
}

#[test]
fn lt_i64_true() {
    let lt = LtI64 {
        left:  VarI64 { value: 1 },
        right: VarI64 { value: 2 },
    };
    assert(lt.evaluate());
}

#[test]
fn lt_i64_false_equal() {
    let lt = LtI64 {
        left:  VarI64 { value: 2 },
        right: VarI64 { value: 2 },
    };
    assert(!lt.evaluate());
}

#[test]
fn ge_i64_negative() {
    let ge = GeI64 {
        left:  VarI64 { value: -1 },
        right: VarI64 { value: -2 },
    };
    assert(ge.evaluate());
}

#[test]
fn same_term_var_lit_round_trip() {
    // Documents that Var + Lit produce the same hash-domain Field
    // that SameTerm compares; the round-trip is what the transform
    // does when emitting `sameTerm(?x, "Alice")`.
    let v = Var { value: 42 };
    let l = Lit { value: 42 };
    let s = SameTerm { left: v.value, right: l.value };
    assert(s.evaluate());
}
