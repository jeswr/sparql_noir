//! Final code emission — `sparql.nr`, `main.nr`, and `Nargo.toml`.
//!
//! Consumes a [`QueryInfo`] (post-lowering) and produces the strings that
//! the CLI / WASM bindings write to disk. Owns:
//!
//! - The embedded `main.nr` templates (signed and skip-signing variants).
//! - `generate_sparql_nr_from_query_info` — the per-circuit emitter.
//! - `collect_all_optional_blocks` — flattens nested OPTIONALs.
//! - `generate_circuit_for_optional_combination` — power-set variant
//!   builder over the matched-OPTIONAL bit-mask.
//! - `fill_main_nr_template` and `build_nargo_toml` — small template
//!   substitution helpers.

use std::collections::BTreeMap;

use crate::expr::{filter_to_noir, serialize_term};
use crate::{Assertion, OptionalBlock, PatternInfo, QueryInfo, Term, TransformOptions};

const MAIN_TEMPLATE: &str = include_str!("../template/main-verify.template.nr");
const MAIN_TEMPLATE_SIMPLE: &str = include_str!("../template/main-simple.template.nr");

/// What the per-circuit emitter returns. Carries the `sparql.nr`
/// content alongside flags / sizes the `lib.rs` orchestration layer
/// needs to fill the `main.nr` template (sentinel scaffolding, prefix-3
/// public inputs, etc.).
pub(crate) struct EmitResult {
    pub sparql_nr: String,
    pub hidden: Vec<serde_json::Value>,
    pub has_hidden: bool,
    pub needs_xpath: bool,
    pub has_not_exists: bool,
    /// Round-5 prefix-3 commitment is in use (any prefix-3 NOT EXISTS
    /// or any prefix-3 OPTIONAL collapse).
    pub has_prefix3: bool,
    /// Total number of `bgp_prefix3` slots required.
    pub bgp_prefix3_len: usize,
    /// Total number of prefix-3 boundary-case dispatch tags
    /// (`BoundaryCasesPrefix3` length).
    pub num_prefix3_dispatches: usize,
}

/// True if any part of the pattern tree carries a non-membership
/// obligation — `NonExistenceConstraint` (NOT EXISTS / MINUS),
/// `PrefixNonExistenceConstraint` (round-5 prefix-tree NOT EXISTS), or
/// `EasyOptional` (collapsed-OPTIONAL unmatched arm). All three depend
/// on a sorted-Merkle commitment that skip-signing mode bypasses, so
/// any of them disqualifies a query from running in skip-signing mode.
///
/// The lowering currently rejects NOT EXISTS inside UNION branches and
/// OPTIONAL right-sides (per round-3 scope), so in practice only the
/// top-level constraints matter; the recursive walk is a defence-in-
/// depth check should those rejections ever loosen without an
/// emit-side update.
fn pattern_has_not_exists(pat: &PatternInfo) -> bool {
    if !pat.not_exists.is_empty()
        || !pat.prefix_not_exists.is_empty()
        || !pat.easy_optionals.is_empty()
    {
        return true;
    }
    if let Some(branches) = &pat.union_branches {
        for b in branches {
            if pattern_has_not_exists(b) {
                return true;
            }
        }
    }
    false
}

/// True iff the query exercises the round-4/5 prefix-3 commitment --
/// any prefix-3 NOT EXISTS or any prefix-3 OPTIONAL collapse. Pulls in
/// the `roots[1]` / `low_sentinel_3` / `high_sentinel_3` / `bgp_prefix3`
/// scaffolding in `main.nr` and the `BoundaryCasesPrefix3` public input.
fn pattern_uses_prefix3(pat: &PatternInfo) -> bool {
    if !pat.prefix_not_exists.is_empty() {
        return true;
    }
    for eo in &pat.easy_optionals {
        if matches!(eo.prefix_kind, Some(crate::ir::PrefixKind::Prefix3SpG)) {
            return true;
        }
    }
    false
}

/// Total number of prefix-3 BGP slots required by `pat` -- two per
/// prefix-3 NOT EXISTS constraint and two per prefix-3 OPTIONAL
/// collapse. Drives the size of the `bgp_prefix3` array in `main.nr`
/// and the `BoundaryCasesPrefix3` length.
fn prefix3_slot_count(pat: &PatternInfo) -> usize {
    pat.bgp_prefix3_len
}

