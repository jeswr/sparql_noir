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

/// True if any part of the pattern tree carries a `NonExistenceConstraint`.
/// The lowering currently rejects NOT EXISTS inside UNION branches and
/// OPTIONAL right-sides (per round-3 scope), so in practice only the
/// top-level `pat.not_exists` matters; the recursive walk is a
/// defence-in-depth check should those rejections ever loosen without
/// an emit-side update. Used by the skip-signing guard.
fn pattern_has_not_exists(pat: &PatternInfo) -> bool {
    if !pat.not_exists.is_empty() {
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
) -> Result<(String, Vec<serde_json::Value>, bool, bool, bool), String> {
    let mut combined = PatternInfo {
        patterns: base_info.pattern.patterns.clone(),
        bindings: base_info.pattern.bindings.clone(),
        assertions: base_info.pattern.assertions.clone(),
        filters: base_info.pattern.filters.clone(),
        union_branches: base_info.pattern.union_branches.clone(),
        optional_blocks: Vec::new(),
        not_exists: base_info.pattern.not_exists.clone(),
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
/// Returns (sparql_nr content, hidden inputs, has_hidden, needs_xpath,
/// has_not_exists). `has_not_exists` lets the caller pull in the sentinel
/// inclusion calls + boundary-cases public input in `main.nr`.
pub(crate) fn generate_sparql_nr_from_query_info(
    info: &QueryInfo,
    options: &TransformOptions,
) -> Result<(String, Vec<serde_json::Value>, bool, bool, bool), String> {
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
                branch_asserts.push(format!(
                    "{} == {}",
                    serialize_term(&left, info, &branch_bindings),
                    serialize_term(&b.term, info, &branch_bindings)
                ));
            }

            for Assertion(l, r) in &branch.assertions {
                branch_asserts.push(format!(
                    "{} == {}",
                    serialize_term(l, info, &branch_bindings),
                    serialize_term(r, info, &branch_bindings)
                ));
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
            assertions.push(format!(
                "{} == {}",
                serialize_term(&left, info, &binding_map),
                serialize_term(&b.term, info, &binding_map)
            ));
        }

        for Assertion(l, r) in &info.pattern.assertions {
            assertions.push(format!(
                "{} == {}",
                serialize_term(l, info, &binding_map),
                serialize_term(r, info, &binding_map)
            ));
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

    let mut sparql_nr = String::new();
    sparql_nr.push_str("// Generated by sparql_noir transform\n");
    sparql_nr.push_str("use dep::consts;\n");
    if options.skip_signing {
        sparql_nr.push_str("use super::Triple;\n");
    } else {
        sparql_nr.push_str("use dep::utils;\n");
        sparql_nr.push_str("use dep::types::Triple;\n");
        if has_not_exists {
            sparql_nr.push_str("use dep::types::SentinelLeaf;\n");
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

    let mut params = String::from("bgp: BGP, variables: Variables");
    if has_hidden {
        params.push_str(", hidden: Hidden");
    }
    if has_not_exists {
        params.push_str(", low_sentinel: SentinelLeaf, high_sentinel: SentinelLeaf, boundary_cases: BoundaryCases");
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
    sparql_nr.push_str("}\n");

    Ok((sparql_nr, hidden, has_hidden, needs_xpath, has_not_exists))
}

/// Substitute the `{{h0}}` / `{{h1}}` / `{{h2}}` (Hidden inputs) and
/// `{{n0}}` / `{{n1}}` / `{{n2}}` / `{{n3}}` (NOT EXISTS / sentinel
/// scaffolding) placeholders in the embedded `main.nr` template. The
/// signed and skip-signing variants share placeholder syntax, so this
/// works for both -- though `{{n*}}` placeholders only appear in the
/// signed template (skip-signing rejects NOT EXISTS upstream).
pub(crate) fn fill_main_nr_template(
    skip_signing: bool,
    has_hidden: bool,
    has_not_exists: bool,
    num_not_exists: usize,
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
        // num_not_exists is consumed by the debug_assert above; the
        // circuit's BoundaryCases-array length comes from the
        // generated `noir/sparql/src/lib.nr` `pub type BoundaryCases =
        // [u8; N]` declaration, which the metadata writer keeps in
        // sync with this count.
    } else {
        main_nr = main_nr
            .replace("{{n0}}", "")
            .replace("{{n1}}", "")
            .replace("{{n2}}", "")
            .replace("{{n3}}", "")
            .replace("{{n4}}", "");
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
