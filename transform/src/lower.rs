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
use spargebra::term::{GroundTerm, Literal, NamedNode, NamedNodePattern, TermPattern, TriplePattern, Variable};

use crate::{
    Aggregate, AggregateKind, Assertion, Binding, ContextualizedTriple, EasyOptional, GraphContext,
    OptionalBlock, OrderDirection, OrderKey, PatternInfo, QueryInfo, Term, TransformOptions,
};

static OPTIONAL_BLOCK_COUNTER: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn next_optional_id() -> usize {
    OPTIONAL_BLOCK_COUNTER.fetch_add(1, Ordering::SeqCst)
}

pub(crate) fn reset_optional_counter() {
    OPTIONAL_BLOCK_COUNTER.store(0, Ordering::SeqCst);
}

/// Per-query source of fresh variable / predicate names. Threaded
/// through the lowering instead of a global atomic so concurrent
/// `transform_query` callers don't race on counter values (and so the
/// snapshot test's many-queries-in-one-process pattern is stable).
#[derive(Default)]
pub(crate) struct FreshSource {
    counter: usize,
}

impl FreshSource {
    fn next_id(&mut self) -> usize {
        let id = self.counter;
        self.counter += 1;
        id
    }

    fn fresh_variable(&mut self) -> TermPattern {
        TermPattern::Variable(Variable::new_unchecked(format!("__v{}", self.next_id())))
    }

    fn fresh_pred(&mut self) -> Variable {
        Variable::new_unchecked(format!("__np{}", self.next_id()))
    }

    /// Mint a fresh inner-only EXISTS variable name. The name carries
    /// the source variable for readability in metadata / debug
    /// snapshots. Per-query `FreshSource` ensures no two EXISTS
    /// blocks (in the same query or across concurrent queries) ever
    /// produce the same `__exists_*` identifier.
    fn fresh_exists_var(&mut self, orig: &str) -> String {
        format!("__exists_{}_{}", orig, self.next_id())
    }
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

/// Adjust every `Term::Input(i, j)` reference in a `PatternInfo` by
/// `offset`. Used when concatenating two pattern infos where the
/// right side's input indices need shifting after the left side's
/// triples.
fn shift_pattern_inputs(info: &mut PatternInfo, offset: usize) {
    if offset == 0 {
        return;
    }
    for binding in &mut info.bindings {
        if let Term::Input(i, j) = &binding.term {
            binding.term = Term::Input(*i + offset, *j);
        }
    }
    for assertion in &mut info.assertions {
        if let Term::Input(i, j) = &assertion.0 {
            assertion.0 = Term::Input(*i + offset, *j);
        }
        if let Term::Input(i, j) = &assertion.1 {
            assertion.1 = Term::Input(*i + offset, *j);
        }
    }
    if let Some(branches) = info.union_branches.as_mut() {
        for branch in branches {
            shift_pattern_inputs(branch, offset);
        }
    }
    for opt in &mut info.optional_blocks {
        adjust_optional_block_indices(opt, offset);
    }
    for ne in &mut info.not_exists {
        ne.bracket_left_idx += offset;
        ne.bracket_right_idx += offset;
        for term in &mut ne.absent_terms {
            if let Term::Input(i, j) = term {
                *term = Term::Input(*i + offset, *j);
            }
        }
    }
    for eo in &mut info.easy_optionals {
        eo.matched_idx += offset;
        eo.bracket_left_idx += offset;
        eo.bracket_right_idx += offset;
        for term in &mut eo.inner_terms {
            if let Term::Input(i, j) = term {
                *term = Term::Input(*i + offset, *j);
            }
        }
    }
}

/// Compute `Join(left, right)` over two `PatternInfo`s with the
/// SPARQL-1.1 §18.2.2.6 join semantics. The complication is UNION
/// distribution: when one side is a `union_branches` pattern, every
/// branch must inherit the *other* side's constraints (otherwise a
/// prover could pick a branch with fewer constraints — the high-
/// severity finding from roborev #332). Cases:
///
/// - neither has UNION → merge bindings / assertions / filters /
///   optionals as before.
/// - only one has UNION → distribute the plain side's constraints
///   into every branch of the UNION side.
/// - both have UNION → cross-product the branches, distributing
///   each pair into a single combined branch.
fn join_pattern_infos(
    left: PatternInfo,
    right: PatternInfo,
) -> Result<PatternInfo, String> {
    let offset = left.patterns.len();

    // Shift the right side's input indices so they refer to the
    // merged BGP's positions (left's patterns occupy `0..offset`,
    // right's occupy `offset..`).
    let mut right = right;
    shift_pattern_inputs(&mut right, offset);

    match (left.union_branches.is_some(), right.union_branches.is_some()) {
        (false, false) => {
            // Plain merge.
            let mut merged = PatternInfo::new();
            merged.patterns.extend(left.patterns);
            merged.patterns.extend(right.patterns);
            merged.bindings.extend(left.bindings);
            merged.bindings.extend(right.bindings);
            merged.assertions.extend(left.assertions);
            merged.assertions.extend(right.assertions);
            merged.filters.extend(left.filters);
            merged.filters.extend(right.filters);
            merged.optional_blocks.extend(left.optional_blocks);
            merged.optional_blocks.extend(right.optional_blocks);
            merged.not_exists.extend(left.not_exists);
            merged.not_exists.extend(right.not_exists);
            Ok(merged)
        }
        (true, false) => {
            // UNION-left + plain-right — left branch patterns come
            // first, then plain right (matching the index shift we
            // applied to right's patterns above).
            Ok(distribute_into_branches(left, right, BranchOrder::FirstThenSecond))
        }
        (false, true) => {
            // Plain-left + UNION-right — left's plain patterns come
            // first; each branch must place plain left BEFORE the
            // shifted union-right patterns so the assertions match
            // the shifted indices.
            Ok(distribute_into_branches(right, left, BranchOrder::SecondThenFirst))
        }
        (true, true) => {
            // Cross-product: every pair of branches becomes a single
            // combined branch. Left's patterns come first per the
            // pre-shift offset.
            let left_branches = left.union_branches.clone().unwrap_or_default();
            let right_branches = right.union_branches.clone().unwrap_or_default();
            let mut combined: Vec<PatternInfo> = Vec::new();
            for lb in &left_branches {
                for rb in &right_branches {
                    let mut branch = PatternInfo::new();
                    branch.patterns.extend(lb.patterns.clone());
                    branch.patterns.extend(rb.patterns.clone());
                    branch.bindings.extend(lb.bindings.clone());
                    branch.bindings.extend(rb.bindings.clone());
                    branch.assertions.extend(lb.assertions.clone());
                    branch.assertions.extend(rb.assertions.clone());
                    branch.filters.extend(lb.filters.clone());
                    branch.filters.extend(rb.filters.clone());
                    combined.push(branch);
                }
            }
            let patterns = combined
                .iter()
                .max_by_key(|b| b.patterns.len())
                .map(|b| b.patterns.clone())
                .unwrap_or_default();
            let mut merged = PatternInfo {
                patterns,
                bindings: Vec::new(),
                assertions: Vec::new(),
                filters: Vec::new(),
                union_branches: Some(combined),
                optional_blocks: Vec::new(),
                not_exists: Vec::new(),
                easy_optionals: Vec::new(),
            };
            merged.optional_blocks.extend(left.optional_blocks);
            merged.optional_blocks.extend(right.optional_blocks);
            merged.not_exists.extend(left.not_exists);
            merged.not_exists.extend(right.not_exists);
            merged.easy_optionals.extend(left.easy_optionals);
            merged.easy_optionals.extend(right.easy_optionals);
            Ok(merged)
        }
    }
}

/// Whether the `with_branches` patterns or the `plain` patterns
/// should appear first inside each merged branch. The choice is
/// driven by which side was shifted to the higher index range in the
/// BGP — patterns must appear in the same order as their indices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BranchOrder {
    /// `with_branches` patterns first, then `plain`. Used when the
    /// UNION side is the join's left operand (so its patterns are
    /// `0..offset`, plain right's are `offset..`).
    FirstThenSecond,
    /// `plain` first, then `with_branches`. Used when the UNION side
    /// is the join's right operand (so plain left's patterns are
    /// `0..offset`, the UNION's are `offset..`).
    SecondThenFirst,
}