/// Number of independent prefix-3 boundary-case dispatches the
/// generated circuit emits -- one per `PrefixNonExistenceConstraint`.
/// Prefix-3 OPTIONAL collapses use a per-EO three-arm dispatch in the
/// boolean disjunction and have their own `boundary_cases_prefix3`
/// slot allocated separately (see emit logic below).
fn prefix3_constraint_count(pat: &PatternInfo) -> usize {
    let mut n = pat.prefix_not_exists.len();
    for eo in &pat.easy_optionals {
        if matches!(eo.prefix_kind, Some(crate::ir::PrefixKind::Prefix3SpG)) {
            n += 1;
        }
    }
    n
}

/// Recursively collect all optional blocks from a pattern, flattening nested optionals.
pub(crate) fn collect_all_optional_blocks(optionals: &[OptionalBlock]) -> Vec<OptionalBlock> {
    let mut result = Vec::new();
    for opt in optionals {
        result.push(OptionalBlock {
            id: opt.id,
            patterns: opt.patterns.clone(),
            bindings: opt.bindings.clone(),
            assertions: opt.assertions.clone(),
            filters: opt.filters.clone(),
            nested_optionals: Vec::new(),
        });
        result.extend(collect_all_optional_blocks(&opt.nested_optionals));
    }
    result
}

/// Generate the sparql.nr content for a specific optional combination.
///
/// Builds a synthetic `QueryInfo` with the base patterns plus the matched
/// optional patterns, then re-uses [`generate_sparql_nr_from_query_info`]
/// to emit the circuit.
pub(crate) fn generate_circuit_for_optional_combination(
    base_info: &QueryInfo,
    all_optionals: &[OptionalBlock],
    matched_indices: &[usize],
    options: &TransformOptions,
) -> Result<EmitResult, String> {
    let mut combined = PatternInfo {
        patterns: base_info.pattern.patterns.clone(),
        bindings: base_info.pattern.bindings.clone(),
        assertions: base_info.pattern.assertions.clone(),
        filters: base_info.pattern.filters.clone(),
        union_branches: base_info.pattern.union_branches.clone(),
        optional_blocks: Vec::new(),
        not_exists: base_info.pattern.not_exists.clone(),
        prefix_not_exists: base_info.pattern.prefix_not_exists.clone(),
        bgp_prefix3_len: base_info.pattern.bgp_prefix3_len,
        easy_optionals: base_info.pattern.easy_optionals.clone(),
    };

    let mut optional_only_vars: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for (idx, opt) in all_optionals.iter().enumerate() {
        if !matched_indices.contains(&idx) {
            for b in &opt.bindings {
                optional_only_vars.insert(b.variable.clone());
            }
        }
    }

    for b in &base_info.pattern.bindings {
        optional_only_vars.remove(&b.variable);
    }
    for &idx in matched_indices {
        if idx < all_optionals.len() {
            let opt = &all_optionals[idx];
            for b in &opt.bindings {
                optional_only_vars.remove(&b.variable);
            }
        }
    }

    for &idx in matched_indices {
        if idx < all_optionals.len() {
            let opt = &all_optionals[idx];
            combined.patterns.extend(opt.patterns.clone());
            combined.bindings.extend(opt.bindings.clone());
            combined.assertions.extend(opt.assertions.clone());
            combined.filters.extend(opt.filters.clone());
        }
    }

    let filtered_variables: Vec<String> = base_info
        .variables
        .iter()
        .filter(|v| !optional_only_vars.contains(*v))
        .cloned()
        .collect();

    // Variant circuits inherit the base query's aggregate / ordering
    // metadata — these are post-processing concerns that don't change
    // per OPTIONAL combination.
    let combo_info = QueryInfo {
        variables: filtered_variables,
        pattern: combined,
        aggregates: base_info.aggregates.clone(),
        order_by: base_info.order_by.clone(),
        limit: base_info.limit,
        offset: base_info.offset,
    };

    generate_sparql_nr_from_query_info(&combo_info, options)
}

