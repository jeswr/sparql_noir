//! Algebra → IR lowering.
//!
//! Walks spargebra's `GraphPattern` and produces a [`PatternInfo`] /
//! [`QueryInfo`]. Handles BGP processing, property-path expansion,
//! join/union/optional/graph composition, and unwrapping of post-processing
//! modifiers (DISTINCT, ORDER BY, LIMIT/OFFSET, REDUCED). The output is
//! pure data; no Noir code is emitted here.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};

use spargebra::algebra::{Expression, GraphPattern, PropertyPathExpression};
use spargebra::term::{GroundTerm, NamedNodePattern, TermPattern, TriplePattern, Variable};

use crate::{
    Assertion, Binding, ContextualizedTriple, GraphContext, OptionalBlock, PatternInfo, QueryInfo,
    Term,
};

static OPTIONAL_BLOCK_COUNTER: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn next_optional_id() -> usize {
    OPTIONAL_BLOCK_COUNTER.fetch_add(1, Ordering::SeqCst)
}

pub(crate) fn reset_optional_counter() {
    OPTIONAL_BLOCK_COUNTER.store(0, Ordering::SeqCst);
}

static VAR_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn fresh_variable() -> TermPattern {
    let id = VAR_COUNTER.fetch_add(1, Ordering::SeqCst);
    TermPattern::Variable(Variable::new_unchecked(format!("__v{}", id)))
}

fn process_patterns(patterns: &[TriplePattern]) -> Result<PatternInfo, String> {
    process_patterns_with_graph(patterns, GraphContext::Default)
}

fn process_patterns_with_graph(
    patterns: &[TriplePattern],
    graph: GraphContext,
) -> Result<PatternInfo, String> {
    let mut info = PatternInfo::new();
    let mut seen_vars: BTreeSet<String> = BTreeSet::new();

    for (i, pattern) in patterns.iter().enumerate() {
        info.patterns.push(ContextualizedTriple {
            pattern: pattern.clone(),
            graph: graph.clone(),
        });

        // Process subject (position 0)
        match &pattern.subject {
            TermPattern::NamedNode(nn) => {
                info.assertions.push(Assertion(
                    Term::Static(GroundTerm::NamedNode(nn.clone())),
                    Term::Input(i, 0),
                ));
            }
            TermPattern::Variable(v) => {
                let name = v.as_str().to_string();
                if seen_vars.contains(&name) {
                    info.assertions.push(Assertion(
                        Term::Variable(name),
                        Term::Input(i, 0),
                    ));
                } else {
                    seen_vars.insert(name.clone());
                    info.bindings.push(Binding {
                        variable: name,
                        term: Term::Input(i, 0),
                    });
                }
            }
            TermPattern::BlankNode(bn) => {
                let name = format!("__blank_{}", bn.as_str());
                if seen_vars.contains(&name) {
                    info.assertions.push(Assertion(
                        Term::Variable(name),
                        Term::Input(i, 0),
                    ));
                } else {
                    seen_vars.insert(name.clone());
                    info.bindings.push(Binding {
                        variable: name,
                        term: Term::Input(i, 0),
                    });
                }
            }
            TermPattern::Literal(_) => return Err("Literal in subject position".into()),
        }

        // Process predicate (position 1)
        match &pattern.predicate {
            NamedNodePattern::NamedNode(nn) => {
                info.assertions.push(Assertion(
                    Term::Static(GroundTerm::NamedNode(nn.clone())),
                    Term::Input(i, 1),
                ));
            }
            NamedNodePattern::Variable(v) => {
                let name = v.as_str().to_string();
                if !seen_vars.contains(&name) {
                    seen_vars.insert(name.clone());
                    info.bindings.push(Binding {
                        variable: name,
                        term: Term::Input(i, 1),
                    });
                }
            }
        }

        // Process object (position 2)
        match &pattern.object {
            TermPattern::NamedNode(nn) => {
                info.assertions.push(Assertion(
                    Term::Static(GroundTerm::NamedNode(nn.clone())),
                    Term::Input(i, 2),
                ));
            }
            TermPattern::Literal(l) => {
                info.assertions.push(Assertion(
                    Term::Static(GroundTerm::Literal(l.clone())),
                    Term::Input(i, 2),
                ));
            }
            TermPattern::Variable(v) => {
                let name = v.as_str().to_string();
                if seen_vars.contains(&name) {
                    info.assertions.push(Assertion(
                        Term::Variable(name),
                        Term::Input(i, 2),
                    ));
                } else {
                    seen_vars.insert(name.clone());
                    info.bindings.push(Binding {
                        variable: name,
                        term: Term::Input(i, 2),
                    });
                }
            }
            TermPattern::BlankNode(bn) => {
                let name = format!("__blank_{}", bn.as_str());
                if seen_vars.contains(&name) {
                    info.assertions.push(Assertion(
                        Term::Variable(name),
                        Term::Input(i, 2),
                    ));
                } else {
                    seen_vars.insert(name.clone());
                    info.bindings.push(Binding {
                        variable: name,
                        term: Term::Input(i, 2),
                    });
                }
            }
        }
    }

    Ok(info)
}

