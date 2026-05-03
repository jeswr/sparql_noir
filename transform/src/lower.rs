//! Algebra → IR lowering.
//!
//! Walks spargebra's `GraphPattern` and produces a [`PatternInfo`] /
//! [`QueryInfo`]. Handles BGP processing, property-path expansion,
//! join/union/optional/graph composition, and unwrapping of post-processing
//! modifiers (DISTINCT, ORDER BY, LIMIT/OFFSET, REDUCED). The output is
//! pure data; no Noir code is emitted here.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};

use spargebra::algebra::{
    AggregateExpression, AggregateFunction, Expression, GraphPattern, OrderExpression,
    PropertyPathExpression,
};
use spargebra::term::{GroundTerm, NamedNodePattern, TermPattern, TriplePattern, Variable};

use crate::{
    Aggregate, AggregateKind, Assertion, Binding, ContextualizedTriple, GraphContext,
    OptionalBlock, OrderDirection, OrderKey, PatternInfo, QueryInfo, Term, TransformOptions,
};

static OPTIONAL_BLOCK_COUNTER: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn next_optional_id() -> usize {
    OPTIONAL_BLOCK_COUNTER.fetch_add(1, Ordering::SeqCst)
}

pub(crate) fn reset_optional_counter() {
    OPTIONAL_BLOCK_COUNTER.store(0, Ordering::SeqCst);
    // Reset the fresh-variable counter alongside the optional one so
    // outputs are deterministic per `transform_query` invocation. The
    // counter is otherwise process-global and would race across
    // parallel callers (notably the snapshot test, which exercises
    // many queries in a single process).
    VAR_COUNTER.store(0, Ordering::SeqCst);
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

/// Recursively rewrite a `PropertyPathExpression` so all `Reverse(p)`
/// nodes are pushed down to leaves, using the standard algebraic
/// identities — `^(p1/p2) ≡ ^p2/^p1`, `^(p1|p2) ≡ ^p1|^p2`,
/// `^^p ≡ p`, `^(p+) ≡ (^p)+`, `^(p*) ≡ (^p)*`, `^(p?) ≡ (^p)?`,
/// `^!P ≡ !(rev) over the same set`. After this rewrite every
/// `Reverse` wraps a `NamedNode` or `NegatedPropertySet`, which the
/// rest of `expand_path` can handle directly.
fn normalise_path(path: &PropertyPathExpression) -> PropertyPathExpression {
    use PropertyPathExpression::*;
    match path {
        Reverse(inner) => match inner.as_ref() {
            // ^^p ≡ p
            Reverse(p) => normalise_path(p),
            // ^(p1/p2) ≡ ^p2/^p1
            Sequence(a, b) => Sequence(
                Box::new(normalise_path(&Reverse(b.clone()))),
                Box::new(normalise_path(&Reverse(a.clone()))),
            ),
            // ^(p1|p2) ≡ ^p1|^p2
            Alternative(a, b) => Alternative(
                Box::new(normalise_path(&Reverse(a.clone()))),
                Box::new(normalise_path(&Reverse(b.clone()))),
            ),
            // ^(p+) ≡ (^p)+ — and similarly for * / ?.
            OneOrMore(p) => OneOrMore(Box::new(normalise_path(&Reverse(p.clone())))),
            ZeroOrMore(p) => ZeroOrMore(Box::new(normalise_path(&Reverse(p.clone())))),
            ZeroOrOne(p) => ZeroOrOne(Box::new(normalise_path(&Reverse(p.clone())))),
            // Reverse(NamedNode) and Reverse(NegatedPropertySet) stay
            // as-is — `expand_path` knows how to handle them.
            NamedNode(_) | NegatedPropertySet(_) => Reverse(inner.clone()),
        },
        Sequence(a, b) => Sequence(Box::new(normalise_path(a)), Box::new(normalise_path(b))),
        Alternative(a, b) => {
            Alternative(Box::new(normalise_path(a)), Box::new(normalise_path(b)))
        }
        OneOrMore(p) => OneOrMore(Box::new(normalise_path(p))),
        ZeroOrMore(p) => ZeroOrMore(Box::new(normalise_path(p))),
        ZeroOrOne(p) => ZeroOrOne(Box::new(normalise_path(p))),
        NamedNode(_) | NegatedPropertySet(_) => path.clone(),
    }
}

fn expand_path(
    subject: &TermPattern,
    path: &PropertyPathExpression,
    object: &TermPattern,
    options: &TransformOptions,
) -> Result<GraphPattern, String> {
    let normalised = normalise_path(path);
    expand_normalised_path(subject, &normalised, object, options)
}

/// Build a `FILTER(?p != p1 && ?p != p2 && …)` over an excluded set of
/// IRIs, evaluated against `?pred`. Used to encode NPS `!(p1|p2|…)`.
fn build_nps_filter(pred_var: &Variable, excludes: &[spargebra::term::NamedNode]) -> Expression {
    let mut iter = excludes.iter();
    let first = iter.next().expect("NPS exclude set should be non-empty");
    let mut acc: Expression = Expression::Not(Box::new(Expression::Equal(
        Box::new(Expression::Variable(pred_var.clone())),
        Box::new(Expression::NamedNode(first.clone())),
    )));
    for nn in iter {
        let next = Expression::Not(Box::new(Expression::Equal(
            Box::new(Expression::Variable(pred_var.clone())),
            Box::new(Expression::NamedNode(nn.clone())),
        )));
        acc = Expression::And(Box::new(acc), Box::new(next));
    }
    acc
}

fn fresh_pred_variable() -> Variable {
    let id = VAR_COUNTER.fetch_add(1, Ordering::SeqCst);
    Variable::new_unchecked(format!("__np{}", id))
}

/// Expand a `PropertyPathExpression` that has already been normalised
/// (every `Reverse` wraps a leaf).
fn expand_normalised_path(
    subject: &TermPattern,
    path: &PropertyPathExpression,
    object: &TermPattern,
    options: &TransformOptions,
) -> Result<GraphPattern, String> {
    match path {
        PropertyPathExpression::NamedNode(nn) => Ok(GraphPattern::Bgp {
            patterns: vec![TriplePattern {
                subject: subject.clone(),
                predicate: NamedNodePattern::NamedNode(nn.clone()),
                object: object.clone(),
            }],
        }),
        PropertyPathExpression::Reverse(inner) => match inner.as_ref() {
            PropertyPathExpression::NamedNode(nn) => Ok(GraphPattern::Bgp {
                patterns: vec![TriplePattern {
                    subject: object.clone(),
                    predicate: NamedNodePattern::NamedNode(nn.clone()),
                    object: subject.clone(),
                }],
            }),
            PropertyPathExpression::NegatedPropertySet(excludes) => {
                // ^!{p1,p2,…} — a single triple s ?p o where ?p ∉ excludes,
                // with subject and object swapped (reverse direction).
                expand_negated_property_set(object, subject, excludes)
            }
            _ => Err(format!(
                "internal: normalised path still has nested reverse: {:?}",
                path
            )),
        },
        PropertyPathExpression::Sequence(a, b) => {
            let mid = fresh_variable();
            let left = expand_normalised_path(subject, a, &mid, options)?;
            let right = expand_normalised_path(&mid, b, object, options)?;
            Ok(GraphPattern::Join {
                left: Box::new(left),
                right: Box::new(right),
            })
        }
        PropertyPathExpression::Alternative(a, b) => {
            let left = expand_normalised_path(subject, a, object, options)?;
            let right = expand_normalised_path(subject, b, object, options)?;
            Ok(GraphPattern::Union {
                left: Box::new(left),
                right: Box::new(right),
            })
        }
        PropertyPathExpression::ZeroOrOne(inner) => {
            let one = expand_normalised_path(subject, inner, object, options)?;
            let zero = zero_step_pattern(subject, object)?;
            Ok(GraphPattern::Union {
                left: Box::new(one),
                right: Box::new(zero),
            })
        }
        // p+ — UNION over depths 1..=path_segment_max, each depth being
        // a chain of `inner` joined through fresh intermediate variables
        // (per SPARQL 1.1 §18.5 / preprocessing.md §3.3). The path
        // length leaks (the prover picks a depth) — a documented
        // disclosure.
        PropertyPathExpression::OneOrMore(inner) => {
            let max_depth = options.path_segment_max;
            if max_depth < 1 {
                return Err(
                    "path_segment_max must be at least 1 for a `+` path".into()
                );
            }
            kleene_unroll(subject, inner, object, 1, max_depth, options)
        }
        // p* — same as p+ but with a zero-step branch added.
        PropertyPathExpression::ZeroOrMore(inner) => {
            let max_depth = options.path_segment_max;
            let zero = zero_step_pattern(subject, object)?;
            if max_depth < 1 {
                return Ok(zero);
            }
            let positive = kleene_unroll(subject, inner, object, 1, max_depth, options)?;
            Ok(GraphPattern::Union {
                left: Box::new(zero),
                right: Box::new(positive),
            })
        }
        // !{p1,p2,…} — a single triple `s ?p o` plus `FILTER(?p != p_i)`
        // for each excluded predicate. Bounded by the exclude-set size.
        PropertyPathExpression::NegatedPropertySet(excludes) => {
            expand_negated_property_set(subject, object, excludes)
        }
    }
}

/// Build the BGP that represents the zero-step branch of `?p` /
/// `p?` — i.e. `subject = object`. The semantics across SPARQL 1.1
/// §18.5 require the binding to be a node mentioned in the data;
/// in the context of an inclusion-proof witness we treat the binding
/// as already constrained by the surrounding patterns, so a simple
/// equality `Extend` suffices.
fn zero_step_pattern(
    subject: &TermPattern,
    object: &TermPattern,
) -> Result<GraphPattern, String> {
    let zero = if let TermPattern::Variable(sv) = subject {
        GraphPattern::Extend {
            inner: Box::new(GraphPattern::Bgp { patterns: vec![] }),
            variable: sv.clone(),
            expression: match object {
                TermPattern::Variable(v) => Expression::Variable(v.clone()),
                TermPattern::NamedNode(nn) => Expression::NamedNode(nn.clone()),
                TermPattern::Literal(l) => Expression::Literal(l.clone()),
                _ => return Err("Unsupported zero-step term".into()),
            },
        }
    } else if let TermPattern::Variable(ov) = object {
        GraphPattern::Extend {
            inner: Box::new(GraphPattern::Bgp { patterns: vec![] }),
            variable: ov.clone(),
            expression: match subject {
                TermPattern::NamedNode(nn) => Expression::NamedNode(nn.clone()),
                TermPattern::Literal(l) => Expression::Literal(l.clone()),
                _ => return Err("Unsupported zero-step term".into()),
            },
        }
    } else if subject == object {
        GraphPattern::Bgp { patterns: vec![] }
    } else {
        GraphPattern::Bgp { patterns: vec![] }
    };
    Ok(zero)
}

/// Unroll `p` repeated between `min` and `max` times into a `Union`
/// of join chains. Per SPARQL_ROADMAP.md §3 / §7 round 2 this is the
/// canonical bounded-unrolling reformulation; the chosen depth leaks
/// but the underlying triples remain hidden behind the inclusion
/// witness.
fn kleene_unroll(
    subject: &TermPattern,
    inner: &PropertyPathExpression,
    object: &TermPattern,
    min: usize,
    max: usize,
    options: &TransformOptions,
) -> Result<GraphPattern, String> {
    if min > max {
        return Err(format!(
            "internal: kleene_unroll min ({}) > max ({})",
            min, max
        ));
    }
    let mut acc: Option<GraphPattern> = None;
    for depth in min..=max {
        let chain = build_chain(subject, inner, object, depth, options)?;
        acc = Some(match acc {
            None => chain,
            Some(prev) => GraphPattern::Union {
                left: Box::new(prev),
                right: Box::new(chain),
            },
        });
    }
    acc.ok_or_else(|| {
        "internal: kleene_unroll produced no branches (path_segment_max==0?)".to_string()
    })
}

/// Produce a chain of `depth` `inner` segments joined through fresh
/// intermediate variables, ending at `object`. `depth == 1` collapses
/// to a single `inner` expansion.
fn build_chain(
    subject: &TermPattern,
    inner: &PropertyPathExpression,
    object: &TermPattern,
    depth: usize,
    options: &TransformOptions,
) -> Result<GraphPattern, String> {
    if depth == 0 {
        return zero_step_pattern(subject, object);
    }
    if depth == 1 {
        return expand_normalised_path(subject, inner, object, options);
    }
    // depth >= 2: subject -inner- mid_1 -inner- mid_2 ... -inner- object
    let mut prev_term = subject.clone();
    let mut acc: Option<GraphPattern> = None;
    for step in 0..depth {
        let next_term = if step == depth - 1 {
            object.clone()
        } else {
            fresh_variable()
        };
        let leg = expand_normalised_path(&prev_term, inner, &next_term, options)?;
        acc = Some(match acc {
            None => leg,
            Some(prev) => GraphPattern::Join {
                left: Box::new(prev),
                right: Box::new(leg),
            },
        });
        prev_term = next_term;
    }
    Ok(acc.expect("depth >= 1 produces at least one segment"))
}

/// Expand `!{p1,…,pn}` (negated property set) — a single triple
/// `subject ?p object` plus a filter that asserts `?p` is not equal to
/// any of the excluded predicates. The empty exclude set degrades to
/// `?p` matching anything (no filter).
fn expand_negated_property_set(
    subject: &TermPattern,
    object: &TermPattern,
    excludes: &[spargebra::term::NamedNode],
) -> Result<GraphPattern, String> {
    let pred_var = fresh_pred_variable();
    let triple = TriplePattern {
        subject: subject.clone(),
        predicate: NamedNodePattern::Variable(pred_var.clone()),
        object: object.clone(),
    };
    let bgp = GraphPattern::Bgp { patterns: vec![triple] };
    if excludes.is_empty() {
        return Ok(bgp);
    }
    let filter_expr = build_nps_filter(&pred_var, excludes);
    Ok(GraphPattern::Filter {
        expr: filter_expr,
        inner: Box::new(bgp),
    })
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

#[cfg(test)]
pub(crate) fn process_graph_pattern(gp: &GraphPattern) -> Result<PatternInfo, String> {
    process_graph_pattern_with_options(gp, &TransformOptions::default())
}

pub(crate) fn process_graph_pattern_with_options(
    gp: &GraphPattern,
    options: &TransformOptions,
) -> Result<PatternInfo, String> {
    match gp {
        GraphPattern::Bgp { patterns } => process_patterns(patterns),

        GraphPattern::Path { subject, path, object } => {
            let expanded = expand_path(subject, path, object, options)?;
            process_graph_pattern_with_options(&expanded, options)
        }

        GraphPattern::Join { left, right } => {
            let left_info = process_graph_pattern_with_options(left, options)?;
            let right_info = process_graph_pattern_with_options(right, options)?;

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
            let mut info = process_graph_pattern_with_options(inner, options)?;
            info.filters.push(expr.clone());
            Ok(info)
        }

        GraphPattern::Extend { inner, variable, expression } => {
            let mut info = process_graph_pattern_with_options(inner, options)?;
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
            let mut left_info = process_graph_pattern_with_options(left, options)?;
            let right_info = process_graph_pattern_with_options(right, options)?;

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
                options: &TransformOptions,
            ) -> Result<(), String> {
                match gp {
                    GraphPattern::Union { left, right } => {
                        collect_branches(left, out, options)?;
                        collect_branches(right, out, options)?;
                    }
                    _ => {
                        out.push(process_graph_pattern_with_options(gp, options)?);
                    }
                }
                Ok(())
            }

            let mut branches: Vec<PatternInfo> = Vec::new();
            collect_branches(left, &mut branches, options)?;
            collect_branches(right, &mut branches, options)?;

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
            let mut info = process_graph_pattern_with_options(inner, options)?;

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
        GraphPattern::Distinct { inner } => process_graph_pattern_with_options(inner, options),
        GraphPattern::Reduced { inner } => process_graph_pattern_with_options(inner, options),
        GraphPattern::OrderBy { inner, .. } => {
            process_graph_pattern_with_options(inner, options)
        }
        GraphPattern::Slice { inner, .. } => process_graph_pattern_with_options(inner, options),

        _ => Err(format!("Unsupported graph pattern: {:?}", gp)),
    }
}

/// Extract aggregate / order-by / limit / offset modifiers from the
/// algebra root, leaving an `inner` that is either a `Project` or a
/// non-projecting pattern (for ASK).
///
/// The disclose-and-verify approach (SPARQL_ROADMAP.md §8.6, Q6
/// decision 2026-05-03) means these modifiers contribute *only* to
/// `metadata.json`; the circuit body is identical to the underlying
/// pattern. No DISTINCT / sort / count primitives are emitted.
struct PostProcessing {
    order_by: Vec<OrderKey>,
    limit: Option<usize>,
    offset: Option<usize>,
}

impl PostProcessing {
    fn empty() -> Self {
        Self {
            order_by: Vec::new(),
            limit: None,
            offset: None,
        }
    }
}

/// Convert a spargebra `OrderExpression` into our IR. Only variable
/// keys are supported for now — arbitrary expressions would force the
/// verifier to recompute them, which we punt to a follow-up.
fn order_expression_to_key(expr: &OrderExpression) -> Result<OrderKey, String> {
    let (direction, inner) = match expr {
        OrderExpression::Asc(e) => (OrderDirection::Asc, e),
        OrderExpression::Desc(e) => (OrderDirection::Desc, e),
    };
    match inner {
        Expression::Variable(v) => Ok(OrderKey {
            variable: v.as_str().to_string(),
            direction,
        }),
        other => Err(format!(
            "ORDER BY by non-variable expression is not yet supported: {:?}",
            other
        )),
    }
}

/// Translate a spargebra `AggregateExpression` over `?source` into the
/// IR, given the variable name the aggregate result is bound to in the
/// outer projection.
fn aggregate_expression_to_kind(
    agg: &AggregateExpression,
) -> Result<(AggregateKind, Option<String>), String> {
    match agg {
        AggregateExpression::CountSolutions { distinct } => {
            Ok((AggregateKind::CountSolutions { distinct: *distinct }, None))
        }
        AggregateExpression::FunctionCall { name, expr, distinct } => {
            let source = match expr {
                Expression::Variable(v) => Some(v.as_str().to_string()),
                other => {
                    return Err(format!(
                        "Aggregate over non-variable expression is not yet supported: {:?}",
                        other
                    ));
                }
            };
            let kind = match name {
                AggregateFunction::Count => {
                    if *distinct {
                        AggregateKind::CountDistinct
                    } else {
                        AggregateKind::Count
                    }
                }
                AggregateFunction::Sum => AggregateKind::Sum { distinct: *distinct },
                AggregateFunction::Min => AggregateKind::Min { distinct: *distinct },
                AggregateFunction::Max => AggregateKind::Max { distinct: *distinct },
                AggregateFunction::Avg => AggregateKind::Avg { distinct: *distinct },
                AggregateFunction::GroupConcat { .. } => {
                    return Err(
                        "GROUP_CONCAT is not yet implemented (deferred — bounded string handling)"
                            .into(),
                    );
                }
                AggregateFunction::Sample => {
                    return Err(
                        "SAMPLE is not yet implemented (non-deterministic; out of scope for round 2)"
                            .into(),
                    );
                }
                AggregateFunction::Custom(iri) => {
                    return Err(format!("Custom aggregate function not supported: {}", iri));
                }
            };
            Ok((kind, source))
        }
    }
}

/// Strip outer modifiers and remember them. Order matters because
/// spargebra normalises into a fixed shape:
///
/// ```text
/// Slice { inner: Project { inner: OrderBy { inner: Extend* {
///     Group { inner: <pattern>, aggregates: [...] } } } } }
/// ```
fn strip_post_processing(gp: &GraphPattern) -> (&GraphPattern, PostProcessing) {
    let mut post = PostProcessing::empty();
    let mut current = gp;
    loop {
        match current {
            GraphPattern::Slice {
                inner,
                start,
                length,
            } => {
                if *start > 0 {
                    post.offset = Some(*start);
                }
                if let Some(l) = length {
                    post.limit = Some(*l);
                }
                current = inner;
            }
            GraphPattern::Distinct { inner } | GraphPattern::Reduced { inner } => {
                current = inner;
            }
            // Top-level ORDER BY is rare (it's normally inside the
            // Project), but unwrap it defensively.
            GraphPattern::OrderBy { inner, expression } => {
                for e in expression {
                    if let Ok(key) = order_expression_to_key(e) {
                        post.order_by.push(key);
                    }
                }
                current = inner;
            }
            _ => break,
        }
    }
    (current, post)
}

/// Does the eventual leaf of this pattern (after stripping
/// `Extend` / `OrderBy` / `Distinct` / `Reduced`) reach a `Group`?
/// If so, intervening `Extend` nodes are aggregate-result aliases
/// that we want to capture; otherwise they are user `BIND`s that the
/// regular `process_graph_pattern` lowering must handle.
fn project_inner_has_group(gp: &GraphPattern) -> bool {
    let mut current = gp;
    loop {
        match current {
            GraphPattern::Group { .. } => return true,
            GraphPattern::OrderBy { inner, .. }
            | GraphPattern::Distinct { inner }
            | GraphPattern::Reduced { inner }
            | GraphPattern::Extend { inner, .. } => current = inner,
            _ => return false,
        }
    }
}

/// Walk the inner of a `Project` to collect ORDER BY keys, aggregate
/// `Extend` aliases, and the underlying pattern. Aggregate aliases
/// are only stripped when there is a `Group` underneath — otherwise
/// the `Extend` is a user `BIND` and stays in the body.
fn unwrap_project_inner<'a>(
    inner: &'a GraphPattern,
    post: &mut PostProcessing,
    aggregate_alias: &mut std::collections::HashMap<String, String>,
) -> Result<&'a GraphPattern, String> {
    let has_group = project_inner_has_group(inner);
    let mut current = inner;
    loop {
        match current {
            GraphPattern::OrderBy { inner, expression } => {
                for e in expression {
                    post.order_by.push(order_expression_to_key(e)?);
                }
                current = inner;
            }
            GraphPattern::Distinct { inner } | GraphPattern::Reduced { inner } => {
                current = inner;
            }
            // `Extend { variable: ?out, expression: Variable(?intermediate) }`
            // is the alias spargebra inserts to bind a `Group`'s
            // anonymous result to the outer projection name. Only
            // strip it when there really is a `Group` underneath —
            // otherwise it's a user `BIND` that the regular pattern
            // lowering needs to see.
            GraphPattern::Extend {
                inner,
                variable,
                expression: Expression::Variable(source),
            } if has_group => {
                aggregate_alias
                    .insert(source.as_str().to_string(), variable.as_str().to_string());
                current = inner;
            }
            _ => break,
        }
    }
    Ok(current)
}