/// Distribute a plain-side `PatternInfo` into every branch of a
/// UNION-side `PatternInfo`, preserving the BGP-index ordering
/// dictated by `order`.
fn distribute_into_branches(
    with_branches: PatternInfo,
    plain: PatternInfo,
    order: BranchOrder,
) -> PatternInfo {
    let branches = with_branches.union_branches.clone().unwrap_or_default();
    let mut combined: Vec<PatternInfo> = Vec::with_capacity(branches.len());
    for b in &branches {
        let mut branch = PatternInfo::new();
        let (first, second): (&PatternInfo, &PatternInfo) = match order {
            BranchOrder::FirstThenSecond => (b, &plain),
            BranchOrder::SecondThenFirst => (&plain, b),
        };
        branch.patterns.extend(first.patterns.clone());
        branch.patterns.extend(second.patterns.clone());
        branch.bindings.extend(first.bindings.clone());
        branch.bindings.extend(second.bindings.clone());
        branch.assertions.extend(first.assertions.clone());
        branch.assertions.extend(second.assertions.clone());
        branch.filters.extend(first.filters.clone());
        branch.filters.extend(second.filters.clone());
        combined.push(branch);
    }
    let patterns = combined
        .iter()
        .max_by_key(|b| b.patterns.len())
        .map(|b| b.patterns.clone())
        .unwrap_or_default();
    let mut merged = PatternInfo {
        patterns,
        bindings: Vec::new(),
        assertions: Vec::new(),
        filters: Vec::new(),
        union_branches: Some(combined),
        optional_blocks: Vec::new(),
        not_exists: Vec::new(),
        easy_optionals: Vec::new(),
    };
    // Optionals and non-existence obligations are top-level concerns —
    // preserve them outside the branches.
    merged.optional_blocks.extend(with_branches.optional_blocks);
    merged.optional_blocks.extend(plain.optional_blocks);
    merged.not_exists.extend(with_branches.not_exists);
    merged.not_exists.extend(plain.not_exists);
    merged.easy_optionals.extend(with_branches.easy_optionals);
    merged.easy_optionals.extend(plain.easy_optionals);
    merged
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
    fresh: &mut FreshSource,
) -> Result<GraphPattern, String> {
    let normalised = normalise_path(path);
    expand_normalised_path(subject, &normalised, object, options, fresh)
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

/// Expand a `PropertyPathExpression` that has already been normalised
/// (every `Reverse` wraps a leaf).
fn expand_normalised_path(
    subject: &TermPattern,
    path: &PropertyPathExpression,
    object: &TermPattern,
    options: &TransformOptions,
    fresh: &mut FreshSource,
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
                expand_negated_property_set(object, subject, excludes, fresh)
            }
            _ => Err(format!(
                "internal: normalised path still has nested reverse: {:?}",
                path
            )),
        },
        PropertyPathExpression::Sequence(a, b) => {
            let mid = fresh.fresh_variable();
            let left = expand_normalised_path(subject, a, &mid, options, fresh)?;
            let right = expand_normalised_path(&mid, b, object, options, fresh)?;
            Ok(GraphPattern::Join {
                left: Box::new(left),
                right: Box::new(right),
            })
        }
        PropertyPathExpression::Alternative(a, b) => {
            let left = expand_normalised_path(subject, a, object, options, fresh)?;
            let right = expand_normalised_path(subject, b, object, options, fresh)?;
            Ok(GraphPattern::Union {
                left: Box::new(left),
                right: Box::new(right),
            })
        }
        PropertyPathExpression::ZeroOrOne(inner) => {
            let one = expand_normalised_path(subject, inner, object, options, fresh)?;
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
            kleene_unroll(subject, inner, object, 1, max_depth, options, fresh)
        }
        // p* — same as p+ but with a zero-step branch added.
        PropertyPathExpression::ZeroOrMore(inner) => {
            let max_depth = options.path_segment_max;
            let zero = zero_step_pattern(subject, object)?;
            if max_depth < 1 {
                return Ok(zero);
            }
            let positive =
                kleene_unroll(subject, inner, object, 1, max_depth, options, fresh)?;
            Ok(GraphPattern::Union {
                left: Box::new(zero),
                right: Box::new(positive),
            })
        }
        // !{p1,p2,…} — a single triple `s ?p o` plus `FILTER(?p != p_i)`
        // for each excluded predicate. Bounded by the exclude-set size.
        PropertyPathExpression::NegatedPropertySet(excludes) => {
            expand_negated_property_set(subject, object, excludes, fresh)
        }
    }
}

