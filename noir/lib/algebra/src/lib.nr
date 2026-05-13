//! Readable per-operator SPARQL-algebra library.
//!
//! See `spec/algebra-structs.md` for the design rationale. The
//! library exposes one struct per algebra operator, each implementing
//! the single `trait Algebra { fn evaluate(self) -> bool }`. The
//! per-query top-level circuit constructs a tree of these structs
//! and `assert`s the root's `evaluate()`.
//!
//! Companion to the monolithic surface emitted by
//! `transform/src/emit.rs`; not a replacement. The monolithic surface
//! stays in place for the paper's baseline benchmarks. This surface
//! targets reviewer-friendliness and the Lean correspondence proof
//! (see `SPARQL_ROADMAP.md` sec.6).

// Re-export the core traits + helper types at the crate root for
// ergonomic `use dep::algebra::{Algebra, ExprBool, ...}`.
pub use algebra::bgp::{Bgp, PatternPos, TriplePattern};
pub use algebra::extend::Extend;
pub use algebra::filter::Filter;
pub use algebra::graph::GraphCtx;
pub use algebra::join::Join;
pub use algebra::leftjoin::{LeftJoin, OptionalArm};
pub use algebra::path::{PathInverse, PathLink, PathNps};
pub use algebra::project::{Distinct, Order, Project, Reduced, Slice};
pub use algebra::traits::{Algebra, ExprBool, GraphAssertable};
pub use algebra::union::Union;

pub use expr::atoms::{Lit, Var, VarI64};
pub use expr::cmp::{EqF, GeI64, GtI64, LeI64, LtI64, NeqF, SameTerm};
pub use expr::if_coalesce::{CoalesceBool, IfBool};
pub use expr::in_set::{In, NotIn};
pub use expr::is_numeric::IsNumeric;
pub use expr::logical::{And, Not, Or};
pub use expr::term_tests::{Bound, IsBlank, IsIri, IsIriField, IsLiteral};

pub mod algebra;
pub mod expr;