/// Generate sparql.nr content from a `QueryInfo`.
/// Returns an `EmitResult` carrying the rendered file plus the flags
/// the orchestrator needs to fill the `main.nr` template (sentinel
/// scaffolding, prefix-3 public inputs, etc.).
pub(crate) fn generate_sparql_nr_from_query_info(
    info: &QueryInfo,
    options: &TransformOptions,
) -> Result<EmitResult, String> {
    if options.skip_signing && pattern_has_not_exists(&info.pattern) {
        return Err(
            "NOT EXISTS / MINUS / collapsed-OPTIONAL queries cannot run in skip-signing mode \
             — non-membership soundness depends on the sorted Merkle commitment, which is \
             absent when signing is skipped."
                .into(),
        );
    }
    let mut binding_map: BTreeMap<String, Term> = BTreeMap::new();
    for b in &info.pattern.bindings {
        if !info.variables.contains(&b.variable) && !binding_map.contains_key(&b.variable) {
            binding_map.insert(b.variable.clone(), b.term.clone());
        }
    }

    let mut assertions: Vec<String> = Vec::new();
    let mut union_assertions: Vec<Vec<String>> = Vec::new();
    let mut hidden: Vec<serde_json::Value> = Vec::new();

    if let Some(branches) = &info.pattern.union_branches {
        for branch in branches {
            let mut branch_bindings = binding_map.clone();
            for b in &branch.bindings {
                if !info.variables.contains(&b.variable)
                    && !branch_bindings.contains_key(&b.variable)
                {
                    branch_bindings.insert(b.variable.clone(), b.term.clone());
                }
            }

            let mut branch_asserts: Vec<String> = Vec::new();

            for b in &branch.bindings {
                let left = Term::Variable(b.variable.clone());
                let l = serialize_term(&left, info, &branch_bindings);
                let r = serialize_term(&b.term, info, &branch_bindings);
                // Same tautology guard as the non-union branch below.
                if l == r {
                    continue;
                }
                branch_asserts.push(format!("{} == {}", l, r));
            }

            for Assertion(l_term, r_term) in &branch.assertions {
                let l = serialize_term(l_term, info, &branch_bindings);
                let r = serialize_term(r_term, info, &branch_bindings);
                if l == r {
                    continue;
                }
                branch_asserts.push(format!("{} == {}", l, r));
            }

            for f in &branch.filters {
                let expr = filter_to_noir(f, info, &branch_bindings, &mut hidden)?;
                branch_asserts.push(expr);
            }

            union_assertions.push(branch_asserts);
        }
    } else {
        for b in &info.pattern.bindings {
            let left = Term::Variable(b.variable.clone());
            let l = serialize_term(&left, info, &binding_map);
            let r = serialize_term(&b.term, info, &binding_map);
            // Both sides resolve to the same `bgp[i].terms[j]` slot when the
            // variable is not projected and is bound by the same triple
            // position (e.g. ASK queries with no projected variables). The
            // assertion is then a tautology — skip it. Per
            // https://github.com/jeswr/sparql_noir/pull/50#discussion-r3178804193
            if l == r {
                continue;
            }
            assertions.push(format!("{} == {}", l, r));
        }

        for Assertion(l_term, r_term) in &info.pattern.assertions {
            let l = serialize_term(l_term, info, &binding_map);
            let r = serialize_term(r_term, info, &binding_map);
            // Same tautology guard as the binding loop above.
            if l == r {
                continue;
            }
            assertions.push(format!("{} == {}", l, r));
        }

        for f in &info.pattern.filters {
            let expr = filter_to_noir(f, info, &binding_map, &mut hidden)?;
            assertions.push(expr);
        }
    }

    // Non-existence constraints (NOT EXISTS / MINUS / unmatched-arm of
    // collapsed OPTIONAL — see spec/exists.md §3.3, §6.4). Each emits a
    // **runtime-dispatched** call to one of the
    // `utils::verify_non_membership_*_no_inclusion` primitives, gated
    // on the public per-constraint `boundary_cases[i]` Field:
    //
    //   0 = Lower (low sentinel + smallest real leaf as bracket)
    //   1 = Middle (two real leaves bracket)
    //   2 = Upper (largest real leaf + high sentinel as bracket)
    //
    // The signer's sorted Merkle commitment carries both sentinel
    // inclusion paths (`low_sentinel`, `high_sentinel`); `main.nr`
    // runs `verify_low_sentinel_inclusion` /
    // `verify_high_sentinel_inclusion` once each before
    // `checkBinding`. The sentinel parameters thread into checkBinding
    // so each constraint can dispatch independently.
    //
    // Bracket leaves at `bgp[bracket_left_idx]` /
    // `bgp[bracket_right_idx]` are inclusion-checked by the generic
    // per-triple loop in `main.nr`. In Lower mode the left bracket is
    // a prover-supplied dummy (still inclusion-checked, but its hash
    // doesn't enter the dispatch); same for the right bracket in Upper.
    //
    // Soundness: the strict-`<` and adjacency assertions inside the
    // selected primitive enforce non-membership against the genuine
    // bracket pair. A prover lying about `boundary_cases[i]` cannot
    // satisfy the chosen primitive's constraints unless the live
    // bracketing relationship matches the claimed case.
    let mut not_exists_calls: Vec<String> = Vec::new();
    for (i, ne) in info.pattern.not_exists.iter().enumerate() {
        let absent = format!(
            "consts::hash4([{}, {}, {}, {}])",
            serialize_term(&ne.absent_terms[0], info, &binding_map),
            serialize_term(&ne.absent_terms[1], info, &binding_map),
            serialize_term(&ne.absent_terms[2], info, &binding_map),
            serialize_term(&ne.absent_terms[3], info, &binding_map),
        );
        // Runtime dispatch on the public `boundary_cases[i]` tag. Noir
        // compiles all three branches but only the assertions inside
        // the matching branch fire (per Noir's conditional-assert
        // semantics — see spec/exists.md §3.3 for the soundness note).
        let dispatch = format!(
            "let absent_{idx} = {absent};\n\
             \x20 if boundary_cases[{idx}] == 0 {{\n\
             \x20   utils::verify_non_membership_low_sentinel_no_inclusion(low_sentinel, bgp[{right}], absent_{idx});\n\
             \x20 }} else if boundary_cases[{idx}] == 1 {{\n\
             \x20   utils::verify_non_membership_no_inclusion(bgp[{left}], bgp[{right}], absent_{idx});\n\
             \x20 }} else if boundary_cases[{idx}] == 2 {{\n\
             \x20   utils::verify_non_membership_high_sentinel_no_inclusion(bgp[{left}], high_sentinel, absent_{idx});\n\
             \x20 }} else {{\n\
             \x20   assert(false, \"non-membership: boundary_cases[{idx}] must be 0 (Lower), 1 (Middle), or 2 (Upper)\");\n\
             \x20 }}",
            idx = i,
            absent = absent,
            left = ne.bracket_left_idx,
            right = ne.bracket_right_idx,
        );
        not_exists_calls.push(dispatch);
    }

    let num_not_exists = info.pattern.not_exists.len();
    let has_not_exists = num_not_exists > 0;

    // Round-5 prefix-3 NOT EXISTS dispatches
    // (`spec/prefix-tree-commitment.md` Sec.8). Same three-arm
    // boundary-case dispatch as round-3, but indexed against
    // `bgp_prefix3` and `roots[1]` instead of `bgp` and `roots[0]`.
    // The `boundary_cases_prefix3[i]` public input picks the arm.
    let mut prefix_not_exists_calls: Vec<String> = Vec::new();
    for (i, pne) in info.pattern.prefix_not_exists.iter().enumerate() {
        let crate::ir::PrefixKind::Prefix3SpG = pne.prefix_kind;
        let positions = pne.prefix_kind.fixed_positions();
        let absent = format!(
            "utils::prefix3::hash3_sp_g({}, {}, {})",
            serialize_term(&pne.absent_terms[positions[0]], info, &binding_map),
            serialize_term(&pne.absent_terms[positions[1]], info, &binding_map),
            serialize_term(&pne.absent_terms[positions[2]], info, &binding_map),
        );
        let dispatch = format!(
            "let absent_prefix_{idx} = {absent};\n\
             \x20 if boundary_cases_prefix3[{idx}] == 0 {{\n\
             \x20   utils::prefix3::verify_non_membership_prefix3_low_sentinel_no_inclusion(low_sentinel_3, bgp_prefix3[{right}], absent_prefix_{idx});\n\
             \x20 }} else if boundary_cases_prefix3[{idx}] == 1 {{\n\
             \x20   utils::prefix3::verify_non_membership_prefix3_no_inclusion(bgp_prefix3[{left}], bgp_prefix3[{right}], absent_prefix_{idx});\n\
             \x20 }} else if boundary_cases_prefix3[{idx}] == 2 {{\n\
             \x20   utils::prefix3::verify_non_membership_prefix3_high_sentinel_no_inclusion(bgp_prefix3[{left}], high_sentinel_3, absent_prefix_{idx});\n\
             \x20 }} else {{\n\
             \x20   assert(false, \"non-membership prefix3: boundary_cases_prefix3[{idx}] must be 0 (Lower), 1 (Middle), or 2 (Upper)\");\n\
             \x20 }}",
            idx = i,
            absent = absent,
            left = pne.bracket_left_idx,
            right = pne.bracket_right_idx,
        );
        prefix_not_exists_calls.push(dispatch);
    }

    let num_prefix3_not_exists = info.pattern.prefix_not_exists.len();

    // Easy-case OPTIONAL disjunctions (round 3 follow-up — see
    // `spec/exists.md` §4.1; round-5 prefix-3 extension --
    // `spec/prefix-tree-commitment.md` Sec.8). Each `EasyOptional`
    // emits one `assert(matched | unmatched)` line: the matched arm
    // asserts that the substituted ground inner triple lives at
    // `bgp[matched_idx]` (skipping the inner-only position for
    // prefix-tree collapses); the unmatched arm calls the boolean
    // variant of `verify_non_membership` over the bracket leaves
    // (round-3 against `bgp`/`roots[0]`, prefix-3 against
    // `bgp_prefix3`/`roots[1]`). Both arms keep the projected
    // solution set unchanged because the inner-only variable, when
    // present, is never projected.
    let mut easy_optional_lines: Vec<String> = Vec::new();
    // Track how many prefix-3 EasyOptional dispatches we've emitted so
    // far -- they share `boundary_cases_prefix3[]` with
    // `prefix_not_exists`, allocated AFTER all NOT EXISTS dispatches.
    let mut prefix3_eo_idx = num_prefix3_not_exists;
    for eo in &info.pattern.easy_optionals {
        // Matched arm: per-position equalities pinning each of the
        // four `bgp[matched_idx].terms[j]` slots to the substituted
        // inner term. For prefix-3 collapses, the inner-only position
        // is unconstrained -- the matched arm doesn't pin it.
        let free_position = eo
            .prefix_kind
            .map(|k| k.free_position())
            .unwrap_or(usize::MAX);
        let matched_clauses: Vec<String> = (0..4)
            .filter(|j| *j != free_position)
            .map(|j| {
                // Project through `.hash`: the bounded byte-array
                // witness redesign makes each term slot a
                // `TermWitness { hash, bytes, length }` and BGP
                // equality only ever needs the term's identity. See
                // `spec/encoding.md` sec.6.6 for the rationale.
                format!(
                    "({} == bgp[{}].terms[{}].hash)",
                    serialize_term(&eo.inner_terms[j], info, &binding_map),
                    eo.matched_idx,
                    j
                )
            })
            .collect();
        let matched_arm = matched_clauses.join(" & ");

        // Unmatched arm: dispatch on `prefix_kind`.
        let unmatched_arm = match eo.prefix_kind {
            None => {
                let absent = format!(
                    "consts::hash4([{}, {}, {}, {}])",
                    serialize_term(&eo.inner_terms[0], info, &binding_map),
                    serialize_term(&eo.inner_terms[1], info, &binding_map),
                    serialize_term(&eo.inner_terms[2], info, &binding_map),
                    serialize_term(&eo.inner_terms[3], info, &binding_map),
                );
                format!(
                    "utils::verify_non_membership_no_inclusion_check(bgp[{}], bgp[{}], {})",
                    eo.bracket_left_idx, eo.bracket_right_idx, absent
                )
            }
            Some(crate::ir::PrefixKind::Prefix3SpG) => {
                let positions = crate::ir::PrefixKind::Prefix3SpG.fixed_positions();
                let absent = format!(
                    "utils::prefix3::hash3_sp_g({}, {}, {})",
                    serialize_term(&eo.inner_terms[positions[0]], info, &binding_map),
                    serialize_term(&eo.inner_terms[positions[1]], info, &binding_map),
                    serialize_term(&eo.inner_terms[positions[2]], info, &binding_map),
                );
                // Three boundary-case arms folded into a single
                // boolean expression: the prover supplies
                // `boundary_cases_prefix3[i]` (i = next slot after
                // all NOT EXISTS dispatches) and the matching arm
                // returns `true` iff the bracketing holds. The
                // out-of-range tag returns `false` so the
                // disjunction with the matched arm enforces validity.
                let arm = format!(
                    "((boundary_cases_prefix3[{idx}] == 0) & utils::prefix3::verify_non_membership_prefix3_low_sentinel_no_inclusion_check(low_sentinel_3, bgp_prefix3[{right}], {absent})) \
                     | ((boundary_cases_prefix3[{idx}] == 1) & utils::prefix3::verify_non_membership_prefix3_no_inclusion_check(bgp_prefix3[{left}], bgp_prefix3[{right}], {absent})) \
                     | ((boundary_cases_prefix3[{idx}] == 2) & utils::prefix3::verify_non_membership_prefix3_high_sentinel_no_inclusion_check(bgp_prefix3[{left}], high_sentinel_3, {absent}))",
                    idx = prefix3_eo_idx,
                    left = eo.bracket_left_idx,
                    right = eo.bracket_right_idx,
                    absent = absent,
                );
                prefix3_eo_idx += 1;
                arm
            }
        };

        easy_optional_lines.push(format!("({}) | ({})", matched_arm, unmatched_arm));
    }

    let total_prefix3_constraints = prefix3_eo_idx;
    let has_prefix3 = pattern_uses_prefix3(&info.pattern);
    let bgp_prefix3_len = prefix3_slot_count(&info.pattern);
    debug_assert_eq!(
        total_prefix3_constraints,
        prefix3_constraint_count(&info.pattern),
        "emit / IR disagree on prefix-3 dispatch count"
    );

    let mut sparql_nr = String::new();
    sparql_nr.push_str("// Generated by sparql_noir transform\n");
    sparql_nr.push_str("use dep::consts;\n");
    if options.skip_signing {
        sparql_nr.push_str("use super::Triple;\n");
    } else {
        sparql_nr.push_str("use dep::utils;\n");
        sparql_nr.push_str("use dep::types::Triple;\n");
        if has_not_exists || has_prefix3 {
            sparql_nr.push_str("use dep::types::SentinelLeaf;\n");
        }
        if has_prefix3 {
            sparql_nr.push_str("use dep::types::PrefixTriple3;\n");
        }
    }

    let needs_ebv = hidden.iter().any(|h| {
        h.get("computedType")
            .and_then(|v| v.as_str())
            .map(|t| t == "ebv_value" || t == "ebv_datatype")
            .unwrap_or(false)
    });
    if needs_ebv {
        sparql_nr.push_str("use dep::ebv;\n");
    }

    let needs_xpath = assertions.iter().any(|a| a.contains("xpath::"))
        || union_assertions
            .iter()
            .any(|branch| branch.iter().any(|a| a.contains("xpath::")));
    if needs_xpath {
        sparql_nr.push_str("use dep::xpath;\n");
    }

    sparql_nr.push_str("\n");
    sparql_nr.push_str(&format!(
        "pub(crate) type BGP = [Triple; {}];\n",
        info.pattern.patterns.len()
    ));

    sparql_nr.push_str("pub(crate) struct Variables {\n");
    for v in &info.variables {
        sparql_nr.push_str(&format!("  pub(crate) {}: Field,\n", v));
    }
    sparql_nr.push_str("}\n\n");

    let has_hidden = !hidden.is_empty();
    if has_hidden {
        sparql_nr.push_str(&format!(
            "pub(crate) type Hidden = [Field; {}];\n",
            hidden.len()
        ));
    }
    if has_not_exists {
        // The public `BoundaryCases` array encodes which
        // `verify_non_membership_*_no_inclusion` primitive fires for
        // each NOT EXISTS / MINUS constraint. The verifier sees the
        // tag (it's a public input) so a bad tag fails verification
        // rather than silently going through; a tag that doesn't match
        // the live bracketing relationship fails the chosen primitive's
        // strict-`<` / adjacency assertions inside `checkBinding`.
        sparql_nr.push_str(&format!(
            "pub(crate) type BoundaryCases = [Field; {}];\n",
            num_not_exists
        ));
    }
    if has_prefix3 {
        // Round-5 prefix-3 type aliases. `BgpPrefix3` is the parallel
        // slot array for prefix-tree bracket leaves (two per
        // PrefixNonExistenceConstraint, two per prefix-3 EasyOptional).
        // `BoundaryCasesPrefix3` is the per-dispatch tag array, one
        // entry per prefix-3 NOT EXISTS dispatch followed by one per
        // prefix-3 OPTIONAL collapse.
        sparql_nr.push_str(&format!(
            "pub(crate) type BgpPrefix3 = [PrefixTriple3; {}];\n",
            bgp_prefix3_len
        ));
        sparql_nr.push_str(&format!(
            "pub(crate) type BoundaryCasesPrefix3 = [Field; {}];\n",
            total_prefix3_constraints
        ));
    }

    let mut params = String::from("bgp: BGP, variables: Variables");
    if has_hidden {
        params.push_str(", hidden: Hidden");
    }
    if has_not_exists {
        params.push_str(", low_sentinel: SentinelLeaf, high_sentinel: SentinelLeaf, boundary_cases: BoundaryCases");
    }
    if has_prefix3 {
        params.push_str(", bgp_prefix3: BgpPrefix3, low_sentinel_3: SentinelLeaf, high_sentinel_3: SentinelLeaf, boundary_cases_prefix3: BoundaryCasesPrefix3");
    }
    sparql_nr.push_str(&format!(
        "pub(crate) fn checkBinding({}) {{\n",
        params
    ));

    if !union_assertions.is_empty() {
        for (idx, branch) in union_assertions.iter().enumerate() {
            let expr = if branch.is_empty() {
                "false".to_string()
            } else {
                branch
                    .iter()
                    .map(|s| format!("({})", s))
                    .collect::<Vec<_>>()
                    .join(" & ")
            };
            sparql_nr.push_str(&format!("  let branch_{} = {};\n", idx, expr));
        }
        let ors = (0..union_assertions.len())
            .map(|i| format!("branch_{}", i))
            .collect::<Vec<_>>()
            .join(" | ");
        sparql_nr.push_str(&format!("  assert({});\n", ors));
    } else {
        for a in &assertions {
            sparql_nr.push_str(&format!("  assert({});\n", a));
        }
    }
    for call in &not_exists_calls {
        sparql_nr.push_str(&format!("  {};\n", call));
    }
    for call in &prefix_not_exists_calls {
        sparql_nr.push_str(&format!("  {};\n", call));
    }
    for line in &easy_optional_lines {
        sparql_nr.push_str(&format!("  assert({});\n", line));
    }
    sparql_nr.push_str("}\n");

    Ok(EmitResult {
        sparql_nr,
        hidden,
        has_hidden,
        needs_xpath,
        has_not_exists,
        has_prefix3,
        bgp_prefix3_len,
        num_prefix3_dispatches: total_prefix3_constraints,
    })
}