/// Lower `Expression::Exists(P)` and `Expression::Not(Expression::Exists(P))`
/// occurrences within a filter expression. EXISTS flattens via the §2
/// reformulation (each inner triple is added to the outer BGP under
/// inclusion + unification); NOT EXISTS lowers via the §3.3
/// sorted-commitment non-membership primitive (each inner triple
/// becomes a `NonExistenceConstraint` with two bracket leaves placed in
/// the BGP and an absent-hash assertion derived from the outer μ).
///
/// Both forms are accepted as the **root** of the filter expression
/// only (no nesting under `And`/`Or`/`Not` outside the canonical
/// `Not(Exists(_))` parse-shape). The boolean-context integration is a
/// follow-up — see `spec/exists.md` §7.
fn lower_exists_in_expression(
    expr: &Expression,
    info: &mut PatternInfo,
    options: &TransformOptions,
    fresh: &mut FreshSource,
) -> Result<Expression, String> {
    match expr {
        Expression::Exists(inner) => {
            flatten_exists_into(inner, info, options, fresh)?;
            Ok(true_literal())
        }
        // `NOT EXISTS` parses as `Not(Exists(_))` (spargebra parser.rs
        // ~L2335). Lower to a `NonExistenceConstraint`.
        Expression::Not(boxed) => {
            if let Expression::Exists(inner) = boxed.as_ref() {
                lower_not_exists_into(inner, info, options, fresh)?;
                Ok(true_literal())
            } else if expression_contains_exists(boxed) {
                Err(
                    "EXISTS nested inside `!`/`&&`/`||` is not yet implemented \
                     (round 3 supports `FILTER(EXISTS { … })` and `FILTER(NOT EXISTS { … })` \
                     at the filter root only). See spec/exists.md §7 open question 3."
                        .into(),
                )
            } else {
                Ok(expr.clone())
            }
        }
        Expression::And(_, _)
        | Expression::Or(_, _)
        | Expression::If(_, _, _)
        | Expression::Coalesce(_)
        | Expression::FunctionCall(_, _)
        | Expression::In(_, _) => {
            if expression_contains_exists(expr) {
                Err(
                    "EXISTS / NOT EXISTS nested inside `&&`/`||`/IF/COALESCE/IN/FunctionCall \
                     is not yet implemented (round 3 supports them at the filter root only). \
                     See spec/exists.md §7 open question 3."
                        .into(),
                )
            } else {
                Ok(expr.clone())
            }
        }
        // Leaf and shape-preserving expressions that cannot transitively
        // contain EXISTS — pass through untouched.
        _ => Ok(expr.clone()),
    }
}

/// Lower `FILTER(NOT EXISTS { P })` into a `NonExistenceConstraint`.
///
/// Restricted to **single-triple ground-inner** patterns: `P` must be a
/// BGP with exactly one triple, and every variable in that triple must
/// already be bound in the outer scope (i.e. the substitution by the
/// outer μ produces a fully ground triple at prove time). Multi-triple
/// or non-ground inner patterns are rejected with a clear error.
///
/// Witness shape: two adjacent bracket leaves are appended to
/// `info.patterns` (so they pick up the standard per-triple inclusion
/// check in `main.nr`); the absent-hash position assertions land via
/// the new `NonExistenceConstraint` whose `absent_terms` reference the
/// outer-bound variables / inline literals; the emit layer adds a call
/// to `noir::utils::verify_non_membership_no_inclusion`.
fn lower_not_exists_into(
    inner: &GraphPattern,
    info: &mut PatternInfo,
    options: &TransformOptions,
    fresh: &mut FreshSource,
) -> Result<(), String> {
    if info.union_branches.is_some() {
        return Err(
            "NOT EXISTS inside a FILTER over a UNION outer pattern is not yet implemented. \
             The current lowering has no per-branch binding scope to correlate against. \
             See spec/exists.md §7."
                .into(),
        );
    }

    let inner_info = process_graph_pattern_inner(inner, options, fresh)?;
    if inner_info.union_branches.is_some()
        || !inner_info.optional_blocks.is_empty()
        || !inner_info.not_exists.is_empty()
    {
        return Err(
            "NOT EXISTS with UNION / OPTIONAL / nested NOT-EXISTS inner patterns is not yet \
             implemented (round 3 main event ships single-triple ground-inner only). \
             See spec/exists.md §7."
                .into(),
        );
    }
    if inner_info.patterns.len() != 1 {
        return Err(format!(
            "NOT EXISTS supports single-triple inner patterns only (got {} triples). \
             Multi-triple non-membership requires either bounded enumeration over candidate \
             inner bindings (does not scale) or a per-substitution branching design (round-4 \
             follow-up). See spec/exists.md §7.",
            inner_info.patterns.len()
        ));
    }

    // Inner triple's variables must all be bound in the outer scope —
    // enforced by checking `inner_info.bindings` (which `process_patterns`
    // populates with one entry per fresh-to-this-pattern variable). Any
    // entry there is an inner-only variable: reject.
    let outer_bound: std::collections::BTreeSet<String> = info
        .bindings
        .iter()
        .map(|b| b.variable.clone())
        .collect();
    for binding in &inner_info.bindings {
        if !outer_bound.contains(&binding.variable) {
            return Err(format!(
                "NOT EXISTS supports ground-inner patterns only (variable `?{}` in the inner \
                 pattern is not bound by the outer mapping). Non-ground-inner NOT EXISTS \
                 requires a per-substitution branching design. See spec/exists.md §7.",
                binding.variable
            ));
        }
    }
    if !inner_info.filters.is_empty() {
        return Err(
            "NOT EXISTS with inner FILTER expressions is not yet implemented. \
             See spec/exists.md §7."
                .into(),
        );
    }

    // Build absent_terms[0..4] from the inner triple's spargebra
    // patterns: variables become `Term::Variable(name)` (resolved via
    // the outer scope at emit time), constants become `Term::Static`,
    // graph context follows `info`'s lowering convention. We don't read
    // from `inner_info.assertions` because the inner triple was processed
    // with its own offset; instead we extract directly from the
    // spargebra `TriplePattern` to get a clean `[Term; 4]`.
    let inner_pattern = &inner_info.patterns[0];
    let absent_terms = absent_terms_from_pattern(inner_pattern)?;

    // Append the bracket leaves: they live in the outer BGP at indices
    // `outer_n` and `outer_n + 1`, picking up the standard per-triple
    // Merkle-inclusion check from `main.nr`. They have no
    // position-binding assertions to outer variables — the prover
    // chooses which two adjacent leaves to supply, constrained only by
    // the strict-ordering / adjacency check `verify_non_membership`
    // emits in `checkBinding`.
    let outer_n = info.patterns.len();
    info.patterns.push(bracket_placeholder_pattern(&inner_pattern.graph));
    info.patterns.push(bracket_placeholder_pattern(&inner_pattern.graph));

    info.not_exists.push(crate::ir::NonExistenceConstraint {
        bracket_left_idx: outer_n,
        bracket_right_idx: outer_n + 1,
        absent_terms,
    });

    Ok(())
}