fn expand_path(
    subject: &TermPattern,
    path: &PropertyPathExpression,
    object: &TermPattern,
) -> Result<GraphPattern, String> {
    match path {
        PropertyPathExpression::NamedNode(nn) => Ok(GraphPattern::Bgp {
            patterns: vec![TriplePattern {
                subject: subject.clone(),
                predicate: NamedNodePattern::NamedNode(nn.clone()),
                object: object.clone(),
            }],
        }),
        PropertyPathExpression::Reverse(inner) => {
            if let PropertyPathExpression::NamedNode(nn) = inner.as_ref() {
                Ok(GraphPattern::Bgp {
                    patterns: vec![TriplePattern {
                        subject: object.clone(),
                        predicate: NamedNodePattern::NamedNode(nn.clone()),
                        object: subject.clone(),
                    }],
                })
            } else {
                Err(format!("Unsupported reverse path: {:?}", path))
            }
        }
        PropertyPathExpression::Sequence(a, b) => {
            let mid = fresh_variable();
            let left = expand_path(subject, a, &mid)?;
            let right = expand_path(&mid, b, object)?;
            Ok(GraphPattern::Join {
                left: Box::new(left),
                right: Box::new(right),
            })
        }
        PropertyPathExpression::Alternative(a, b) => {
            let left = expand_path(subject, a, object)?;
            let right = expand_path(subject, b, object)?;
            Ok(GraphPattern::Union {
                left: Box::new(left),
                right: Box::new(right),
            })
        }
        PropertyPathExpression::ZeroOrOne(inner) => {
            let one = expand_path(subject, inner, object)?;
            let zero = if let TermPattern::Variable(sv) = subject {
                GraphPattern::Extend {
                    inner: Box::new(GraphPattern::Bgp { patterns: vec![] }),
                    variable: sv.clone(),
                    expression: if let TermPattern::Variable(ov) = object {
                        Expression::Variable(ov.clone())
                    } else {
                        return Err("ZeroOrOne requires variable object".into());
                    },
                }
            } else if let TermPattern::Variable(ov) = object {
                GraphPattern::Extend {
                    inner: Box::new(GraphPattern::Bgp { patterns: vec![] }),
                    variable: ov.clone(),
                    expression: if let TermPattern::NamedNode(nn) = subject {
                        Expression::NamedNode(nn.clone())
                    } else {
                        return Err("ZeroOrOne requires named node subject".into());
                    },
                }
            } else if subject == object {
                GraphPattern::Bgp { patterns: vec![] }
            } else {
                GraphPattern::Bgp { patterns: vec![] }
            };
            Ok(GraphPattern::Union {
                left: Box::new(one),
                right: Box::new(zero),
            })
        }
        _ => Err(format!("Unsupported path expression: {:?}", path)),
    }
}

/// Helper to adjust input indices in an optional block by an offset
fn adjust_optional_block_indices(block: &mut OptionalBlock, offset: usize) {
    for binding in &mut block.bindings {
        if let Term::Input(i, j) = &binding.term {
            binding.term = Term::Input(*i + offset, *j);
        }
    }

    for assertion in &mut block.assertions {
        if let Term::Input(i, j) = &assertion.0 {
            assertion.0 = Term::Input(*i + offset, *j);
        }
        if let Term::Input(i, j) = &assertion.1 {
            assertion.1 = Term::Input(*i + offset, *j);
        }
    }

    for nested in &mut block.nested_optionals {
        adjust_optional_block_indices(nested, offset);
    }
}

