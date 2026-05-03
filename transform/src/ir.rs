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

#[derive(Clone, Debug)]
pub struct PatternInfo {
    pub(crate) patterns: Vec<ContextualizedTriple>,
    pub(crate) bindings: Vec<Binding>,
    pub(crate) assertions: Vec<Assertion>,
    pub(crate) filters: Vec<Expression>,
    pub(crate) union_branches: Option<Vec<PatternInfo>>,
    pub(crate) optional_blocks: Vec<OptionalBlock>,
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
        }
    }
}

#[derive(Clone, Debug)]
pub struct QueryInfo {
    pub(crate) variables: Vec<String>,
    pub(crate) pattern: PatternInfo,
}