/// Build a `[Term; 4]` from a spargebra `TriplePattern` for use as the
/// absent-hash positions of a `NonExistenceConstraint`. Variables map
/// to `Term::Variable(name)` so the emit layer substitutes the outer
/// μ; literals / IRIs / blank nodes map to `Term::Static`.
fn absent_terms_from_pattern(ct: &ContextualizedTriple) -> Result<[Term; 4], String> {
    let subj = match &ct.pattern.subject {
        TermPattern::NamedNode(nn) => Term::Static(GroundTerm::NamedNode(nn.clone())),
        TermPattern::Variable(v) => Term::Variable(v.as_str().to_string()),
        TermPattern::BlankNode(bn) => Term::Variable(format!("__blank_{}", bn.as_str())),
        TermPattern::Literal(_) => return Err("Literal in NOT EXISTS subject position".into()),
    };
    let pred = match &ct.pattern.predicate {
        NamedNodePattern::NamedNode(nn) => Term::Static(GroundTerm::NamedNode(nn.clone())),
        NamedNodePattern::Variable(v) => Term::Variable(v.as_str().to_string()),
    };
    let obj = match &ct.pattern.object {
        TermPattern::NamedNode(nn) => Term::Static(GroundTerm::NamedNode(nn.clone())),
        TermPattern::Variable(v) => Term::Variable(v.as_str().to_string()),
        TermPattern::BlankNode(bn) => Term::Variable(format!("__blank_{}", bn.as_str())),
        TermPattern::Literal(l) => Term::Static(GroundTerm::Literal(l.clone())),
    };
    let graph = match &ct.graph {
        GraphContext::Default => Term::Static(GroundTerm::NamedNode(
            // Default graph is encoded as the empty-string IRI per
            // the existing `getTermEncodingString` convention.
            NamedNode::new_unchecked(""),
        )),
        GraphContext::NamedNode(iri) => {
            Term::Static(GroundTerm::NamedNode(NamedNode::new_unchecked(iri.clone())))
        }
        GraphContext::Variable(name) => Term::Variable(name.clone()),
    };
    Ok([subj, pred, obj, graph])
}

/// A bracket-leaf BGP slot has no syntactic SPARQL pattern to attach
/// to — the prover picks which two adjacent leaves bracket the absent
/// hash. We synthesise free-variable placeholders (`?__br_*`) so the
/// metadata round-trips deterministically; their `__`-prefix excludes
/// them from projections (`process_query` ~L780).
fn bracket_placeholder_pattern(graph: &GraphContext) -> ContextualizedTriple {
    use std::sync::atomic::Ordering as A;
    let id = BRACKET_COUNTER.fetch_add(1, A::SeqCst);
    let s = Variable::new_unchecked(format!("__br_s_{}", id));
    let p = Variable::new_unchecked(format!("__br_p_{}", id));
    let o = Variable::new_unchecked(format!("__br_o_{}", id));
    ContextualizedTriple {
        pattern: TriplePattern {
            subject: TermPattern::Variable(s),
            predicate: NamedNodePattern::Variable(p),
            object: TermPattern::Variable(o),
        },
        graph: graph.clone(),
    }
}

/// Per-query bracket placeholder counter. Reset at the start of each
/// `transform_query` call so snapshot fixtures stay stable across
/// many-queries-in-one-process runs.
static BRACKET_COUNTER: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

pub(crate) fn reset_bracket_counter() {
    BRACKET_COUNTER.store(0, std::sync::atomic::Ordering::SeqCst);
}

/// Collect the set of in-scope variable names of a `GraphPattern`.
/// Used by the `MINUS` lowering to detect the W3C variable-disjoint
/// no-op case (§18.5: when `dom(μ) ∩ dom(μ') = ∅` the row is kept).
fn collect_in_scope_variables(gp: &GraphPattern) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    gp.on_in_scope_variable(|v| {
        out.insert(v.as_str().to_string());
    });
    out
}

/// True if the pattern is a plain BGP (no UNION / OPTIONAL / Filter /
/// nested algebra constructs that could produce variable-disjoint
/// solutions). Used by the `MINUS` lowering to reject RHS shapes
/// where the `NOT EXISTS` rewrite is not exact under W3C §18.5.
fn is_single_bgp(gp: &GraphPattern) -> bool {
    matches!(gp, GraphPattern::Bgp { .. })
}

/// True if the expression tree contains an `Expression::Exists` anywhere.
fn expression_contains_exists(expr: &Expression) -> bool {
    match expr {
        Expression::Exists(_) => true,
        Expression::Not(a) | Expression::UnaryPlus(a) | Expression::UnaryMinus(a) => {
            expression_contains_exists(a)
        }
        Expression::And(a, b)
        | Expression::Or(a, b)
        | Expression::Equal(a, b)
        | Expression::SameTerm(a, b)
        | Expression::Greater(a, b)
        | Expression::GreaterOrEqual(a, b)
        | Expression::Less(a, b)
        | Expression::LessOrEqual(a, b)
        | Expression::Add(a, b)
        | Expression::Subtract(a, b)
        | Expression::Multiply(a, b)
        | Expression::Divide(a, b) => {
            expression_contains_exists(a) || expression_contains_exists(b)
        }
        Expression::If(a, b, c) => {
            expression_contains_exists(a)
                || expression_contains_exists(b)
                || expression_contains_exists(c)
        }
        Expression::Coalesce(args) | Expression::FunctionCall(_, args) => {
            args.iter().any(expression_contains_exists)
        }
        Expression::In(a, args) => {
            expression_contains_exists(a) || args.iter().any(expression_contains_exists)
        }
        _ => false,
    }
}

fn true_literal() -> Expression {
    let xsd_boolean =
        NamedNode::new_unchecked("http://www.w3.org/2001/XMLSchema#boolean");
    Expression::Literal(Literal::new_typed_literal("true", xsd_boolean))
}

