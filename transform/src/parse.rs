//! SPARQL parsing and query-form dispatch.
//!
//! Wraps `spargebra::SparqlParser`, returns the algebra root for the
//! supported query forms (SELECT / CONSTRUCT / DESCRIBE / ASK). Higher
//! layers operate on `GraphPattern` and never touch the parser directly.

use spargebra::algebra::GraphPattern;
use spargebra::{Query, SparqlParser};

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
