//! SPARQL parsing and query-form dispatch.
//!
//! Wraps `spargebra::SparqlParser`, returns the algebra root for the
//! supported query forms (SELECT / CONSTRUCT / DESCRIBE / ASK). Higher
//! layers operate on `GraphPattern` and never touch the parser directly.

use spargebra::algebra::GraphPattern;
use spargebra::{Query, SparqlParser};

/// Which SPARQL query form produced the algebra root. Used by the
/// lowering layer to drive ASK-vs-SELECT differences in the disclosed
/// projection (audit item 8, sparql_noir #37 row).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QueryForm {
    Select,
    Ask,
    Construct,
    Describe,
}

pub(crate) fn parse_query(query_str: &str) -> Result<Query, String> {
    SparqlParser::new()
        .parse_query(query_str)
        .map_err(|e| format!("Parse error: {}", e))
}

pub(crate) fn root_pattern(query: &Query) -> &GraphPattern {
    match query {
        Query::Select { pattern, .. }
        | Query::Construct { pattern, .. }
        | Query::Describe { pattern, .. }
        | Query::Ask { pattern, .. } => pattern,
    }
}

pub(crate) fn query_form(query: &Query) -> QueryForm {
    match query {
        Query::Select { .. } => QueryForm::Select,
        Query::Ask { .. } => QueryForm::Ask,
        Query::Construct { .. } => QueryForm::Construct,
        Query::Describe { .. } => QueryForm::Describe,
    }
}
