//! Algebra-level IR — pure data structures.
//!
//! These types are produced by [`crate::lower`] from spargebra's
//! `GraphPattern` and consumed by [`crate::expr`] / [`crate::emit`] /
//! [`crate::metadata`]. They carry no behaviour; the surrounding modules
//! own the algebra, expression, and emission logic.

use spargebra::algebra::Expression;
use spargebra::term::{GroundTerm, TriplePattern};

#[derive(Clone, Debug)]
pub enum Term {
    Variable(String),
    Input(usize, usize),
    Static(GroundTerm),
}

#[derive(Clone, Debug)]
pub struct Assertion(pub(crate) Term, pub(crate) Term);

#[derive(Clone, Debug)]
pub struct Binding {
    pub(crate) variable: String,
    pub(crate) term: Term,
}

#[derive(Clone, Debug)]
pub enum GraphContext {
    Default,
    NamedNode(String),
    Variable(String),
}

#[derive(Clone, Debug)]
pub struct ContextualizedTriple {
    pub(crate) pattern: TriplePattern,
    pub(crate) graph: GraphContext,
}

/// Represents an OPTIONAL block with its patterns, bindings, assertions, and filters
#[derive(Clone, Debug)]
pub struct OptionalBlock {
    pub id: usize,
    pub patterns: Vec<ContextualizedTriple>,
    pub bindings: Vec<Binding>,
    pub assertions: Vec<Assertion>,
    pub filters: Vec<Expression>,
    pub nested_optionals: Vec<OptionalBlock>,
}

/// Which boundary case a `NonExistenceConstraint` covers at proof time.
///
/// The signer's sorted Merkle commitment carries two synthetic sentinel
/// leaves -- `LOW_SENTINEL_HASH = 0` at sorted index `0`, and
/// `HIGH_SENTINEL_HASH = -1` at sorted index `N + 1` -- so every `absent_hash`
/// can be bracketed against *some* pair of adjacent sorted leaves. Which
/// pair is determined at prove time by where `absent_hash` sorts:
///
/// | Case   | Left bracket               | Right bracket              | Adjacency assertion          |
/// | ------ | -------------------------- | -------------------------- | ---------------------------- |
/// | Lower  | low sentinel (index 0)     | smallest real leaf         | `right_idx == 1`             |
/// | Middle | real leaf at sorted idx `i`| real leaf at sorted idx `i+1` | `right_idx == left_idx + 1` |
/// | Upper  | largest real leaf          | high sentinel (index N+1)  | `high_idx == left_idx + 1`   |
///
/// The transform layer emits a single circuit that handles all three
/// cases via runtime dispatch on a public `boundary_case` Field; the
/// prover picks the case that matches the live data. Soundness comes
/// from the strict-`<` / adjacency assertions of the chosen primitive
/// -- a prover lying about which case applies can't satisfy those.
///
/// See `spec/exists.md` Sec.3.3 and the
/// `verify_non_membership_*_no_inclusion` family in
/// `noir/lib/utils/src/lib.nr`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoundaryCase {
    /// `absent_hash` strictly greater than every real leaf in the dataset.
    /// Bracketed by the largest real leaf on the left and the high
    /// sentinel on the right.
    Upper,
    /// `absent_hash` strictly between two adjacent real leaves -- the
    /// "interior" case shipped by `#66`.
    Middle,
    /// `absent_hash` strictly less than every real leaf in the dataset.
    /// Bracketed by the low sentinel on the left and the smallest real
    /// leaf on the right.
    Lower,
}

impl BoundaryCase {
    /// Field-tag used by the runtime dispatch in `checkBinding`. The
    /// prover sets the public `boundary_cases[i]` input to this value
    /// to select which `verify_non_membership_*_no_inclusion` primitive
    /// fires for constraint `i`.
    pub fn tag(&self) -> u8 {
        match self {
            BoundaryCase::Lower => 0,
            BoundaryCase::Middle => 1,
            BoundaryCase::Upper => 2,
        }
    }

    /// String tag emitted into `metadata.json` so the TS prover can
    /// enumerate the dispatch options.
    pub fn metadata_tag(&self) -> &'static str {
        match self {
            BoundaryCase::Lower => "lower",
            BoundaryCase::Middle => "middle",
            BoundaryCase::Upper => "upper",
        }
    }
}

/// One non-membership obligation, lowered from a `FILTER(NOT EXISTS { t })`
/// block (or, equivalently, from `MINUS` after the algebra rewrite). The
/// circuit asserts:
///
/// 1. Both `bgp[bracket_left_idx]` and `bgp[bracket_right_idx]` are valid
///    sorted-tree leaves (handled by the generic per-triple inclusion check
///    in `main.nr`). In the `Lower` boundary case `bgp[bracket_left_idx]`
///    is a dummy filler that the prover sets to any included triple; in
///    `Upper` the same applies to `bgp[bracket_right_idx]`. The dispatch
///    in `checkBinding` ignores the dummy slot's hash and uses the
///    matching sentinel leaf instead.
/// 2. `hash4(absent_terms) ≠ leaf_hash` for every leaf in the dataset, via
///    the strict-ordering / adjacency invariants checked by the
///    `verify_non_membership_*_no_inclusion` primitive selected by the
///    public `boundary_cases[constraint_idx]` field.
///
/// `absent_terms` are themselves `Term`s (typically `Term::Variable` for
/// outer-bound positions and `Term::Static` for ground positions) — the
/// emit layer serialises them in-line so the outer μ is substituted at
/// constraint-evaluation time.
///
/// Currently restricted to **single-triple ground-inner** NOT EXISTS — the
/// inner pattern is a single triple whose free variables are all bound in
/// the outer scope. Multi-triple / non-ground inner patterns are
/// rejected at lowering time (see `spec/exists.md` §7).
///
/// The lowering layer doesn't know the live `BoundaryCase` -- that's a
/// prove-time fact -- so the IR records only the structural information
/// (bracket indices, absent terms). The runtime case is supplied via
/// the public `boundary_cases` circuit input by the prover.
#[derive(Clone, Debug)]
pub struct NonExistenceConstraint {
    /// BGP index of the left bracket leaf. In `Lower` mode this slot is
    /// a prover-supplied filler.
    pub(crate) bracket_left_idx: usize,
    /// BGP index of the right bracket leaf. In `Upper` mode this slot is
    /// a prover-supplied filler.
    pub(crate) bracket_right_idx: usize,
    /// Subject / predicate / object / graph terms whose `hash4` is the
    /// would-be absent leaf. Each term is substituted at emit time —
    /// outer-bound variables resolve via `Term::Variable` lookup;
    /// constants are inlined.
    pub(crate) absent_terms: [Term; 4],
}

