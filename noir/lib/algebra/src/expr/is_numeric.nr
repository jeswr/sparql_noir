//! `isNumeric` expression -- `spec/algebra-structs.md` sec.4.9.
//!
//! SPARQL 1.1 sec.17.4.2.4: `isNumeric(?x)` returns `true` iff `?x` is
//! a literal whose datatype IRI denotes a numeric XML Schema type
//! (per XPath 2.0 sec.17, the `xsd:numeric` union: `xsd:integer`,
//! `xsd:decimal`, `xsd:float`, `xsd:double`, plus their derived
//! types). The round-1 surface covers the four primitive numeric
//! datatypes; derived integer types (`xsd:long`, `xsd:int`, etc.)
//! are an easy follow-up once the term-encoding contract grows a
//! "numeric datatype family" tag.
//!
//! **Witness model.** `IsIri`/`IsLiteral`/`IsBlank` consume a
//! `type_witness: u8` (term-type code). `isNumeric` is stronger:
//! it not only requires the term to be a literal but also matches
//! the *datatype IRI* against the numeric set. The struct therefore
//! carries two witnesses:
//!
//! - `type_witness: u8` -- the term-type code (must equal `2` for
//!   "literal"; the encoding is shared with `IsLiteral`).
//! - `datatype_hash: Field` -- the Pedersen hash of the literal's
//!   datatype IRI, sourced from a hidden-input witness whose
//!   binding back to the term is the transform's responsibility
//!   (the same hidden-input plumbing pattern `LtI64`/`IsIri` use).
//!
//! ### Why not a single `numeric_witness: bool`?
//!
//! A boolean witness would push the soundness anchor entirely onto
//! the transform: a malicious prover could set `numeric_witness =
//! true` regardless of the actual datatype. By comparing
//! `datatype_hash` against the four precomputed Pedersen hashes
//! inside the circuit, the witness is *checked* in-circuit. The
//! transform still binds `datatype_hash` to the term -- but the
//! "is one of the four numerics" decision is in the circuit, not
//! in trusted Rust code.
//!
//! ### Constraint cost
//!
//! Per `IsNumeric.evaluate`: one `u8 == 2` check + 4 field
//! comparisons against precomputed datatype-hash constants + the
//! disjunction. The four hashes themselves are *not* recomputed
//! per circuit -- they are baked in as module-level constants via
//! `comptime` (Noir 1.0-beta.17 supports `comptime` initialisers for
//! globals; see `/noir-lang/noir` docs).

use crate::algebra::traits::ExprBool;
use dep::consts;

// -----------------------------------------------------------------
// Precomputed datatype-IRI hashes
// -----------------------------------------------------------------
//
// Each entry is `consts::hash2([0, consts::encode_string(<iri>)])`
// where `0` is the IRI/NamedNode type code (same encoding the
// monolithic surface uses for predicate IRIs -- see
// `algebra_example/src/main.nr::ex_age_hash`).
//
// We materialise these via four `pub fn` accessors rather than
// `pub global` constants because `consts::hash2` / `encode_string`
// are not `comptime` in Noir 1.0-beta.17 -- their inputs may flow
// from runtime witnesses in general. The accessors are cheap: a
// constant-fold pass evaluates them once and the resulting Field
// is reused across every call site. (Same pattern
// `algebra_example::default_graph_hash` uses for the default-graph
// sentinel.)

/// `xsd:integer` datatype IRI hash.
pub fn xsd_integer_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://www.w3.org/2001/XMLSchema#integer")])
}

/// `xsd:decimal` datatype IRI hash.
pub fn xsd_decimal_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://www.w3.org/2001/XMLSchema#decimal")])
}

/// `xsd:float` datatype IRI hash.
pub fn xsd_float_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://www.w3.org/2001/XMLSchema#float")])
}

/// `xsd:double` datatype IRI hash.
pub fn xsd_double_hash() -> Field {
    consts::hash2([0, consts::encode_string("http://www.w3.org/2001/XMLSchema#double")])
}

/// `isNumeric(?x)` -- literal with one of the four XSD numeric
/// datatype IRIs.
pub struct IsNumeric {
    pub type_witness: u8,
    pub datatype_hash: Field,
}

impl ExprBool for IsNumeric {
    fn evaluate(self) -> bool {
        // Two-stage check:
        //   1. term must be a literal (type-code 2 -- same encoding
        //      `IsLiteral` uses).
        //   2. datatype IRI hash must equal one of the four xsd
        //      numeric hashes.
        let is_literal = self.type_witness == 2;
        let is_int = self.datatype_hash == xsd_integer_hash();
        let is_dec = self.datatype_hash == xsd_decimal_hash();
        let is_flt = self.datatype_hash == xsd_float_hash();
        let is_dbl = self.datatype_hash == xsd_double_hash();
        is_literal & (is_int | is_dec | is_flt | is_dbl)
    }
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

#[test]
fn is_numeric_integer() {
    let e = IsNumeric { type_witness: 2, datatype_hash: xsd_integer_hash() };
    assert(e.evaluate());
}

#[test]
fn is_numeric_decimal() {
    let e = IsNumeric { type_witness: 2, datatype_hash: xsd_decimal_hash() };
    assert(e.evaluate());
}

#[test]
fn is_numeric_float() {
    let e = IsNumeric { type_witness: 2, datatype_hash: xsd_float_hash() };
    assert(e.evaluate());
}

#[test]
fn is_numeric_double() {
    let e = IsNumeric { type_witness: 2, datatype_hash: xsd_double_hash() };
    assert(e.evaluate());
}

#[test]
fn is_numeric_rejects_string() {
    // `xsd:string` -- not in the numeric union.
    let xsd_string =
        consts::hash2([0, consts::encode_string("http://www.w3.org/2001/XMLSchema#string")]);
    let e = IsNumeric { type_witness: 2, datatype_hash: xsd_string };
    assert(!e.evaluate());
}

#[test]
fn is_numeric_rejects_boolean() {
    // `xsd:boolean` -- explicitly excluded from XPath 2.0's
    // numeric union despite being numerically representable.
    let xsd_bool =
        consts::hash2([0, consts::encode_string("http://www.w3.org/2001/XMLSchema#boolean")]);
    let e = IsNumeric { type_witness: 2, datatype_hash: xsd_bool };
    assert(!e.evaluate());
}

#[test]
fn is_numeric_rejects_non_literal_iri() {
    // Even with a "numeric" datatype hash, if the term is not a
    // literal (type-code 2), `isNumeric` is `false`. This documents
    // the SPARQL sec.17.4.2.4 contract: `isNumeric` requires *both* a
    // literal *and* a numeric datatype.
    let e = IsNumeric {
        type_witness: 0, // IRI, not literal
        datatype_hash: xsd_integer_hash(),
    };
    assert(!e.evaluate());
}

#[test]
fn is_numeric_rejects_non_literal_blank() {
    let e = IsNumeric {
        type_witness: 1, // blank node
        datatype_hash: xsd_integer_hash(),
    };
    assert(!e.evaluate());
}