/// Flatten an inner `GraphPattern` (the `P` in `EXISTS { P }`) into the
/// outer `info`, treating it as a Join. This is the §2 reformulation
/// from `spec/exists.md`: append the inner triples + assertions, unify
/// shared variables with existing outer bindings, and rename inner-only
/// variables to fresh `__exists_*` names so they cannot clash with the
/// outer scope's projection or another EXISTS block's vars.
///
/// **Rejects EXISTS over a UNION outer.** When the outer pattern lowered
/// to `union_branches`, `info.bindings` is empty (UNION's branches each
/// own their bindings) — naive flattening would treat every shared
/// variable as inner-only and silently corrupt the constraint shape
/// (a correlated EXISTS reduces to a global "some matching triple
/// exists somewhere" check). Per-branch EXISTS lowering is the right
/// fix but is out of scope for this spike.
fn flatten_exists_into(
    inner: &GraphPattern,
    info: &mut PatternInfo,
    options: &TransformOptions,
    fresh: &mut FreshSource,
) -> Result<(), String> {
    if info.union_branches.is_some() {
        return Err(
            "EXISTS inside a FILTER over a UNION outer pattern is not yet implemented \
             (round 3 spike). The current lowering has no per-branch binding scope to \
             correlate against. See spec/exists.md §7."
                .into(),
        );
    }

    let inner_info = process_graph_pattern_inner(inner, options, fresh)?;

    // Forbid features in the inner pattern that the spike doesn't yet
    // support. Each of these has a clean follow-up but is out of scope.
    if inner_info.union_branches.is_some() {
        return Err(
            "UNION inside EXISTS is not yet implemented (round 3 spike). \
             See spec/exists.md §7."
                .into(),
        );
    }
    if !inner_info.optional_blocks.is_empty() {
        return Err(
            "OPTIONAL inside EXISTS is not yet implemented (round 3 spike). \
             See spec/exists.md §7."
                .into(),
        );
    }

    let offset = info.patterns.len();

    // Pre-compute the set of variables already bound in the outer info
    // so we can decide whether each inner binding unifies (shared
    // variable → assertion) or is renamed to a fresh hidden inner-only
    // variable.
    let outer_bound: std::collections::BTreeSet<String> = info
        .bindings
        .iter()
        .map(|b| b.variable.clone())
        .collect();

    // Map from original inner variable name to its rewritten name (for
    // inner-only variables). Shared variables aren't in the map — the
    // inner_info's references to them stay as-is and pick up the outer
    // binding via `Term::Variable` lookup at emit time.
    let mut rename: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();
    for b in &inner_info.bindings {
        if !outer_bound.contains(&b.variable) {
            rename.insert(b.variable.clone(), fresh.fresh_exists_var(&b.variable));
        }
    }

    // Rename inner-only variables inside the spargebra TriplePatterns
    // before extending — otherwise `metadata.json` would expose the
    // original local names, allowing downstream metadata-driven
    // matchers to correlate two independent EXISTS blocks that reuse
    // the same source variable name. Subject / predicate / object /
    // graph all carry variable references; each must be rewritten.
    let renamed_patterns: Vec<ContextualizedTriple> = inner_info
        .patterns
        .into_iter()
        .map(|ct| ContextualizedTriple {
            pattern: TriplePattern {
                subject: rename_term_pattern(ct.pattern.subject, &rename),
                predicate: rename_named_node_pattern(ct.pattern.predicate, &rename),
                object: rename_term_pattern(ct.pattern.object, &rename),
            },
            graph: rename_graph_context(ct.graph, &rename),
        })
        .collect();
    info.patterns.extend(renamed_patterns);

    for binding in inner_info.bindings {
        let adjusted_term = match binding.term {
            Term::Input(i, j) => Term::Input(i + offset, j),
            other => other,
        };
        if outer_bound.contains(&binding.variable) {
            // Shared variable — emit a unification assertion against
            // the existing outer binding. The LHS keeps the original
            // name so the existing outer binding is reused.
            info.assertions.push(Assertion(
                Term::Variable(binding.variable),
                adjusted_term,
            ));
        } else {
            // Inner-only variable — rename to a fresh `__exists_*`
            // identifier so it cannot collide with outer-scope or other
            // EXISTS-block names. It stays in `bindings` (for emit-time
            // serialise_term lookup) but is excluded from projection by
            // `process_query`'s `__`-prefix filter (lower.rs ~L785).
            let renamed = rename.get(&binding.variable).expect("rename built above");
            info.bindings.push(Binding {
                variable: renamed.clone(),
                term: adjusted_term,
            });
        }
    }

    for assertion in inner_info.assertions {
        let adj_left = rename_term_in_assertion(assertion.0, &rename, offset);
        let adj_right = rename_term_in_assertion(assertion.1, &rename, offset);
        info.assertions.push(Assertion(adj_left, adj_right));
    }

    // Inner filters keep their semantics, but they may not themselves
    // contain EXISTS in the spike (forbidden via expression_contains_exists).
    for inner_filter in inner_info.filters {
        if expression_contains_exists(&inner_filter) {
            return Err(
                "Nested EXISTS inside an EXISTS-block's FILTER is not yet implemented \
                 (round 3 spike). See spec/exists.md §7."
                    .into(),
            );
        }
        // Filter expressions may reference the inner-only variables we
        // just renamed, so substitute through.
        info.filters.push(rename_variables_in_expression(&inner_filter, &rename));
    }

    Ok(())
}

/// Rename inner-only `TermPattern::Variable` references inside a
/// spargebra `TermPattern`. Other variants pass through unchanged.
fn rename_term_pattern(
    tp: TermPattern,
    rename: &std::collections::BTreeMap<String, String>,
) -> TermPattern {
    if let TermPattern::Variable(v) = &tp {
        if let Some(fresh) = rename.get(v.as_str()) {
            return TermPattern::Variable(Variable::new_unchecked(fresh.clone()));
        }
    }
    tp
}

/// Rename inner-only `NamedNodePattern::Variable` references (predicate
/// position). `NamedNode` arm passes through.
fn rename_named_node_pattern(
    nnp: NamedNodePattern,
    rename: &std::collections::BTreeMap<String, String>,
) -> NamedNodePattern {
    if let NamedNodePattern::Variable(v) = &nnp {
        if let Some(fresh) = rename.get(v.as_str()) {
            return NamedNodePattern::Variable(Variable::new_unchecked(fresh.clone()));
        }
    }
    nnp
}

/// Rename inner-only variable references inside a `GraphContext`. The
/// `Variable` arm is the only case that carries a name; `Default` /
/// `NamedNode` pass through.
fn rename_graph_context(
    graph: GraphContext,
    rename: &std::collections::BTreeMap<String, String>,
) -> GraphContext {
    if let GraphContext::Variable(name) = &graph {
        if let Some(fresh) = rename.get(name) {
            return GraphContext::Variable(fresh.clone());
        }
    }
    graph
}

/// Adjust an inner-pattern `Term` for the outer offset, and rename
/// inner-only `Term::Variable` references to their fresh `__exists_*`
/// names.
fn rename_term_in_assertion(
    term: Term,
    rename: &std::collections::BTreeMap<String, String>,
    offset: usize,
) -> Term {
    match term {
        Term::Input(i, j) => Term::Input(i + offset, j),
        Term::Variable(name) => {
            if let Some(fresh) = rename.get(&name) {
                Term::Variable(fresh.clone())
            } else {
                Term::Variable(name)
            }
        }
        other => other,
    }
}