/// Substitute the `{{h0}}` / `{{h1}}` / `{{h2}}` (Hidden inputs),
/// `{{n0}}` / `{{n1}}` / `{{n2}}` / `{{n3}}` / `{{n4}}` (NOT EXISTS /
/// round-3 sentinel scaffolding), and `{{p0}}` / `{{p1}}` / `{{p2}}` /
/// `{{p3}}` / `{{p4}}` (round-5 prefix-3 scaffolding) placeholders in
/// the embedded `main.nr` template. The signed and skip-signing
/// variants share placeholder syntax; `{{n*}}` / `{{p*}}` placeholders
/// only appear in the signed template (skip-signing rejects
/// non-membership upstream).
pub(crate) fn fill_main_nr_template(
    skip_signing: bool,
    has_hidden: bool,
    has_not_exists: bool,
    num_not_exists: usize,
    has_prefix3: bool,
    bgp_prefix3_len: usize,
    num_prefix3_dispatches: usize,
) -> String {
    // Consistency check: `has_not_exists` is the boolean view of
    // `num_not_exists > 0`. A mismatch means a caller has thrown the
    // two sources out of sync upstream — fail loudly rather than emit
    // a circuit whose `BoundaryCases` array length disagrees with the
    // dispatch chain.
    debug_assert_eq!(
        has_not_exists,
        num_not_exists > 0,
        "fill_main_nr_template: has_not_exists ({}) disagrees with num_not_exists ({})",
        has_not_exists,
        num_not_exists,
    );
    debug_assert_eq!(
        has_prefix3,
        bgp_prefix3_len > 0 || num_prefix3_dispatches > 0,
        "fill_main_nr_template: has_prefix3 ({}) disagrees with bgp_prefix3_len ({}) / num_prefix3_dispatches ({})",
        has_prefix3,
        bgp_prefix3_len,
        num_prefix3_dispatches,
    );
    let template = if skip_signing {
        MAIN_TEMPLATE_SIMPLE
    } else {
        MAIN_TEMPLATE
    };
    let mut main_nr = template.to_string();
    if has_hidden {
        main_nr = main_nr
            .replace("{{h0}}", ", Hidden")
            .replace("{{h1}}", ",\n    hidden: Hidden")
            .replace("{{h2}}", ", hidden");
    } else {
        main_nr = main_nr
            .replace("{{h0}}", "")
            .replace("{{h1}}", "")
            .replace("{{h2}}", "");
    }
    if has_not_exists {
        // Sentinel + boundary-cases scaffolding for NOT EXISTS / MINUS.
        // The signer's sorted Merkle commitment carries permanent low /
        // high sentinels (see `noir/lib/utils/src/lib.nr::merkle`), and
        // their inclusion paths are pre-computed by the signer. The
        // verifier sees `boundary_cases` as a public input so a malicious
        // prover cannot silently switch which dispatch arm fires.
        main_nr = main_nr
            .replace("{{n0}}", ", BoundaryCases")
            .replace(
                "{{n1}}",
                ",\n    low_sentinel: SentinelLeaf,\n    high_sentinel: SentinelLeaf,\n    boundary_cases: pub BoundaryCases",
            )
            .replace(
                "{{n2}}",
                "use dep::types::SentinelLeaf;\n\
                 use dep::utils::{verify_low_sentinel_inclusion, verify_high_sentinel_inclusion};\n\n",
            )
            .replace(
                "{{n3}}",
                "    // Sentinel inclusion -- dataset-wide brackets that make the\n\
                     \x20   // boundary cases of `verify_non_membership_*_no_inclusion`\n\
                     \x20   // witnessable. See `spec/exists.md` Sec.3.3.\n\
                     \x20   verify_low_sentinel_inclusion(low_sentinel, roots[0].value);\n\
                     \x20   verify_high_sentinel_inclusion(high_sentinel, roots[0].value);\n\n",
            )
            .replace(
                "{{n4}}",
                ", low_sentinel, high_sentinel, boundary_cases",
            );
    } else {
        main_nr = main_nr
            .replace("{{n0}}", "")
            .replace("{{n1}}", "")
            .replace("{{n2}}", "")
            .replace("{{n3}}", "")
            .replace("{{n4}}", "");
    }
    if has_prefix3 {
        // Round-5 prefix-3 commitment scaffolding -- two-root signer
        // ABI. `roots[1]` is the prefix-3 sorted Merkle root,
        // committed alongside `roots[0]` (leaf-hash sorted) by the
        // signer. The prover supplies `low_sentinel_3` /
        // `high_sentinel_3` / `bgp_prefix3` and the per-dispatch
        // `boundary_cases_prefix3` tag. See
        // `spec/prefix-tree-commitment.md` Sec.8.
        //
        // The `SentinelLeaf` type and sentinel inclusion functions are
        // imported by `{{n2}}` when round-3 NOT EXISTS is also present;
        // otherwise we add a `prefix3-only` import block here so the
        // generated `main.nr` compiles even when only the round-5
        // dispatch fires.
        let prefix3_only_imports = if has_not_exists {
            // Already imported by the round-3 sentinel block.
            "use dep::utils::prefix3::verify_inclusion_prefix3;\n"
        } else {
            "use dep::types::SentinelLeaf;\n\
             use dep::utils::{verify_low_sentinel_inclusion, verify_high_sentinel_inclusion};\n\
             use dep::utils::prefix3::verify_inclusion_prefix3;\n\n"
        };
        main_nr = main_nr
            .replace("{{p0}}", ", BgpPrefix3, BoundaryCasesPrefix3")
            .replace(
                "{{p1}}",
                ",\n    bgp_prefix3: BgpPrefix3,\n    low_sentinel_3: SentinelLeaf,\n    high_sentinel_3: SentinelLeaf,\n    boundary_cases_prefix3: pub BoundaryCasesPrefix3",
            )
            .replace("{{p2}}", prefix3_only_imports)
            .replace(
                "{{p3}}",
                "    // Prefix-3 sorted-tree sentinel inclusion + bracket\n\
                     \x20   // inclusion checks against `roots[1]`. See\n\
                     \x20   // `spec/prefix-tree-commitment.md` Sec.8.\n\
                     \x20   verify_low_sentinel_inclusion(low_sentinel_3, roots[1].value);\n\
                     \x20   verify_high_sentinel_inclusion(high_sentinel_3, roots[1].value);\n\
                     \x20   for ptriple in bgp_prefix3 {\n\
                     \x20       verify_inclusion_prefix3(ptriple, roots[1].value);\n\
                     \x20   }\n\n",
            )
            .replace(
                "{{p4}}",
                ", bgp_prefix3, low_sentinel_3, high_sentinel_3, boundary_cases_prefix3",
            )
            .replace("{{r0}}", "Root; 2")
            .replace("{{r1}}", "0..2");
    } else {
        main_nr = main_nr
            .replace("{{p0}}", "")
            .replace("{{p1}}", "")
            .replace("{{p2}}", "")
            .replace("{{p3}}", "")
            .replace("{{p4}}", "")
            .replace("{{r0}}", "Root; 1")
            .replace("{{r1}}", "0..1");
    }
    main_nr
}

/// Render `Nargo.toml` for the generated package, conditionally pulling in
/// `ebv` / `xpath` / `types` / `utils` based on which features the circuit
/// actually exercises.
pub(crate) fn build_nargo_toml(skip_signing: bool, needs_ebv: bool, needs_xpath: bool) -> String {
    let mut toml = if skip_signing {
        r#"[package]
name = "sparql_proof"
type = "bin"
authors = [""]

[dependencies]
consts = { path = "../noir/lib/consts" }
"#
        .to_string()
    } else {
        r#"[package]
name = "sparql_proof"
type = "bin"
authors = [""]

[dependencies]
consts = { path = "../noir/lib/consts" }
types = { path = "../noir/lib/types" }
utils = { path = "../noir/lib/utils" }
"#
        .to_string()
    };
    if needs_ebv {
        toml.push_str("ebv = { path = \"../noir/lib/ebv\" }\n");
    }
    if needs_xpath {
        toml.push_str("xpath = { path = \"../noir/lib/xpath\" }\n");
    }
    toml
}
