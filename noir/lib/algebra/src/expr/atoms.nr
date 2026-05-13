//! Atomic expression nodes -- `spec/algebra-structs.md` sec.4.1.
//!
//! `Var` / `Lit` carry a single `Field` (the term-hash projection of
//! the variable or the precomputed literal hash). They are not
//! `ExprBool` themselves -- they are *value carriers* consumed by
//! comparison / logical structs in `expr::cmp` and `expr::logical`.
//!
//! `VarI64` carries an `i64` value sourced from a hidden-input
//! witness -- used by numeric ordered comparisons (`LtI64` etc.).
//! The hidden-input plumbing matches the monolithic surface's
//! `hidden[k]` slots; see `transform/src/emit.rs::filter_to_noir`
//! for the per-query allocation pattern.

/// Field-domain atomic expression (term hash). Equivalent to today's
/// `variables.<var>` projection or a precomputed literal hash.
pub struct Var { pub value: Field }

/// Pre-encoded RDF literal hash. The transform precomputes
/// `consts::hash2([type, encode_string(lexical)])` and bakes it into
/// `value`.
pub struct Lit { pub value: Field }

/// i64-domain atomic value (sourced from a hidden-input witness).
/// Numeric-comparison structs combine these directly. The
/// hidden-input binding back to the term hash is the transform's
/// responsibility (matching today's monolithic surface).
pub struct VarI64 { pub value: i64 }