pub(crate) fn process_graph_pattern(gp: &GraphPattern) -> Result<PatternInfo, String> {
    match gp {
        GraphPattern::Bgp { patterns } => process_patterns(patterns),

        GraphPattern::Path { subject, path, object } => {
            let expanded = expand_path(subject, path, object)?;
            process_graph_pattern(&expanded)
        }

        GraphPattern::Join { left, right } => {
            let left_info = process_graph_pattern(left)?;
            let right_info = process_graph_pattern(right)?;

            let offset = left_info.patterns.len();
            let mut merged = PatternInfo::new();

            merged.patterns.extend(left_info.patterns);
            merged.patterns.extend(right_info.patterns);

            merged.bindings.extend(left_info.bindings);
            for binding in right_info.bindings {
                let adjusted_term = match binding.term {
                    Term::Input(i, j) => Term::Input(i + offset, j),
                    other => other,
                };
                merged.bindings.push(Binding {
                    variable: binding.variable,
                    term: adjusted_term,
                });
            }

            merged.assertions.extend(left_info.assertions);
            for assertion in right_info.assertions {
                let adj_left = match assertion.0 {
                    Term::Input(i, j) => Term::Input(i + offset, j),
                    other => other,
                };
                let adj_right = match assertion.1 {
                    Term::Input(i, j) => Term::Input(i + offset, j),
                    other => other,
                };
                merged.assertions.push(Assertion(adj_left, adj_right));
            }

            merged.filters.extend(left_info.filters);
            merged.filters.extend(right_info.filters);

            if left_info.union_branches.is_some() || right_info.union_branches.is_some() {
                merged.union_branches = left_info.union_branches.or(right_info.union_branches);
            }

            merged.optional_blocks.extend(left_info.optional_blocks);
            for mut opt_block in right_info.optional_blocks {
                adjust_optional_block_indices(&mut opt_block, offset);
                merged.optional_blocks.push(opt_block);
            }

            Ok(merged)
        }

        GraphPattern::Filter { expr, inner } => {
            let mut info = process_graph_pattern(inner)?;
            info.filters.push(expr.clone());
            Ok(info)
        }

        GraphPattern::Extend { inner, variable, expression } => {
            let mut info = process_graph_pattern(inner)?;
            let term = match expression {
                Expression::Variable(v) => Term::Variable(v.as_str().to_string()),
                Expression::NamedNode(nn) => Term::Static(GroundTerm::NamedNode(nn.clone())),
                Expression::Literal(l) => Term::Static(GroundTerm::Literal(l.clone())),
                _ => return Err("Unsupported BIND expression".into()),
            };
            info.bindings.push(Binding {
                variable: variable.as_str().to_string(),
                term,
            });
            Ok(info)
        }

        GraphPattern::LeftJoin { left, right, expression } => {
            let mut left_info = process_graph_pattern(left)?;
            let right_info = process_graph_pattern(right)?;

            let offset = left_info.patterns.len();

            let optional_id = next_optional_id();

            let adjusted_bindings: Vec<Binding> = right_info
                .bindings
                .into_iter()
                .map(|b| Binding {
                    variable: b.variable,
                    term: match b.term {
                        Term::Input(i, j) => Term::Input(i + offset, j),
                        other => other,
                    },
                })
                .collect();

            let adjusted_assertions: Vec<Assertion> = right_info
                .assertions
                .into_iter()
                .map(|a| {
                    let adj_l = match a.0 {
                        Term::Input(i, j) => Term::Input(i + offset, j),
                        other => other,
                    };
                    let adj_r = match a.1 {
                        Term::Input(i, j) => Term::Input(i + offset, j),
                        other => other,
                    };
                    Assertion(adj_l, adj_r)
                })
                .collect();

            let mut optional_filters = right_info.filters;
            if let Some(expr) = expression {
                optional_filters.push(expr.clone());
            }

            let adjusted_nested = right_info
                .optional_blocks
                .into_iter()
                .map(|mut ob| {
                    adjust_optional_block_indices(&mut ob, offset);
                    ob
                })
                .collect();

            let optional_block = OptionalBlock {
                id: optional_id,
                patterns: right_info.patterns,
                bindings: adjusted_bindings,
                assertions: adjusted_assertions,
                filters: optional_filters,
                nested_optionals: adjusted_nested,
            };

            left_info.optional_blocks.push(optional_block);

            Ok(left_info)
        }

        GraphPattern::Union { left, right } => {
            fn collect_branches(
                gp: &GraphPattern,
                out: &mut Vec<PatternInfo>,
            ) -> Result<(), String> {
                match gp {
                    GraphPattern::Union { left, right } => {
                        collect_branches(left, out)?;
                        collect_branches(right, out)?;
                    }
                    _ => {
                        out.push(process_graph_pattern(gp)?);
                    }
                }
                Ok(())
            }

            let mut branches: Vec<PatternInfo> = Vec::new();
            collect_branches(left, &mut branches)?;
            collect_branches(right, &mut branches)?;

            let patterns = branches
                .iter()
                .max_by_key(|b| b.patterns.len())
                .map(|b| b.patterns.clone())
                .unwrap_or_default();

            Ok(PatternInfo {
                patterns,
                bindings: Vec::new(),
                assertions: Vec::new(),
                filters: Vec::new(),
                union_branches: Some(branches),
                optional_blocks: Vec::new(),
            })
        }

        GraphPattern::Graph { name, inner } => {
            let mut info = process_graph_pattern(inner)?;

            let graph_context = match name {
                NamedNodePattern::NamedNode(nn) => GraphContext::NamedNode(nn.as_str().to_string()),
                NamedNodePattern::Variable(v) => GraphContext::Variable(v.as_str().to_string()),
            };

            for pattern in &mut info.patterns {
                pattern.graph = graph_context.clone();
            }

            match name {
                NamedNodePattern::NamedNode(nn) => {
                    for i in 0..info.patterns.len() {
                        info.assertions.push(Assertion(
                            Term::Static(GroundTerm::NamedNode(nn.clone())),
                            Term::Input(i, 3),
                        ));
                    }
                }
                NamedNodePattern::Variable(v) => {
                    let var_name = v.as_str().to_string();
                    if !info.patterns.is_empty() {
                        info.bindings.push(Binding {
                            variable: var_name.clone(),
                            term: Term::Input(0, 3),
                        });
                        for i in 1..info.patterns.len() {
                            info.assertions.push(Assertion(
                                Term::Variable(var_name.clone()),
                                Term::Input(i, 3),
                            ));
                        }
                    }
                }
            }
            Ok(info)
        }

        // Post-processing modifiers — accepted but not enforced in-circuit;
        // the verifier is expected to apply them to the witness.
        GraphPattern::Distinct { inner } => process_graph_pattern(inner),
        GraphPattern::Reduced { inner } => process_graph_pattern(inner),
        GraphPattern::OrderBy { inner, .. } => process_graph_pattern(inner),
        GraphPattern::Slice { inner, .. } => process_graph_pattern(inner),

        _ => Err(format!("Unsupported graph pattern: {:?}", gp)),
    }
}

pub(crate) fn process_query(gp: &GraphPattern) -> Result<QueryInfo, String> {
    // Unwrap post-processing modifiers (DISTINCT, ORDER BY, LIMIT/OFFSET)
    let mut inner = gp;
    loop {
        inner = match inner {
            GraphPattern::Distinct { inner: i } => i,
            GraphPattern::Reduced { inner: i } => i,
            GraphPattern::OrderBy { inner: i, .. } => i,
            GraphPattern::Slice { inner: i, .. } => i,
            _ => break,
        };
    }

    match inner {
        GraphPattern::Project { inner, variables } => {
            let vars: Vec<String> = variables.iter().map(|v| v.as_str().to_string()).collect();
            let pattern = process_graph_pattern(inner)?;
            Ok(QueryInfo { variables: vars, pattern })
        }
        // ASK queries do not have PROJECT — project all bound variables.
        _ => {
            let pattern = process_graph_pattern(inner)?;
            let mut vars: Vec<String> =
                pattern.bindings.iter().map(|b| b.variable.clone()).collect();
            vars.sort();
            vars.dedup();
            Ok(QueryInfo { variables: vars, pattern })
        }
    }
}