#[cfg(test)]
pub(crate) fn process_query(gp: &GraphPattern) -> Result<QueryInfo, String> {
    process_query_with_options(gp, &TransformOptions::default())
}

pub(crate) fn process_query_with_options(
    gp: &GraphPattern,
    options: &TransformOptions,
) -> Result<QueryInfo, String> {
    let (inner, mut post) = strip_post_processing(gp);

    match inner {
        GraphPattern::Project { inner, variables } => {
            let vars: Vec<String> = variables.iter().map(|v| v.as_str().to_string()).collect();

            let mut aggregate_alias: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();

            let body = unwrap_project_inner(inner, &mut post, &mut aggregate_alias)?;

            let (pattern, aggregates) = match body {
                GraphPattern::Group {
                    inner,
                    variables: group_vars,
                    aggregates: aggs,
                } => {
                    if !group_vars.is_empty() {
                        return Err(
                            "GROUP BY with explicit grouping variables is not yet implemented \
                             (deferred — needs partition semantics)"
                                .into(),
                        );
                    }
                    let pattern = process_graph_pattern_with_options(inner, options)?;
                    let mut translated: Vec<Aggregate> = Vec::with_capacity(aggs.len());
                    for (intermediate, agg_expr) in aggs {
                        let intermediate_name = intermediate.as_str().to_string();
                        let output = aggregate_alias
                            .get(&intermediate_name)
                            .cloned()
                            .unwrap_or(intermediate_name);
                        let (kind, source) = aggregate_expression_to_kind(agg_expr)?;
                        translated.push(Aggregate { kind, source, output });
                    }
                    (pattern, translated)
                }
                other => (process_graph_pattern_with_options(other, options)?, Vec::new()),
            };

            // Per the disclose-and-verify pattern (SPARQL_ROADMAP.md
            // §8.6 Q6 decision 2026-05-03), the circuit discloses the
            // *source* multisets — the aggregate output variables are
            // computed externally by the verifier and never appear as
            // circuit bindings. Replace each aggregate output in the
            // projected variable list with its source variable, then
            // dedupe while preserving the first-seen order.
            let circuit_vars = if aggregates.is_empty() {
                vars
            } else {
                let agg_outputs: std::collections::HashSet<String> =
                    aggregates.iter().map(|a| a.output.clone()).collect();
                let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
                let mut result: Vec<String> = Vec::new();
                for v in &vars {
                    if agg_outputs.contains(v) {
                        // Replace with this aggregate's source (if any).
                        // `COUNT(*)` has no source — it just discloses
                        // the underlying solution multiset.
                        if let Some(agg) = aggregates.iter().find(|a| &a.output == v) {
                            if let Some(src) = &agg.source {
                                if seen.insert(src.clone()) {
                                    result.push(src.clone());
                                }
                            }
                        }
                    } else if seen.insert(v.clone()) {
                        result.push(v.clone());
                    }
                }
                // If the projected variables collapse to nothing
                // (e.g. `SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }`),
                // fall back to disclosing every bound variable. Empty
                // `Variables` would make `main.nr` trivially satisfiable.
                if result.is_empty() {
                    let mut all: Vec<String> = pattern
                        .bindings
                        .iter()
                        .map(|b| b.variable.clone())
                        .filter(|v| !v.starts_with("__"))
                        .collect();
                    all.sort();
                    all.dedup();
                    all
                } else {
                    result
                }
            };

            Ok(QueryInfo {
                variables: circuit_vars,
                pattern,
                aggregates,
                order_by: post.order_by,
                limit: post.limit,
                offset: post.offset,
            })
        }
        // ASK queries do not have PROJECT — project all bound variables.
        _ => {
            let pattern = process_graph_pattern_with_options(inner, options)?;
            let mut vars: Vec<String> =
                pattern.bindings.iter().map(|b| b.variable.clone()).collect();
            vars.sort();
            vars.dedup();
            Ok(QueryInfo {
                variables: vars,
                pattern,
                aggregates: Vec::new(),
                order_by: post.order_by,
                limit: post.limit,
                offset: post.offset,
            })
        }
    }
}