#[derive(Clone, Debug)]
pub struct PatternInfo {
    pub(crate) patterns: Vec<ContextualizedTriple>,
    pub(crate) bindings: Vec<Binding>,
    pub(crate) assertions: Vec<Assertion>,
    pub(crate) filters: Vec<Expression>,
    pub(crate) union_branches: Option<Vec<PatternInfo>>,
    pub(crate) optional_blocks: Vec<OptionalBlock>,
    /// Non-membership obligations from `FILTER(NOT EXISTS { t })` /
    /// `MINUS { … } { t }`. Empty when the query has no negation.
    pub(crate) not_exists: Vec<NonExistenceConstraint>,
}

impl PatternInfo {
    pub(crate) fn new() -> Self {
        Self {
            patterns: Vec::new(),
            bindings: Vec::new(),
            assertions: Vec::new(),
            filters: Vec::new(),
            union_branches: None,
            optional_blocks: Vec::new(),
            not_exists: Vec::new(),
        }
    }
}

/// A SPARQL aggregate that the verifier computes externally on the
/// disclosed multiset of `?source` bindings (see SPARQL_ROADMAP.md §8.6 /
/// Q6). The transform never emits in-circuit DISTINCT, sort, or count
/// primitives — it just propagates the kind into `metadata.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AggregateKind {
    /// `COUNT(?x)` — verifier counts the disclosed multiset.
    Count,
    /// `COUNT(DISTINCT ?x)` — verifier counts `|distinct(disclosed)|`.
    CountDistinct,
    /// `COUNT(*)` — verifier counts the disclosed solutions.
    CountSolutions { distinct: bool },
    /// `SUM(?x)` — verifier sums the disclosed multiset.
    Sum { distinct: bool },
    /// `MIN(?x)` — verifier picks the minimum of the disclosed multiset.
    Min { distinct: bool },
    /// `MAX(?x)` — verifier picks the maximum of the disclosed multiset.
    Max { distinct: bool },
    /// `AVG(?x)` — verifier averages the disclosed multiset.
    Avg { distinct: bool },
}

impl AggregateKind {
    /// JSON tag used in `metadata.json` so the verifier can dispatch.
    pub fn metadata_tag(&self) -> &'static str {
        match self {
            AggregateKind::Count => "count",
            AggregateKind::CountDistinct => "count_distinct",
            AggregateKind::CountSolutions { distinct: false } => "count_solutions",
            AggregateKind::CountSolutions { distinct: true } => "count_solutions_distinct",
            AggregateKind::Sum { distinct: false } => "sum",
            AggregateKind::Sum { distinct: true } => "sum_distinct",
            AggregateKind::Min { distinct: false } => "min",
            AggregateKind::Min { distinct: true } => "min_distinct",
            AggregateKind::Max { distinct: false } => "max",
            AggregateKind::Max { distinct: true } => "max_distinct",
            AggregateKind::Avg { distinct: false } => "avg",
            AggregateKind::Avg { distinct: true } => "avg_distinct",
        }
    }
}

/// One aggregate column. The disclosed multiset is the bindings of
/// `source` (or all in-scope variables when `source` is `None`, for
/// `COUNT(*)`); `output` is the projected variable that holds the
/// aggregate result, surfaced for the verifier so it can name the
/// computed value in its output mapping.
#[derive(Clone, Debug)]
pub struct Aggregate {
    pub kind: AggregateKind,
    pub source: Option<String>,
    pub output: String,
}

/// Direction of an `ORDER BY` key. The transform never sorts
/// in-circuit; the verifier sorts the disclosed multiset itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderDirection {
    Asc,
    Desc,
}

/// One `ORDER BY` key — currently restricted to ordering by a
/// projected variable, since arbitrary `ORDER BY` expressions imply
/// computing something the verifier can't reproduce from the
/// disclosed bindings alone.
#[derive(Clone, Debug)]
pub struct OrderKey {
    pub variable: String,
    pub direction: OrderDirection,
}

#[derive(Clone, Debug)]
pub struct QueryInfo {
    pub(crate) variables: Vec<String>,
    pub(crate) pattern: PatternInfo,
    /// SPARQL aggregates (`COUNT` / `SUM` / `MIN` / `MAX` / `AVG`)
    /// applied to the disclosed multiset. Empty when the query is a
    /// plain `SELECT`.
    pub(crate) aggregates: Vec<Aggregate>,
    /// `ORDER BY` keys, in priority order. The verifier sorts the
    /// disclosed multiset by these keys.
    pub(crate) order_by: Vec<OrderKey>,
    /// `LIMIT k` — the verifier checks `|disclosed| <= k`.
    pub(crate) limit: Option<usize>,
    /// `OFFSET n` — propagated for completeness; the verifier slices
    /// after sorting.
    pub(crate) offset: Option<usize>,
}