/// Substitute renamed inner-only variables inside a SPARQL expression.
/// Conservative: only `Expression::Variable` is rewritten; all other
/// shapes recurse structurally. EXISTS / NOT EXISTS expressions inside
/// `expr` are left untouched here — `flatten_exists_into` already
/// rejects them via `expression_contains_exists`.
fn rename_variables_in_expression(
    expr: &Expression,
    rename: &std::collections::BTreeMap<String, String>,
) -> Expression {
    use Expression::{
        Add, And, Bound as BoundE, Coalesce, Divide, Equal, FunctionCall, Greater,
        GreaterOrEqual, If, In, Less, LessOrEqual, Multiply, Not, Or, SameTerm, Subtract,
        UnaryMinus, UnaryPlus, Variable as VariableE,
    };
    match expr {
        VariableE(v) => {
            if let Some(fresh) = rename.get(v.as_str()) {
                VariableE(Variable::new_unchecked(fresh.clone()))
            } else {
                expr.clone()
            }
        }
        BoundE(v) => {
            if let Some(fresh) = rename.get(v.as_str()) {
                BoundE(Variable::new_unchecked(fresh.clone()))
            } else {
                expr.clone()
            }
        }
        Or(a, b) => Or(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        And(a, b) => And(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        Equal(a, b) => Equal(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        SameTerm(a, b) => SameTerm(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        Greater(a, b) => Greater(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        GreaterOrEqual(a, b) => GreaterOrEqual(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        Less(a, b) => Less(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        LessOrEqual(a, b) => LessOrEqual(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        Add(a, b) => Add(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        Subtract(a, b) => Subtract(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        Multiply(a, b) => Multiply(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        Divide(a, b) => Divide(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
        ),
        UnaryPlus(a) => UnaryPlus(Box::new(rename_variables_in_expression(a, rename))),
        UnaryMinus(a) => UnaryMinus(Box::new(rename_variables_in_expression(a, rename))),
        Not(a) => Not(Box::new(rename_variables_in_expression(a, rename))),
        If(a, b, c) => If(
            Box::new(rename_variables_in_expression(a, rename)),
            Box::new(rename_variables_in_expression(b, rename)),
            Box::new(rename_variables_in_expression(c, rename)),
        ),
        In(a, args) => In(
            Box::new(rename_variables_in_expression(a, rename)),
            args.iter()
                .map(|e| rename_variables_in_expression(e, rename))
                .collect(),
        ),
        Coalesce(args) => Coalesce(
            args.iter()
                .map(|e| rename_variables_in_expression(e, rename))
                .collect(),
        ),
        FunctionCall(f, args) => FunctionCall(
            f.clone(),
            args.iter()
                .map(|e| rename_variables_in_expression(e, rename))
                .collect(),
        ),
        // Leaf: literal / named node / Exists (rejected upstream).
        _ => expr.clone(),
    }
}

/// Build the pattern that represents the zero-step branch of `p?` /
/// `p*` — i.e. `subject = object`. Per SPARQL 1.1 §18.5 a
/// zero-length path matches whenever the two endpoints are the same
/// term (and, in the standard, that term appears in the dataset; the
/// inclusion-proof witness handles dataset-membership separately).
/// Encoding by case:
///
/// - `?s = ?o` (variable-variable): emit `BIND(?o AS ?s)` so the
///   subject variable is constrained to equal the object.
/// - `?s = <iri>` / `<iri> = ?o`: emit `BIND(<iri> AS ?v)` for the
///   variable side.
/// - `<iri> = <iri>` (ground equal): emit `Bgp { patterns: [] }` —
///   the trivially-satisfied branch.
/// - `<iri1> = <iri2>` (ground unequal): emit a `FILTER(false)`
///   guard so the branch is unsatisfiable. Empty BGPs are treated
///   as `false` in UNION emission, but that conflates "no
///   constraint" with "unsatisfiable"; the explicit `FILTER` is
///   unambiguous and matches the §18.5 semantics for unequal
///   ground endpoints.
fn zero_step_pattern(
    subject: &TermPattern,
    object: &TermPattern,
) -> Result<GraphPattern, String> {
    use spargebra::term::Literal;
    let false_lit = Literal::new_typed_literal(
        "false",
        spargebra::term::NamedNode::new_unchecked(
            "http://www.w3.org/2001/XMLSchema#boolean",
        ),
    );
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
        // Ground equal — trivially satisfied. Emit `FILTER(true)` so
        // the union branch carries a non-empty assertion list (an
        // empty list would emit as `false` per `emit::union_branches`).
        let true_lit = Literal::new_typed_literal(
            "true",
            spargebra::term::NamedNode::new_unchecked(
                "http://www.w3.org/2001/XMLSchema#boolean",
            ),
        );
        GraphPattern::Filter {
            expr: Expression::Literal(true_lit),
            inner: Box::new(GraphPattern::Bgp { patterns: vec![] }),
        }
    } else {
        // Ground unequal — branch is unsatisfiable. Wrap an empty BGP
        // in `FILTER(false)` so emit treats it as a failing branch
        // explicitly rather than relying on the empty-branch fallback.
        GraphPattern::Filter {
            expr: Expression::Literal(false_lit),
            inner: Box::new(GraphPattern::Bgp { patterns: vec![] }),
        }
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
    fresh: &mut FreshSource,
) -> Result<GraphPattern, String> {
    if min > max {
        return Err(format!(
            "internal: kleene_unroll min ({}) > max ({})",
            min, max
        ));
    }
    let mut acc: Option<GraphPattern> = None;
    for depth in min..=max {
        let chain = build_chain(subject, inner, object, depth, options, fresh)?;
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
    fresh: &mut FreshSource,
) -> Result<GraphPattern, String> {
    if depth == 0 {
        return zero_step_pattern(subject, object);
    }
    if depth == 1 {
        return expand_normalised_path(subject, inner, object, options, fresh);
    }
    // depth >= 2: subject -inner- mid_1 -inner- mid_2 ... -inner- object
    let mut prev_term = subject.clone();
    let mut acc: Option<GraphPattern> = None;
    for step in 0..depth {
        let next_term = if step == depth - 1 {
            object.clone()
        } else {
            fresh.fresh_variable()
        };
        let leg = expand_normalised_path(&prev_term, inner, &next_term, options, fresh)?;
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
    fresh: &mut FreshSource,
) -> Result<GraphPattern, String> {
    let pred_var = fresh.fresh_pred();
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

/// True iff the right-hand side of a `LeftJoin` (i.e. the inner
/// pattern of an OPTIONAL block) qualifies for the round-3-follow-up
/// **easy-case collapse** — single-triple inner with every variable
/// position outer-bound, no inner FILTER / nested OPTIONAL / UNION /
/// EXISTS / NOT-EXISTS, no outer LeftJoin filter expression, no
/// non-default graph context with a free graph variable.
///
/// **Soundness rationale.** Under these conditions the inner triple,
/// after substituting the outer μ, is fully ground — every position is
/// a concrete term (a constant or a value the outer scope already
/// witnessed). The OPTIONAL therefore becomes the boolean disjunction
/// "the ground inner triple is in the dataset OR it is not" with no
/// inner-only variables to bind, so the projected solution multiset is
/// identical regardless of which arm the prover witnesses. The emit
/// layer encodes both arms as `assert(matched | unmatched)` and
/// soundness reduces to the existing matched-arm inclusion check
/// (Merkle-binding) and the existing unmatched-arm
/// `verify_non_membership` primitive (`spec/exists.md` §3.3).
///
/// Anything that violates these conditions falls through to the
/// existing `2^n` power-set generation path — defaulting to the safe
/// pre-collapse behaviour. The classifier is **conservative**: false
/// negatives cost a power-set variant; false positives would corrupt
/// soundness.
fn optional_inner_is_easy_case(
    right_info: &PatternInfo,
    expression: &Option<Expression>,
    left_info: &PatternInfo,
) -> bool {
    // The outer `LeftJoin` may carry a FILTER expression
    // (`OPTIONAL { … FILTER(…) }` is hoisted there by spargebra). The
    // easy case forbids it: any non-trivial filter would constrain the
    // matched arm beyond a simple inclusion check, breaking the
    // "matched ↔ inclusion of the substituted ground triple"
    // equivalence the soundness argument relies on.
    if expression.is_some() {
        return false;
    }
    // No inner FILTER (same reason).
    if !right_info.filters.is_empty() {
        return false;
    }
    // No UNION / nested OPTIONAL / NOT EXISTS / inner easy-case
    // OPTIONAL inside the OPTIONAL we're classifying.
    if right_info.union_branches.is_some()
        || !right_info.optional_blocks.is_empty()
        || !right_info.not_exists.is_empty()
        || !right_info.easy_optionals.is_empty()
    {
        return false;
    }
    // Single-triple inner. Multi-triple is round-4 (prefix-tree
    // commitments).
    if right_info.patterns.len() != 1 {
        return false;
    }
    // Every variable position in the inner triple must be outer-bound.
    // `right_info.bindings` lists the variables that `process_patterns`
    // saw as fresh-to-this-BGP — i.e. exactly the variables in the
    // inner triple (they appear once each). For the easy case to fire,
    // every such variable must already be bound by the outer μ
    // (`left_info.bindings`).
    let outer_bound: std::collections::BTreeSet<&str> = left_info
        .bindings
        .iter()
        .map(|b| b.variable.as_str())
        .collect();
    for binding in &right_info.bindings {
        if !outer_bound.contains(binding.variable.as_str()) {
            return false;
        }
    }
    // No graph variable that isn't outer-bound either. The graph
    // context lives on the `ContextualizedTriple` and is folded into
    // the `inner_terms` array; if it's a `Variable(name)` that the
    // outer hasn't seen, we'd be substituting a free variable. The
    // outer-bound check above covers `right_info.bindings`, but a
    // graph variable doesn't go through that path — we have to check
    // the pattern's graph context directly.
    let pattern = &right_info.patterns[0];
    if let GraphContext::Variable(name) = &pattern.graph {
        if !outer_bound.contains(name.as_str()) {
            return false;
        }
    }
    true
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
    let mut fresh = FreshSource::default();
    process_graph_pattern_inner(gp, &TransformOptions::default(), &mut fresh)
}

pub(crate) fn process_graph_pattern_with_options(
    gp: &GraphPattern,
    options: &TransformOptions,
) -> Result<PatternInfo, String> {
    let mut fresh = FreshSource::default();
    process_graph_pattern_inner(gp, options, &mut fresh)
}

fn process_graph_pattern_inner(
    gp: &GraphPattern,
    options: &TransformOptions,
    fresh: &mut FreshSource,
) -> Result<PatternInfo, String> {
    match gp {
        GraphPattern::Bgp { patterns } => process_patterns(patterns),

        GraphPattern::Path { subject, path, object } => {
            let expanded = expand_path(subject, path, object, options, fresh)?;
            process_graph_pattern_inner(&expanded, options, fresh)
        }

        GraphPattern::Join { left, right } => {
            let left_info = process_graph_pattern_inner(left, options, fresh)?;
            let right_info = process_graph_pattern_inner(right, options, fresh)?;
            join_pattern_infos(left_info, right_info)
        }

        GraphPattern::Filter { expr, inner } => {
            let mut info = process_graph_pattern_inner(inner, options, fresh)?;
            // EXISTS / NOT EXISTS — round 3 spike (see spec/exists.md).
            //
            // `FILTER(EXISTS { P })` flattens the inner pattern P into the
            // outer BGP via the witness-supplied compatibility reformulation:
            // each inner triple becomes an additional `Triple` in the outer
            // `bgp`, with full Merkle inclusion + signature checking; the
            // EXISTS expression itself collapses to `true`. Inner-only
            // variables become hidden bindings that are not exposed in
            // `Variables`.
            //
            // `FILTER(NOT EXISTS { P })` lowers (round-3 main event) to a
            // `NonExistenceConstraint` against the sorted-Merkle commitment
            // — see `spec/exists.md` §3.3.
            let rewritten_expr =
                lower_exists_in_expression(expr, &mut info, options, fresh)?;
            info.filters.push(rewritten_expr);
            Ok(info)
        }

        // `Minus(Po, Pi)` — W3C SPARQL 1.1 §18.5. The W3C definition is
        //   `{ μ ∈ ⟦Po⟧ | ∀ μ' ∈ ⟦Pi⟧ : μ ≁ μ' ∨ dom(μ) ∩ dom(μ') = ∅ }`
        // i.e. MINUS only excludes rows whose μ' is compatible AND
        // shares at least one variable with μ. When **every** μ'
        // produced by the RHS necessarily binds at least one
        // outer-shared variable, the rewrite to
        // `Filter(NOT EXISTS { Pi }, Po)` is exact. When some μ' may
        // be variable-disjoint (RHS contains UNION / OPTIONAL with a
        // disjoint-variables branch), the rewrite would remove rows
        // W3C strictly keeps.
        //
        // Round-3 main event handles two cases conservatively:
        //
        //   1. RHS in-scope variables disjoint from LHS → MINUS is a
        //      W3C no-op; lower as the outer alone.
        //   2. RHS is a single BGP (no UNION / OPTIONAL) with at
        //      least one shared variable → the rewrite is exact;
        //      reuse the NOT-EXISTS lowering.
        //   3. Anything else (RHS contains UNION / OPTIONAL etc.) →
        //      rejected with a pointer to round-4 follow-up.
        //
        // Roborev findings 2026-05-03 (medium): the unconditional
        // rewrite mishandled the disjoint case (case 1) and the
        // partially-disjoint UNION-RHS case (case 3).
        GraphPattern::Minus { left, right } => {
            let left_vars = collect_in_scope_variables(left);
            let right_vars = collect_in_scope_variables(right);
            let shared = left_vars.intersection(&right_vars).count();
            if shared == 0 {
                return process_graph_pattern_inner(left, options, fresh);
            }
            if !is_single_bgp(right) {
                return Err(
                    "MINUS with a UNION / OPTIONAL / non-BGP RHS is not yet implemented. \
                     The Filter(NOT EXISTS { Pi }, Po) rewrite is only exact when every \
                     μ' produced by Pi necessarily binds at least one outer-shared \
                     variable; UNION / OPTIONAL branches can violate this. Round-4 \
                     follow-up — see spec/exists.md §7."
                        .into(),
                );
            }
            let outer = GraphPattern::Filter {
                expr: Expression::Not(Box::new(Expression::Exists(right.clone()))),
                inner: left.clone(),
            };
            process_graph_pattern_inner(&outer, options, fresh)
        }

        GraphPattern::Extend { inner, variable, expression } => {
            let mut info = process_graph_pattern_inner(inner, options, fresh)?;
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
            let mut left_info = process_graph_pattern_inner(left, options, fresh)?;
            let right_info = process_graph_pattern_inner(right, options, fresh)?;

            // NOT EXISTS / MINUS / EXISTS inside an OPTIONAL (right-
            // side of a LeftJoin) is not yet supported. The
            // OptionalBlock IR doesn't carry non-membership
            // constraints, and the power-set variant emitter doesn't
            // know how to lower EXISTS / NOT-EXISTS inside the
            // OPTIONAL's filter expression either. Round-4 follow-up
            // — same family of constraints as the deferred OPTIONAL-
            // collapse work in
            // `questions/optional-collapse-pattern-non-membership.md`.
            if !right_info.not_exists.is_empty() {
                return Err(
                    "NOT EXISTS / MINUS inside an OPTIONAL inner pattern is not yet \
                     implemented. The branch-local non-membership constraints would be \
                     silently dropped by the variant emitter. Round-4 follow-up — see \
                     spec/exists.md §7."
                        .into(),
                );
            }
            // The OPTIONAL's outer filter expression (if any) lives
            // alongside `right_info.filters` and must be EXISTS-free —
            // spargebra's `OPTIONAL { … FILTER(…) }` normalisation
            // hoists the filter into the LeftJoin's `expression`, so
            // we check it here too.
            if let Some(expr) = expression {
                if expression_contains_exists(expr) {
                    return Err(
                        "EXISTS / NOT EXISTS inside an OPTIONAL filter expression is not yet \
                         implemented. Round-4 follow-up — see spec/exists.md §7."
                            .into(),
                    );
                }
            }
            for f in &right_info.filters {
                if expression_contains_exists(f) {
                    return Err(
                        "EXISTS / NOT EXISTS inside an OPTIONAL inner pattern's FILTER is not \
                         yet implemented. Round-4 follow-up — see spec/exists.md §7."
                            .into(),
                    );
                }
            }

            let offset = left_info.patterns.len();

            // Tiered partial OPTIONAL collapse — easy case
            // (round 3 follow-up; see `spec/exists.md` §4.1).
            //
            // The easy case is: a single-triple inner pattern with
            // every variable position bound by the outer μ. After
            // substitution the inner triple is fully ground, so the
            // OPTIONAL is a boolean disjunction — the matched arm
            // proves the substituted triple is in the dataset; the
            // unmatched arm proves it is not. Both arms preserve the
            // outer row's projected bindings unchanged (no inner-only
            // variables to bind).
            //
            // When the easy case fires we lower the OPTIONAL to a
            // single `EasyOptional` and skip the power-set path; the
            // `optional_circuits[]` array is unaffected, so multiple
            // easy-case OPTIONALs in the same query do *not*
            // contribute to the `2^n` variant explosion.
            if optional_inner_is_easy_case(&right_info, expression, &left_info) {
                let inner_pattern = &right_info.patterns[0];
                let inner_terms = absent_terms_from_pattern(inner_pattern)?;

                // Three appended BGP slots: a free placeholder for
                // the matched arm followed by the two unmatched-arm
                // bracket leaves. All three are inclusion-checked by
                // `main.nr` regardless of which arm the prover
                // actually witnesses — soundness lives in the
                // `assert(matched | unmatched)` disjunction the emit
                // layer produces.
                //
                // **All three slots are free placeholders** (not the
                // concrete inner triple). This is load-bearing: the
                // prover-side binding resolver iterates every
                // `inputPatterns[i]` and matches it against the
                // dataset. If we left a concrete pattern at the
                // matched slot, the resolver would fail to produce a
                // witness when the inner triple is *not* in the
                // dataset (the unmatched case) — the very case the
                // collapse is supposed to support. Free placeholders
                // let the prover pick any valid leaf for each slot;
                // the matched-arm position assertions in
                // `checkBinding` then evaluate to true iff the
                // prover happened to bind the matched slot to the
                // substituted ground inner triple, which is only
                // possible when that triple really is in the dataset
                // — Merkle binding does the soundness work.
                //
                // Roborev finding 2026-05-03 (high) on the first
                // round-3-follow-up commit: "easy-OPTIONAL slots
                // appear as required input patterns".
                let matched_idx = offset;
                let bracket_left_idx = offset + 1;
                let bracket_right_idx = offset + 2;

                left_info
                    .patterns
                    .push(bracket_placeholder_pattern(&inner_pattern.graph));
                left_info
                    .patterns
                    .push(bracket_placeholder_pattern(&inner_pattern.graph));
                left_info
                    .patterns
                    .push(bracket_placeholder_pattern(&inner_pattern.graph));

                left_info.easy_optionals.push(EasyOptional {
                    id: next_optional_id(),
                    matched_idx,
                    bracket_left_idx,
                    bracket_right_idx,
                    inner_terms,
                });
                return Ok(left_info);
            }

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
                fresh: &mut FreshSource,
            ) -> Result<(), String> {
                match gp {
                    GraphPattern::Union { left, right } => {
                        collect_branches(left, out, options, fresh)?;
                        collect_branches(right, out, options, fresh)?;
                    }
                    _ => {
                        out.push(process_graph_pattern_inner(gp, options, fresh)?);
                    }
                }
                Ok(())
            }

            let mut branches: Vec<PatternInfo> = Vec::new();
            collect_branches(left, &mut branches, options, fresh)?;
            collect_branches(right, &mut branches, options, fresh)?;

            // NOT EXISTS / MINUS inside a UNION branch is not yet
            // supported. The branch-local `not_exists` entries reference
            // BGP slots in the branch's own index space, but the emit
            // layer's branch handler doesn't currently emit them
            // (verify_non_membership_no_inclusion's asserts can't be
            // composed inside the per-branch `branch_X = (...) & (...)`
            // boolean form). Round-4 follow-up — see roborev finding
            // 2026-05-03 (high).
            for branch in &branches {
                if !branch.not_exists.is_empty() {
                    return Err(
                        "NOT EXISTS / MINUS inside a UNION branch is not yet implemented. \
                         The branch-local non-membership constraints would be silently dropped \
                         by the emit layer. Round-4 follow-up — see spec/exists.md §7."
                            .into(),
                    );
                }
            }

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
                not_exists: Vec::new(),
                easy_optionals: Vec::new(),
            })
        }

        GraphPattern::Graph { name, inner } => {
            let mut info = process_graph_pattern_inner(inner, options, fresh)?;

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
        GraphPattern::Distinct { inner } => process_graph_pattern_inner(inner, options, fresh),
        GraphPattern::Reduced { inner } => process_graph_pattern_inner(inner, options, fresh),
        GraphPattern::OrderBy { inner, .. } => {
            process_graph_pattern_inner(inner, options, fresh)
        }
        GraphPattern::Slice { inner, .. } => process_graph_pattern_inner(inner, options, fresh),

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
        // ASK queries do not have PROJECT — project all bound
        // variables, except those with `__`-prefix (blank-node
        // internals and `__exists_*` inner-only EXISTS witnesses,
        // which must never appear in the disclosed projection).
        _ => {
            let pattern = process_graph_pattern_with_options(inner, options)?;
            // Filter out `__`-prefix names: blank-node internals and
            // `__exists_*` inner-only EXISTS witnesses must never
            // appear in the disclosed projection (round 3 spike;
            // mirrors the SELECT-with-aggregates fallback).
            let mut vars: Vec<String> = pattern
                .bindings
                .iter()
                .map(|b| b.variable.clone())
                .filter(|v| !v.starts_with("__"))
                .collect();
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
