//! Behaviour-preservation snapshot tests for `transform_query`.
//!
//! Each query in [`CORPUS`] is transformed and the resulting `sparql.nr`,
//! `main.nr`, `Nargo.toml`, and serialised metadata are byte-compared
//! against fixtures in `tests/snapshots/`. The corpus is hand-curated to
//! exercise the major code-paths — BGP, filter comparison/inequality,
//! function calls, OPTIONAL, UNION, BIND, GRAPH, property paths, XSD
//! casting, post-processing modifiers, ASK, blank nodes, and EBV.
//!
//! Run `UPDATE_SNAPSHOTS=1 cargo test --test snapshot` to regenerate the
//! fixtures after an intentional behavioural change.

use std::env;
use std::fs;
use std::path::PathBuf;

use transform::{transform_query, transform_with_opts, TransformOptions};

struct Case {
    name: &'static str,
    query: &'static str,
}

const CORPUS: &[Case] = &[
    Case {
        name: "basic_bgp",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?p ?o WHERE { ?s ?p ?o . }",
    },
    Case {
        name: "static_predicate",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:knows ?o . }",
    },
    Case {
        name: "filter_inequality",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:knows ?o . FILTER(?s != ?o) }",
    },
    Case {
        name: "filter_comparison",
        query: "PREFIX ex: <http://example.org/>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\nSELECT ?s ?o WHERE { ?s ex:knows ?o . FILTER(?s != ?o) FILTER(?o > \"3\"^^xsd:integer) }",
    },
    Case {
        name: "filter_bound",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { ?s ex:knows ?o . FILTER(BOUND(?s)) }",
    },
    Case {
        name: "filter_isiri",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { ?s ex:knows ?o . FILTER(isIRI(?o)) }",
    },
    Case {
        name: "filter_lang",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { ?s ex:label ?o . FILTER(LANG(?o) = \"en\") }",
    },
    Case {
        name: "filter_str_eq",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { ?s ex:label ?o . FILTER(STR(?o) = \"hi\") }",
    },
    Case {
        name: "filter_and_or",
        query: "PREFIX ex: <http://example.org/>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\nSELECT ?s ?o WHERE { ?s ex:age ?o . FILTER((?o > \"18\"^^xsd:integer) && (?o < \"30\"^^xsd:integer)) }",
    },
    Case {
        name: "filter_float_const",
        query: "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\nSELECT ?s WHERE { ?s ?p ?o . FILTER(\"1.5\"^^xsd:float < \"2.0\"^^xsd:float) }",
    },
    Case {
        name: "optional_basic",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:knows ?p . OPTIONAL { ?p ex:age ?o . } }",
    },
    // Round-3 follow-up — tiered partial OPTIONAL collapse (easy
    // case). The inner triple `?s ex:type ex:Person` has every
    // variable position outer-bound (`?s`) and constant positions
    // (`ex:type`, `ex:Person`); after substitution it is fully
    // ground. The OPTIONAL therefore collapses to a single
    // `assert(matched | unmatched)` line — no power-set generation,
    // no `optional_circuits[]` entry. See `spec/exists.md` §4.1.
    Case {
        name: "optional_easy_collapse",
        query: "PREFIX ex: <http://example.org/>\n\
                SELECT ?s ?o WHERE { ?s ex:knows ?o . OPTIONAL { ?s ex:type ex:Person . } }",
    },
    Case {
        name: "union_basic",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { { ?s ex:a ?o . } UNION { ?s ex:b ?o . } }",
    },
    Case {
        name: "bind_basic",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?x WHERE { ?s ex:knows ?o . BIND(?o AS ?x) }",
    },
    Case {
        name: "graph_named",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { GRAPH <http://example.org/g1> { ?s ex:p ?o . } }",
    },
    Case {
        name: "graph_var",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?g WHERE { GRAPH ?g { ?s ex:p ?o . } }",
    },
    // Note: ex:a/ex:b sequence-paths are excluded from the corpus because
    // spargebra emits a freshly-randomised blank node identifier for the
    // join intermediate, which makes the metadata non-snapshot-stable.
    // ex:a|ex:b (alternative) and ex:a? (zero-or-one) are deterministic.
    Case {
        name: "path_alt",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:a|ex:b ?o . }",
    },
    Case {
        name: "path_zero_or_one",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:a? ?o . }",
    },
    Case {
        name: "filter_year",
        query: "PREFIX ex: <http://example.org/>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\nSELECT ?s WHERE { ?s ex:date ?d . FILTER(YEAR(?d) > \"2020\"^^xsd:integer) }",
    },
    Case {
        name: "xsd_cast",
        query: "PREFIX ex: <http://example.org/>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\nSELECT ?s WHERE { ?s ex:age ?o . FILTER(xsd:integer(?o) > \"18\"^^xsd:integer) }",
    },
    Case {
        name: "distinct_modifier",
        query: "PREFIX ex: <http://example.org/>\nSELECT DISTINCT ?s WHERE { ?s ex:knows ?o . }",
    },
    Case {
        name: "ask_query",
        query: "PREFIX ex: <http://example.org/>\nASK WHERE { ?s ex:knows ?o . }",
    },
    Case {
        name: "literal_value",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { ?s ex:label \"hello\" . }",
    },
    Case {
        name: "blank_node",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { ?s ex:knows _:b . _:b ex:age ?a . }",
    },
    Case {
        name: "ebv_filter",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { ?s ex:flag ?f . FILTER(?f) }",
    },
    Case {
        name: "filter_samelang",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { ?s ex:p ?o . FILTER(LANGMATCHES(LANG(?o), \"en\")) }",
    },
    Case {
        name: "filter_abs",
        query: "PREFIX ex: <http://example.org/>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\nSELECT ?s WHERE { ?s ex:n ?n . FILTER(ABS(?n) > \"5\"^^xsd:integer) }",
    },
    Case {
        name: "double_optional",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?a ?b WHERE { ?s ex:p ?o . OPTIONAL { ?s ex:a ?a . } OPTIONAL { ?s ex:b ?b . } }",
    },
    // Aggregates via the disclose-and-verify pattern (SPARQL_ROADMAP.md
    // §8.6, Q6 decision 2026-05-03). The circuit body for each of these
    // is identical to the underlying SELECT — the aggregate kind is
    // metadata only.
    Case {
        name: "count",
        query: "PREFIX ex: <http://example.org/>\nSELECT (COUNT(?s) AS ?n) WHERE { ?s ex:knows ?o . }",
    },
    Case {
        name: "count_distinct",
        query: "PREFIX ex: <http://example.org/>\nSELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s ex:knows ?o . }",
    },
    Case {
        name: "count_star",
        query: "PREFIX ex: <http://example.org/>\nSELECT (COUNT(*) AS ?n) WHERE { ?s ex:knows ?o . }",
    },
    Case {
        name: "sum",
        query: "PREFIX ex: <http://example.org/>\nSELECT (SUM(?o) AS ?total) WHERE { ?s ex:age ?o . }",
    },
    Case {
        name: "min",
        query: "PREFIX ex: <http://example.org/>\nSELECT (MIN(?o) AS ?lowest) WHERE { ?s ex:age ?o . }",
    },
    Case {
        name: "max",
        query: "PREFIX ex: <http://example.org/>\nSELECT (MAX(?o) AS ?highest) WHERE { ?s ex:age ?o . }",
    },
    Case {
        name: "avg",
        query: "PREFIX ex: <http://example.org/>\nSELECT (AVG(?o) AS ?mean) WHERE { ?s ex:age ?o . }",
    },
    Case {
        name: "order_by",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:knows ?o . } ORDER BY ?s",
    },
    Case {
        name: "order_by_desc",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:knows ?o . } ORDER BY DESC(?s)",
    },
    Case {
        name: "limit",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { ?s ex:knows ?o . } LIMIT 10",
    },
    Case {
        name: "limit_offset",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s WHERE { ?s ex:knows ?o . } LIMIT 10 OFFSET 5",
    },
    // Round 2 §7 — Kleene `+` / `*`, NPS `!p`, FILTER arithmetic.
    Case {
        name: "path_one_or_more",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:knows+ ?o . }",
    },
    Case {
        name: "path_zero_or_more",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:knows* ?o . }",
    },
    Case {
        name: "path_nps_single",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s !ex:knows ?o . }",
    },
    Case {
        name: "path_nps_set",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s !(ex:a|ex:b|ex:c) ?o . }",
    },
    Case {
        name: "path_reverse_nps",
        // `^!ex:knows` — exercises `normalise_path`'s push-down for
        // `Reverse(NegatedPropertySet(_))` (single triple with subject /
        // object swapped, plus the inequality filter).
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ^!ex:knows ?o . }",
    },
    Case {
        name: "path_one_or_more_reverse",
        // `^(ex:knows+)` ≡ `(^ex:knows)+` — exercises Kleene over a
        // reversed leaf, validating `^(p+)` → `(^p)+`.
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ^(ex:knows+) ?o . }",
    },
    Case {
        name: "filter_arith_add",
        // `?a + ?b > 5` — wires xpath::numeric_add_int via expr.rs.
        query: "PREFIX ex: <http://example.org/>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\nSELECT ?s WHERE { ?s ex:a ?a . ?s ex:b ?b . FILTER(?a + ?b > \"5\"^^xsd:integer) }",
    },
    Case {
        name: "filter_arith_mul_div",
        query: "PREFIX ex: <http://example.org/>\nPREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\nSELECT ?s WHERE { ?s ex:n ?n . FILTER((?n * \"2\"^^xsd:integer) / \"3\"^^xsd:integer > \"4\"^^xsd:integer) }",
    },
    // Round 2 §7 — UNION-distribution under Join. The sibling
    // `?s ex:flag ?x` triple must propagate into every branch of the
    // `+` path's UNION (regression for roborev #332 high finding).
    Case {
        name: "kleene_join_sibling",
        query: "PREFIX ex: <http://example.org/>\nSELECT ?s ?o ?x WHERE { ?s ex:flag ?x . ?s ex:knows+ ?o . }",
    },
    // EXISTS — round 3 spike (see spec/exists.md). The inner pattern
    // `?o ex:age ?age` flattens into the outer BGP via the
    // witness-supplied compatibility reformulation: the second triple
    // is an ordinary `Triple` with full inclusion + signature checking;
    // ?age is an inner-only variable and is not projected.
    Case {
        name: "exists_basic",
        query: "PREFIX ex: <http://example.org/>\n\
                SELECT ?s WHERE { ?s ex:knows ?o . FILTER(EXISTS { ?o ex:age ?age . }) }",
    },
    // EXISTS with a fully ground inner pattern — every inner-position
    // is fixed by the outer mapping. Smallest possible inner BGP cost
    // (single-triple inclusion proof + 3 unification assertions).
    Case {
        name: "exists_grounded",
        query: "PREFIX ex: <http://example.org/>\n\
                SELECT ?s WHERE { ?s ex:knows ?o . FILTER(EXISTS { ?s ex:type ex:Person . }) }",
    },
    // EXISTS with an inner-only **predicate** variable. Verifies the
    // rename pass covers `NamedNodePattern::Variable` so metadata
    // does not expose the original local name `?p`.
    Case {
        name: "exists_var_predicate",
        query: "PREFIX ex: <http://example.org/>\n\
                SELECT ?s WHERE { ?s ex:knows ?o . FILTER(EXISTS { ?o ?p \"hello\" . }) }",
    },
    // NOT EXISTS — round 3 main event (see spec/exists.md §3.3, §4).
    // Single-triple ground-inner: every inner position is fixed by
    // outer μ or constant. Lowers to a NonExistenceConstraint with
    // two bracket-leaf BGP slots and a verify_non_membership call.
    Case {
        name: "not_exists_grounded",
        query: "PREFIX ex: <http://example.org/>\n\
                SELECT ?s WHERE { ?s ex:knows ?o . FILTER(NOT EXISTS { ?s ex:type ex:Person . }) }",
    },
    // NOT EXISTS with the absent-triple's object position taken from
    // the outer scope (?o). Validates that absent_terms threads
    // outer-bound variables through to the absent-hash computation.
    Case {
        name: "not_exists_outer_var",
        query: "PREFIX ex: <http://example.org/>\n\
                SELECT ?s ?o WHERE { ?s ex:knows ?o . FILTER(NOT EXISTS { ?s ex:hates ?o . }) }",
    },
    // MINUS — round 3 main event (see spec/exists.md §6 / W3C §18.5).
    // `MINUS { Po } { Pi }` lowers to `Filter(NOT EXISTS { Pi }, Po)`.
    // Same NonExistenceConstraint shape as the corresponding NOT EXISTS.
    Case {
        name: "minus_basic",
        query: "PREFIX ex: <http://example.org/>\n\
                SELECT ?s ?o WHERE { ?s ex:knows ?o . MINUS { ?s ex:hates ?o . } }",
    },
];

/// Round 2 §7 — defensive cap on OPTIONAL blocks. The transform must
/// reject queries with more than `optional_cap` OPTIONAL blocks rather
/// than silently generating `2^n` circuit variants.
#[test]
fn rejects_too_many_optionals() {
    let q = "PREFIX ex: <http://example.org/>
SELECT ?s ?a ?b ?c ?d ?e WHERE {
  ?s ex:p ?o .
  OPTIONAL { ?s ex:a ?a }
  OPTIONAL { ?s ex:b ?b }
  OPTIONAL { ?s ex:c ?c }
  OPTIONAL { ?s ex:d ?d }
  OPTIONAL { ?s ex:e ?e }
}";
    let err = match transform_query(q) {
        Err(e) => e,
        Ok(_) => panic!("expected OPTIONAL-cap rejection"),
    };
    assert!(
        err.contains("OPTIONAL") && err.contains("cap"),
        "error should mention OPTIONAL cap, got: {err}"
    );
}

/// Bumping the cap must permit the same query through.
#[test]
fn raises_optional_cap() {
    let q = "PREFIX ex: <http://example.org/>
SELECT ?s ?a ?b ?c ?d ?e WHERE {
  ?s ex:p ?o .
  OPTIONAL { ?s ex:a ?a }
  OPTIONAL { ?s ex:b ?b }
  OPTIONAL { ?s ex:c ?c }
  OPTIONAL { ?s ex:d ?d }
  OPTIONAL { ?s ex:e ?e }
}";
    let opts = TransformOptions {
        optional_cap: 8,
        ..TransformOptions::default()
    };
    transform_with_opts(q, opts).expect("should succeed with raised cap");
}

/// `+` paths past `path_segment_max` must still work — but past the
/// configured bound only the first `max` depths are explored.
#[test]
fn kleene_path_segment_max_configurable() {
    let q = "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:knows+ ?o . }";
    // depth = 1 ⇒ a single triple, no UNION
    let opts = TransformOptions {
        path_segment_max: 1,
        ..TransformOptions::default()
    };
    let r = transform_with_opts(q, opts).expect("transform with depth 1");
    assert!(
        !r.sparql_nr.contains("branch_"),
        "depth-1 unroll should have no UNION branches:\n{}",
        r.sparql_nr
    );
}

/// `<a> p* <a>` — zero-step branch must be satisfiable for ground
/// equal endpoints. Regression for roborev #332 finding (medium).
#[test]
fn kleene_zero_step_ground_equal_satisfiable() {
    let q = "PREFIX ex: <http://example.org/>\nASK WHERE { ex:a ex:knows* ex:a . }";
    let r = transform_query(q).expect("transform succeeds");
    // The zero-step branch must NOT be a vacuous `false`. Look for a
    // `true` branch literal.
    assert!(
        r.sparql_nr.contains("let branch_0 = (true);"),
        "ground-equal zero-step should yield a `true` branch:\n{}",
        r.sparql_nr
    );
}

/// `<a> p* <b>` (unequal ground) — zero-step branch must be
/// unsatisfiable, but the positive branches must still apply.
/// Regression for roborev #332 finding (medium).
#[test]
fn kleene_zero_step_ground_unequal_unsatisfiable() {
    let q = "PREFIX ex: <http://example.org/>\nASK WHERE { ex:a ex:knows* ex:b . }";
    let r = transform_query(q).expect("transform succeeds");
    // Zero-step branch must include a `false` filter so the branch
    // is not satisfiable just from being empty.
    assert!(
        r.sparql_nr.contains("(false)"),
        "ground-unequal zero-step should explicitly assert false:\n{}",
        r.sparql_nr
    );
}

/// Joining a UNION-producing path (`+`, `*`, `|`) with a sibling
/// triple must propagate the sibling's constraints into every UNION
/// branch AND the metadata `inputPatterns` must agree with the
/// generated `bgp[i]` indices used in `sparql.nr`. Regression for
/// roborev #332 high (b8e0b1a) and #333 high (5ead595).
#[test]
fn union_path_join_with_sibling_keeps_all_constraints() {
    let q = "PREFIX ex: <http://example.org/>\nSELECT ?s ?o ?x WHERE { ?s ex:flag ?x . ?s ex:knows+ ?o . }";
    let r = transform_query(q).expect("transform succeeds");

    // The sibling triple `?s ex:flag ?x` must appear in every branch.
    let branch_count = r.sparql_nr.matches("let branch_").count();
    assert!(branch_count > 0, "kleene+ should produce union branches:\n{}", r.sparql_nr);
    let flag_count = r.sparql_nr.matches("encode_string(\"http://example.org/flag\")").count();
    assert!(
        flag_count >= branch_count,
        "sibling `ex:flag` predicate should appear in every branch (got flag_count={flag_count}, branches={branch_count}):\n{}",
        r.sparql_nr
    );

    // Index alignment: the predicate IRIs asserted at each `bgp[i]`
    // must match the metadata `inputPatterns[i].predicate`. We look
    // for the literal substring
    //   encode_string("<iri>")) == bgp[i].terms[1]
    // (note the trailing `)` from the `consts::hash2(...)` wrapper)
    // anywhere in the generated source — this binds the IRI hash and
    // the index to the same equality, not just to the same file.
    let patterns = r.metadata
        .get("inputPatterns")
        .and_then(|v| v.as_array())
        .expect("inputPatterns array");
    for (i, pat) in patterns.iter().enumerate() {
        let predicate_iri = pat
            .get("predicate")
            .and_then(|p| p.get("value"))
            .and_then(|v| v.as_str())
            .expect("predicate IRI");
        let needle = format!(
            "encode_string(\"{}\")]) == bgp[{}].terms[1]",
            predicate_iri, i
        );
        assert!(
            r.sparql_nr.contains(&needle),
            "metadata says bgp[{i}] is `{predicate_iri}` but no equality \
             pinning that IRI to bgp[{i}].terms[1] was found:\n{}",
            r.sparql_nr
        );
    }
}

/// `path_segment_max = 0` for a `+` path is rejected outright.
#[test]
fn kleene_zero_max_rejected() {
    let q = "PREFIX ex: <http://example.org/>\nSELECT ?s ?o WHERE { ?s ex:knows+ ?o . }";
    let opts = TransformOptions {
        path_segment_max: 0,
        ..TransformOptions::default()
    };
    let err = match transform_with_opts(q, opts) {
        Err(e) => e,
        Ok(_) => panic!("expected path_segment_max rejection"),
    };
    assert!(
        err.contains("path_segment_max"),
        "error should mention path_segment_max, got: {err}"
    );
}

fn snapshots_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots")
}

fn check_or_update(path: &PathBuf, actual: &str, update: bool, label: &str, name: &str) {
    if update {
        fs::write(path, actual).expect("write snapshot");
        return;
    }
    let expected = fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("missing snapshot {} for {}: {}", label, name, e));
    if expected != actual {
        let actual_path = path.with_extension(format!(
            "{}.actual",
            path.extension().and_then(|s| s.to_str()).unwrap_or("")
        ));
        fs::write(&actual_path, actual).ok();
        panic!(
            "snapshot mismatch ({} for {})\n  expected: {}\n  actual:   {}\nset UPDATE_SNAPSHOTS=1 to regenerate",
            label,
            name,
            path.display(),
            actual_path.display()
        );
    }
}

/// Non-ground-inner `NOT EXISTS` is rejected — round 3 main event ships
/// single-triple ground-inner only. See `spec/exists.md` §7.
#[test]
fn not_exists_non_ground_inner_is_rejected() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { ?s ex:knows ?o . FILTER(NOT EXISTS { ?o ex:age ?age . }) }";
    match transform_query(q) {
        Ok(_) => panic!("expected non-ground-inner NOT EXISTS to be rejected"),
        Err(err) => assert!(
            err.contains("NOT EXISTS") && err.contains("ground-inner") && err.contains("?age"),
            "expected error to mention NOT EXISTS, ground-inner, and ?age, got: {}",
            err
        ),
    }
}

/// `NOT EXISTS` inside a UNION branch is rejected — branch-local
/// non-membership constraints would be silently dropped by the emit
/// layer (roborev finding 2026-05-03 high). Round-4 follow-up.
#[test]
fn not_exists_inside_union_branch_is_rejected() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { \
               { ?s ex:a ?o . FILTER(NOT EXISTS { ?s ex:type ex:Person . }) } \
               UNION \
               { ?s ex:b ?o . } \
             }";
    match transform_query(q) {
        Ok(_) => panic!("expected NOT EXISTS inside UNION branch to be rejected"),
        Err(err) => assert!(
            err.contains("UNION") && err.contains("NOT EXISTS"),
            "expected error to mention UNION and NOT EXISTS, got: {}",
            err
        ),
    }
}

/// `NOT EXISTS` inside an OPTIONAL right-side is rejected — the
/// OptionalBlock IR doesn't carry non-membership constraints (roborev
/// finding 2026-05-03 high, generalised). Round-4 follow-up.
#[test]
fn not_exists_inside_optional_is_rejected() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { \
               ?s ex:knows ?p . \
               OPTIONAL { ?p ex:age ?a . FILTER(NOT EXISTS { ?p ex:type ex:Person . }) } \
             }";
    match transform_query(q) {
        Ok(_) => panic!("expected NOT EXISTS inside OPTIONAL right-side to be rejected"),
        Err(err) => assert!(
            err.contains("OPTIONAL") && err.contains("NOT EXISTS"),
            "expected error to mention OPTIONAL and NOT EXISTS, got: {}",
            err
        ),
    }
}

/// `MINUS` with a UNION right-side is rejected — partially-disjoint
/// branches need exact W3C §18.5 semantics that single-triple-ground
/// NOT EXISTS doesn't provide (roborev follow-up 2026-05-03 medium).
/// Round-4 follow-up — once OPTIONAL collapse (and its prefix-tree
/// commitment) lands, MINUS over arbitrary RHS becomes tractable.
#[test]
fn minus_with_union_rhs_is_rejected() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s ?o WHERE { \
               ?s ex:p ?o . \
               MINUS { { ?s ex:q ?x } UNION { ?y ex:r ?z } } \
             }";
    match transform_query(q) {
        Ok(_) => panic!("expected MINUS over UNION-RHS to be rejected"),
        Err(err) => {
            // The current lowering rejects this via the NOT EXISTS
            // rewrite catching the inner UNION ("UNION inside an
            // EXISTS pattern" is the existing reject path) — either
            // error path is acceptable, the important property is
            // that the query does not silently lower with incorrect
            // semantics.
            assert!(
                err.contains("NOT EXISTS")
                    || err.contains("MINUS")
                    || err.contains("UNION"),
                "expected error mentioning NOT EXISTS / MINUS / UNION, got: {}",
                err
            );
        }
    }
}

/// Variable-disjoint `MINUS` is a no-op per W3C §18.5 — when the inner
/// pattern shares no variables with the outer, every row is kept (roborev
/// finding 2026-05-03 medium). Verifies the lowering produces the
/// outer alone, with no NonExistenceConstraint.
#[test]
fn minus_variable_disjoint_is_noop() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s ?o WHERE { \
               ?s ex:knows ?o . \
               MINUS { ex:bob ex:type ex:Spy . } \
             }";
    let result = transform_query(q).expect("transform should succeed");
    assert!(
        result.sparql_nr.contains("type BGP = [Triple; 1]"),
        "variable-disjoint MINUS must lower as the outer pattern alone (1 triple, no brackets), got:\n{}",
        result.sparql_nr
    );
    let ne = result
        .metadata
        .get("notExists")
        .and_then(|v| v.as_array())
        .expect("notExists metadata array");
    assert_eq!(
        ne.len(),
        0,
        "variable-disjoint MINUS must emit no NonExistenceConstraint"
    );
}

/// Round-3 follow-up — tiered partial OPTIONAL collapse easy case.
/// `?s ex:knows ?o . OPTIONAL { ?s ex:type ex:Person . }` — every
/// position of the inner triple is either an outer-bound variable
/// (`?s`) or a constant (`ex:type`, `ex:Person`). The OPTIONAL must
/// collapse to a single `assert(matched | unmatched)` line, with
/// `verify_non_membership_no_inclusion_check` in the unmatched arm
/// and inclusion-style position assertions on the matched arm. No
/// `optional_circuits[]` entry is produced. See `spec/exists.md` §4.1.
#[test]
fn optional_easy_case_collapses_to_single_circuit() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s ?o WHERE { ?s ex:knows ?o . OPTIONAL { ?s ex:type ex:Person . } }";
    let result = transform_query(q).expect("transform should succeed");

    // No power-set variants: easy-case OPTIONAL does not contribute
    // to the `optional_circuits[]` array.
    assert!(
        result.optional_circuits.is_empty(),
        "easy-case OPTIONAL must not produce power-set variants, got {} circuits",
        result.optional_circuits.len()
    );
    // Three appended slots (outer triple + matched-arm slot + 2 brackets).
    assert!(
        result.sparql_nr.contains("type BGP = [Triple; 4]"),
        "expected BGP of size 4 (1 outer + 1 matched + 2 brackets), got:\n{}",
        result.sparql_nr
    );
    // Body must contain the boolean non-membership check inside the
    // unmatched arm of an `assert(... | ...)` line.
    assert!(
        result.sparql_nr.contains("verify_non_membership_no_inclusion_check"),
        "expected verify_non_membership_no_inclusion_check call, got:\n{}",
        result.sparql_nr
    );
    // Metadata exposes the easy-case OPTIONAL.
    let easy = result
        .metadata
        .get("easyOptionals")
        .and_then(|v| v.as_array())
        .expect("easyOptionals metadata array");
    assert_eq!(easy.len(), 1, "expected one easy-case OPTIONAL, got {:?}", easy);
    // No regular `optionalPatterns` entry — the easy-case OPTIONAL
    // does not flow through the power-set machinery.
    let opt = result
        .metadata
        .get("optionalPatterns")
        .and_then(|v| v.as_array())
        .expect("optionalPatterns metadata array");
    assert_eq!(
        opt.len(),
        0,
        "easy-case OPTIONAL must not appear in optionalPatterns, got {:?}",
        opt
    );
}

/// Round-3 follow-up — tiered partial OPTIONAL collapse fall-through.
/// `OPTIONAL { ?p ex:age ?o }` (where `?p` is outer-bound but `?o` is
/// inner-only) does **not** satisfy the easy-case predicate; it must
/// still flow through the existing `2^n` power-set path unchanged —
/// `optional_circuits` non-empty, regular `optionalPatterns` populated.
#[test]
fn optional_inner_only_var_falls_through_to_power_set() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s ?o WHERE { ?s ex:knows ?p . OPTIONAL { ?p ex:age ?o . } }";
    let result = transform_query(q).expect("transform should succeed");

    // Power-set path preserved.
    assert_eq!(
        result.optional_circuits.len(),
        1,
        "fall-through OPTIONAL must produce one power-set variant, got {}",
        result.optional_circuits.len()
    );
    let opt = result
        .metadata
        .get("optionalPatterns")
        .and_then(|v| v.as_array())
        .expect("optionalPatterns metadata array");
    assert_eq!(opt.len(), 1, "fall-through OPTIONAL must populate optionalPatterns");
    let easy = result
        .metadata
        .get("easyOptionals")
        .and_then(|v| v.as_array())
        .expect("easyOptionals metadata array");
    assert!(
        easy.is_empty(),
        "fall-through OPTIONAL must NOT register as easy-case, got {:?}",
        easy
    );
    assert!(
        !result
            .sparql_nr
            .contains("verify_non_membership_no_inclusion_check"),
        "fall-through OPTIONAL must NOT emit the boolean non-membership check"
    );
}

/// Round-3 follow-up — graph-scoped easy-case OPTIONAL. The
/// placeholder slots' graph context must be `DefaultGraph` (a
/// prover-side wildcard), NOT the inner pattern's named graph —
/// otherwise the unmatched arm cannot witness when the named graph
/// has no leaves (roborev finding 2026-05-03, second high). The
/// matched-arm assertions in `checkBinding` still pin the graph
/// position to the substituted graph term.
#[test]
fn optional_easy_case_graph_scoped_uses_wildcard_placeholders() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { \
               ?s ex:knows ?o . \
               OPTIONAL { GRAPH ex:g { ?s ex:type ex:Person . } } \
             }";
    let result = transform_query(q).expect("transform should succeed");
    let easy = result
        .metadata
        .get("easyOptionals")
        .and_then(|v| v.as_array())
        .expect("easyOptionals metadata array");
    assert_eq!(easy.len(), 1, "graph-scoped easy OPTIONAL must collapse");

    // The placeholder slots in `inputPatterns` (slots 1-3 after the
    // outer triple) must have `DefaultGraph` graph context, not the
    // named graph `ex:g`. Otherwise the prover-side resolver would
    // require quads from `ex:g` for those slots even in the
    // unmatched arm.
    let patterns = result
        .metadata
        .get("inputPatterns")
        .and_then(|v| v.as_array())
        .expect("inputPatterns array");
    assert_eq!(patterns.len(), 4, "expected 1 outer + 3 placeholder slots");
    for i in 1..=3 {
        let graph = patterns[i].get("graph").expect("graph field");
        let term_type = graph.get("termType").and_then(|v| v.as_str());
        assert_eq!(
            term_type,
            Some("DefaultGraph"),
            "placeholder slot {} must have wildcard (DefaultGraph) graph, got {:?}",
            i,
            graph
        );
    }
    // The checkBinding body must still pin the matched-arm graph
    // position to `ex:g`, otherwise the matched arm would accept
    // any-graph witnesses and the disjunction would always be true.
    assert!(
        result
            .sparql_nr
            .contains("http://example.org/g")
            && result
                .sparql_nr
                .contains("bgp[1].terms[3]"),
        "matched arm should pin bgp[1].terms[3] to ex:g, got:\n{}",
        result.sparql_nr
    );
}

/// Round-3 follow-up — easy-case OPTIONAL inheriting graph scope
/// from an enclosing `GRAPH ex:g { ... }`. Roborev finding
/// 2026-05-03 (third high): the GRAPH wrapper was overwriting the
/// easy-OPTIONAL placeholders' graph context back to `ex:g`,
/// reintroducing the witness-failure bug from finding 2.
///
/// The `Graph` lowering now skips the easy-OPTIONAL synthetic slots
/// when rewriting `pattern.graph` and adding graph assertions.
/// Separately, the `EasyOptional.inner_terms[3]` is rewritten from
/// the default-graph empty-IRI to the effective graph term so the
/// matched-arm assertion still pins the substituted graph to `ex:g`.
#[test]
fn optional_easy_case_inside_enclosing_graph_keeps_placeholders_wildcard() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { \
               GRAPH ex:g { \
                 ?s ex:knows ?o . \
                 OPTIONAL { ?s ex:type ex:Person . } \
               } \
             }";
    let result = transform_query(q).expect("transform should succeed");

    // Easy-case lowering still fires.
    let easy = result
        .metadata
        .get("easyOptionals")
        .and_then(|v| v.as_array())
        .expect("easyOptionals metadata array");
    assert_eq!(
        easy.len(),
        1,
        "OPTIONAL inside enclosing GRAPH must still collapse"
    );

    // Placeholder slots stay `DefaultGraph` (wildcard) in the
    // metadata, even though the outer triple was rewritten to `ex:g`.
    let patterns = result
        .metadata
        .get("inputPatterns")
        .and_then(|v| v.as_array())
        .expect("inputPatterns array");
    assert_eq!(patterns.len(), 4, "expected 1 outer + 3 placeholder slots");
    let outer_graph = patterns[0].get("graph").expect("outer graph");
    assert_eq!(
        outer_graph.get("termType").and_then(|v| v.as_str()),
        Some("NamedNode"),
        "outer triple's graph must be the enclosing GRAPH's IRI"
    );
    assert_eq!(
        outer_graph.get("value").and_then(|v| v.as_str()),
        Some("http://example.org/g"),
        "outer triple's graph must be ex:g"
    );
    for i in 1..=3 {
        let graph = patterns[i].get("graph").expect("graph field");
        assert_eq!(
            graph.get("termType").and_then(|v| v.as_str()),
            Some("DefaultGraph"),
            "placeholder slot {} must stay wildcard (DefaultGraph), got {:?}",
            i,
            graph
        );
    }

    // The matched-arm assertion in `checkBinding` must pin the
    // matched-slot's graph position to `ex:g`. It should appear
    // **inside the OR disjunction** (matched-arm branch), not as a
    // free-standing assertion line. We check both: bgp[1].terms[3]
    // is referenced AND it occurs in the disjunction line, NOT in a
    // separate `assert(...)` line. Roborev finding 2026-05-03
    // (third high, sub-finding 2): without this stronger check, a
    // global graph assertion on bgp[1].terms[3] could slip through
    // and silently force the matched-arm graph in both arms.
    let bgp1_count = result
        .sparql_nr
        .matches("bgp[1].terms[3]")
        .count();
    assert_eq!(
        bgp1_count, 1,
        "bgp[1].terms[3] should appear exactly once (inside the matched-arm \
         disjunction), got {} occurrences:\n{}",
        bgp1_count, result.sparql_nr
    );
    // Sanity: that one occurrence must be inside the
    // `assert(... | utils::verify_non_membership_no_inclusion_check)`
    // line, not in a free-standing `assert(... == bgp[1].terms[3])`.
    let or_line_with_bgp1 = result.sparql_nr.lines().any(|l| {
        l.contains("bgp[1].terms[3]")
            && l.contains("verify_non_membership_no_inclusion_check")
    });
    assert!(
        or_line_with_bgp1,
        "bgp[1].terms[3] must appear inside the matched|unmatched disjunction line, got:\n{}",
        result.sparql_nr
    );

    // The Graph wrapper's per-slot graph assertion must NOT cover
    // the easy-OPTIONAL placeholder slots (slots 1, 2, 3). Look for
    // the assertion form: `consts::hash2([0, ... "ex:g"]) ==
    // bgp[i].terms[3]`. It should appear for slot 0 only.
    let graph_iri_count = result
        .sparql_nr
        .matches("== bgp[0].terms[3]")
        .count();
    assert_eq!(
        graph_iri_count, 1,
        "expected exactly one outer graph assertion at bgp[0].terms[3], got:\n{}",
        result.sparql_nr
    );
    // No graph assertion on bgp[2] / bgp[3] (the bracket slots).
    assert!(
        !result.sparql_nr.contains("== bgp[2].terms[3]")
            && !result.sparql_nr.contains("== bgp[3].terms[3]"),
        "bracket slots must not have a graph-pinning assertion, got:\n{}",
        result.sparql_nr
    );
}

/// Round-3 follow-up — `?g` bound by a sibling pattern outside the
/// `GRAPH ?g { ... }` wrapper. The transform must NOT reject this
/// case (roborev finding 2026-05-03, fourth medium: an earlier
/// over-aggressive rejection blocked it). The easy-case collapse
/// fires; the matched-arm graph reference resolves to `variables.g`
/// (bound by the sibling triple at the post-Join scope).
///
/// Roborev finding 2026-05-03 (sixth pass, medium): the regression
/// must inspect the lowered output, not just check `Ok(_)`, so a
/// silent fall-through wouldn't pass.
#[test]
fn optional_easy_case_graph_var_bound_by_sibling() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?x ?g WHERE { \
               ?x ex:g ?g . \
               GRAPH ?g { OPTIONAL { ex:a ex:p ex:b . } } \
             }";
    let result = transform_query(q).expect(
        "transform should succeed: ?g is bound by the sibling triple outside the GRAPH wrapper",
    );

    // The easy-case collapse MUST fire (single-triple ground inner,
    // no inner-only variables, sibling triple binds the GRAPH
    // variable at the surrounding Join level).
    let easy = result
        .metadata
        .get("easyOptionals")
        .and_then(|v| v.as_array())
        .expect("easyOptionals metadata array");
    assert_eq!(
        easy.len(),
        1,
        "expected one collapsed easy OPTIONAL, got {:?}",
        easy
    );
    // No power-set fall-through.
    assert!(
        result.optional_circuits.is_empty(),
        "easy-case collapse must not also produce power-set variants"
    );

    // The matched-arm graph position must reference `variables.g`,
    // not a stale empty-IRI default-graph constant. The presence of
    // `variables.g` in the disjunction line is the binding the
    // sibling-triple Join contributes; the absence of
    // `consts::encode_string("")` against a `bgp[*].terms[3]` slot
    // says we did NOT silently revert to default-graph soundness.
    let or_line = result
        .sparql_nr
        .lines()
        .find(|l| l.contains("verify_non_membership_no_inclusion_check"))
        .expect("expected an `assert(matched | unmatched)` line");
    assert!(
        or_line.contains("variables.g"),
        "matched-arm disjunction must reference variables.g (the sibling-bound \
         GRAPH variable), got line:\n{}",
        or_line
    );
    // `?g` ends up in the projected variables via the sibling
    // triple's binding.
    assert!(
        result.sparql_nr.contains("pub(crate) g: Field"),
        "?g must be projected (bound by sibling triple), got:\n{}",
        result.sparql_nr
    );
}

/// Multi-triple inner `OPTIONAL` falls through to power-set even when
/// every variable is outer-bound — easy-case scope is single-triple
/// inner only. Round-4's prefix-tree commitments will lift this.
#[test]
fn optional_multi_triple_inner_falls_through() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { \
               ?s ex:knows ?p . \
               OPTIONAL { ?s ex:type ex:Person . ?p ex:type ex:Person . } \
             }";
    let result = transform_query(q).expect("transform should succeed");
    assert_eq!(
        result.optional_circuits.len(),
        1,
        "multi-triple OPTIONAL must fall through to power-set"
    );
    let easy = result
        .metadata
        .get("easyOptionals")
        .and_then(|v| v.as_array())
        .expect("easyOptionals metadata array");
    assert!(
        easy.is_empty(),
        "multi-triple OPTIONAL must NOT register as easy-case"
    );
}

/// Multi-triple inner `NOT EXISTS` is rejected — round 3 main event
/// ships single-triple inner only. See `spec/exists.md` §7.
#[test]
fn not_exists_multi_triple_inner_is_rejected() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { \
               ?s ex:knows ?o . \
               FILTER(NOT EXISTS { ?s ex:type ex:Person . ?s ex:flag ?o . }) \
             }";
    match transform_query(q) {
        Ok(_) => panic!("expected multi-triple-inner NOT EXISTS to be rejected"),
        Err(err) => assert!(
            err.contains("NOT EXISTS") && err.contains("single-triple"),
            "expected error to mention NOT EXISTS and single-triple, got: {}",
            err
        ),
    }
}

/// Ground-inner single-triple `NOT EXISTS` lowers to a non-membership
/// constraint. The inner triple `?s ex:type ex:Person` has every
/// position bound from the outer scope (?s) or constant (ex:type,
/// ex:Person). The expected witness shape is: outer BGP triple +
/// 2 bracket-leaf BGP slots + 1 NonExistenceConstraint.
#[test]
fn not_exists_ground_inner_lowers_to_non_membership() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { \
               ?s ex:knows ?o . \
               FILTER(NOT EXISTS { ?s ex:type ex:Person . }) \
             }";
    let result = transform_query(q).expect("transform should succeed");
    // Three BGP slots: outer triple + 2 brackets.
    assert!(
        result.sparql_nr.contains("type BGP = [Triple; 3]"),
        "expected BGP of size 3 (1 outer + 2 brackets), got:\n{}",
        result.sparql_nr
    );
    // Body must call `verify_non_membership_no_inclusion` (the Middle
    // arm of the runtime dispatch).
    assert!(
        result.sparql_nr.contains("utils::verify_non_membership_no_inclusion"),
        "expected verify_non_membership_no_inclusion call, got:\n{}",
        result.sparql_nr
    );
    // Metadata exposes the constraint.
    let ne = result
        .metadata
        .get("notExists")
        .and_then(|v| v.as_array())
        .expect("notExists metadata array");
    assert_eq!(ne.len(), 1, "expected one NonExistenceConstraint");
}

/// Boundary-sentinel transform wiring: the generated circuit must
/// expose all three `verify_non_membership_*_no_inclusion` primitives
/// (Lower / Middle / Upper) under a runtime dispatch on the public
/// `boundary_cases[i]` Field, so the prover can witness any
/// `absent_hash` regardless of where it falls in the sorted leaf
/// distribution. See `spec/exists.md` §3.3 and the
/// `transform_dispatch_*` Noir tests in
/// `noir/lib/utils/src/lib.nr`.
#[test]
fn not_exists_emits_boundary_sentinel_dispatch() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { \
               ?s ex:knows ?o . \
               FILTER(NOT EXISTS { ?s ex:type ex:Person . }) \
             }";
    let result = transform_query(q).expect("transform should succeed");

    // All three dispatch arms must appear in the generated body.
    for arm in [
        "utils::verify_non_membership_low_sentinel_no_inclusion",
        "utils::verify_non_membership_no_inclusion",
        "utils::verify_non_membership_high_sentinel_no_inclusion",
    ] {
        assert!(
            result.sparql_nr.contains(arm),
            "expected dispatch arm `{arm}` in generated sparql.nr, got:\n{}",
            result.sparql_nr
        );
    }
    // The dispatch must gate on `boundary_cases[0]`.
    assert!(
        result.sparql_nr.contains("if boundary_cases[0] == 0")
            && result.sparql_nr.contains("} else if boundary_cases[0] == 1")
            && result.sparql_nr.contains("} else if boundary_cases[0] == 2"),
        "expected boundary_cases[0] dispatch chain, got:\n{}",
        result.sparql_nr
    );
    // Out-of-range tag must reject.
    assert!(
        result.sparql_nr.contains("must be 0 (Lower), 1 (Middle), or 2 (Upper)"),
        "expected out-of-range boundary_case rejection, got:\n{}",
        result.sparql_nr
    );

    // The `BoundaryCases` type and its length must match the
    // constraint count.
    assert!(
        result.sparql_nr.contains("type BoundaryCases = [Field; 1]"),
        "expected BoundaryCases sized to 1 (one constraint), got:\n{}",
        result.sparql_nr
    );

    // `main.nr` must run sentinel inclusion + thread the sentinel
    // arguments into checkBinding.
    assert!(
        result.main_nr.contains("verify_low_sentinel_inclusion(low_sentinel, roots[0].value)")
            && result
                .main_nr
                .contains("verify_high_sentinel_inclusion(high_sentinel, roots[0].value)"),
        "expected sentinel inclusion calls in main.nr, got:\n{}",
        result.main_nr
    );
    assert!(
        result.main_nr.contains("low_sentinel: SentinelLeaf")
            && result.main_nr.contains("high_sentinel: SentinelLeaf")
            && result.main_nr.contains("boundary_cases: pub BoundaryCases"),
        "expected SentinelLeaf + BoundaryCases parameters in main.nr signature, got:\n{}",
        result.main_nr
    );
}

/// `MINUS` paired with a `FILTER(NOT EXISTS { … })` produces two
/// independent `NonExistenceConstraint`s, each with its own
/// boundary-case dispatch. Guards against accidental shared-state
/// regressions where the dispatch index gets mis-aligned to the
/// constraint index.
#[test]
fn multiple_not_exists_emit_independent_boundary_dispatches() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { \
               ?s ex:knows ?o . \
               FILTER(NOT EXISTS { ?s ex:type ex:Person . }) \
               MINUS { ?s ex:status ex:Banned . } \
             }";
    let result = transform_query(q).expect("transform should succeed");

    assert!(
        result.sparql_nr.contains("type BoundaryCases = [Field; 2]"),
        "expected BoundaryCases sized to 2 (two constraints), got:\n{}",
        result.sparql_nr
    );
    // Each constraint dispatches on a distinct index.
    for idx in 0..2 {
        let needle = format!("if boundary_cases[{idx}] == 0");
        assert!(
            result.sparql_nr.contains(&needle),
            "expected dispatch on boundary_cases[{idx}], got:\n{}",
            result.sparql_nr
        );
    }
}

/// EXISTS nested under boolean operators is rejected for now (see
/// `spec/exists.md` §7 open question 3).
#[test]
fn exists_inside_boolean_combinator_is_rejected() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { ?s ex:knows ?o . FILTER(EXISTS { ?o ex:a ?a } && EXISTS { ?o ex:b ?b }) }";
    match transform_query(q) {
        Ok(_) => panic!("expected nested EXISTS to be rejected, but transform succeeded"),
        Err(err) => assert!(
            err.contains("EXISTS") && err.contains("spec/exists.md"),
            "expected error to mention EXISTS and spec/exists.md, got: {}",
            err
        ),
    }
}

/// `FILTER(EXISTS{P})` over a UNION-shaped outer pattern is rejected
/// (per roborev finding 2026-05-03). Naively flattening would corrupt
/// the constraint shape because UNION's branches each own their
/// bindings; EXISTS would then see no outer bindings at all and treat
/// every variable as inner-only.
#[test]
fn exists_over_union_outer_is_rejected() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { \
               { ?s ex:a ?o . } UNION { ?s ex:b ?o . } \
               FILTER(EXISTS { ?o ex:age ?age . }) \
             }";
    match transform_query(q) {
        Ok(_) => panic!("expected EXISTS over UNION outer to be rejected"),
        Err(err) => assert!(
            err.contains("UNION") && err.contains("spec/exists.md"),
            "expected error to mention UNION and spec/exists.md, got: {}",
            err
        ),
    }
}

/// Inner-only EXISTS variables are renamed to `__exists_<orig>_<id>` so
/// they cannot collide with the outer scope or another EXISTS block's
/// vars. Verifies the medium-severity roborev fix: prevents an EXISTS
/// witness's inner variable from accidentally correlating with a real
/// outer binding of the same name.
#[test]
fn inner_only_exists_variables_are_renamed() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { ?s ex:knows ?o . FILTER(EXISTS { ?o ex:age ?age . }) }";
    let result = transform_query(q).expect("transform should succeed");
    // ?age is inner-only — the original name must not appear in the
    // generated Noir code (would imply it leaked into outer scope).
    assert!(
        !result.sparql_nr.contains("variables.age"),
        "?age should not be projected as a variable: {}",
        result.sparql_nr
    );
    // Variables struct should only contain ?s.
    assert!(result.sparql_nr.contains("pub(crate) struct Variables {\n  pub(crate) s: Field,\n}"));
}

/// ORDER BY keys must be threaded into `circuit_vars` so the
/// disclosed multiset has the columns the verifier needs to sort
/// (audit item 3, sparql_noir #39 row, 2026-05-03).
#[test]
fn order_by_key_is_threaded_into_circuit_vars() {
    // Order by ?o, project only ?s. Without the fix, ?o would be
    // bound by the BGP but not disclosed, leaving the verifier
    // unable to apply the ORDER BY direction.
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { ?s ex:knows ?o . } ORDER BY ?o";
    let result = transform_query(q).expect("transform should succeed");
    let variables = result
        .metadata
        .get("variables")
        .and_then(|v| v.as_array())
        .expect("variables array");
    let names: Vec<&str> = variables.iter().filter_map(|v| v.as_str()).collect();
    assert!(names.contains(&"o"), "?o (order-by key) must be in circuit_vars: {:?}", names);
    assert!(names.contains(&"s"), "?s (projected) must be in circuit_vars: {:?}", names);
}

/// ORDER BY repeating the same variable must not push the same
/// name twice into `circuit_vars` (roborev follow-up on item 3).
#[test]
fn order_by_duplicate_key_does_not_duplicate_circuit_vars() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { ?s ex:knows ?o . } ORDER BY ?o ASC(?o)";
    let result = transform_query(q).expect("transform should succeed");
    let variables = result
        .metadata
        .get("variables")
        .and_then(|v| v.as_array())
        .expect("variables array");
    let names: Vec<&str> = variables.iter().filter_map(|v| v.as_str()).collect();
    let o_count = names.iter().filter(|n| **n == "o").count();
    assert_eq!(o_count, 1, "?o should appear exactly once even with two ORDER BY uses: {:?}", names);
}

/// ORDER BY referencing an unbound variable is rejected — the
/// verifier cannot sort by a variable that the BGP never assigned
/// (audit follow-up to item 3).
#[test]
fn order_by_unbound_variable_is_rejected() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { ?s ex:knows ?o . } ORDER BY ?nowhere";
    match transform_query(q) {
        Ok(_) => panic!("expected ORDER BY ?nowhere to be rejected"),
        Err(err) => assert!(
            err.contains("ORDER BY") && err.contains("nowhere"),
            "expected error to mention ORDER BY and the unbound name, got: {}",
            err
        ),
    }
}

/// Top-level ORDER BY by a non-variable expression must propagate
/// the `order_expression_to_key` error rather than silently dropping
/// the key (audit item 5, sparql_noir #39 row).
#[test]
fn top_level_order_by_unsupported_expression_is_rejected() {
    // `ORDER BY (?s + ?o)` is parsed by spargebra into an
    // OrderExpression::Asc(Expression::Add(_, _)) — the IR layer
    // only supports variable keys, so this must surface as an error
    // rather than be silently dropped.
    let q = "PREFIX ex: <http://example.org/>\n\
             PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\n\
             SELECT ?s ?o WHERE { ?s ex:knows ?o . } ORDER BY (?s)";
    // The simple variable case still works.
    transform_query(q).expect("ORDER BY (?s) should succeed");

    // Now an expression that lower.rs's `order_expression_to_key` does
    // not yet support: a function call. The error must surface.
    let q2 = "PREFIX ex: <http://example.org/>\n\
              PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\n\
              SELECT ?s ?o WHERE { ?s ex:age ?o . } ORDER BY (xsd:integer(?o) + 1)";
    match transform_query(q2) {
        Ok(_) => panic!("expected ORDER BY by an expression to be rejected"),
        Err(err) => assert!(
            err.contains("ORDER BY") || err.contains("non-variable"),
            "expected error to mention ORDER BY semantics, got: {}",
            err
        ),
    }
}

/// Inner-only **predicate** variables must also be renamed in metadata
/// (per roborev follow-up). A `?p` predicate inside EXISTS would
/// otherwise leak its original name and let downstream matchers
/// correlate two unrelated EXISTS blocks reusing `?p`.
#[test]
fn inner_only_predicate_variable_is_renamed_in_metadata() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { ?s ex:knows ?o . FILTER(EXISTS { ?o ?p \"hi\" . }) }";
    let result = transform_query(q).expect("transform should succeed");
    let metadata = serde_json::to_string(&result.metadata).expect("serialise");
    // Original predicate name must not appear as an exposed Variable.
    assert!(
        !metadata.contains("\"value\":\"p\""),
        "?p (predicate) should be renamed in metadata: {}",
        metadata
    );
    assert!(
        metadata.contains("__exists_p_"),
        "metadata should expose the renamed __exists_p_<id>: {}",
        metadata
    );
}

/// ASK queries auto-project every bound variable. The roborev
/// 2026-05-03 finding: with EXISTS now introducing `__exists_*` hidden
/// vars, ASK must filter them out to avoid leaking inner-only witness
/// names. This test guards that filter.
#[test]
fn ask_with_exists_does_not_leak_inner_only_vars() {
    let q = "PREFIX ex: <http://example.org/>\n\
             ASK WHERE { ?s ex:knows ?o . FILTER(EXISTS { ?o ex:age ?age . }) }";
    let result = transform_query(q).expect("transform should succeed");
    assert!(
        !result.sparql_nr.contains("__exists_age"),
        "__exists_age_* should not appear in ASK projection: {}",
        result.sparql_nr
    );
    // Sanity: the regular outer-bound variables ?s and ?o still project.
    assert!(result.sparql_nr.contains("pub(crate) s: Field"));
    assert!(result.sparql_nr.contains("pub(crate) o: Field"));
}

/// EXISTS with a fully-ground inner pattern lowers cleanly: the inner
/// triple becomes an additional outer BGP entry with constant-position
/// assertions and a unification of the shared variable.
#[test]
fn exists_grounded_lowers_to_two_triple_bgp() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { ?s ex:knows ?o . FILTER(EXISTS { ?s ex:type ex:Person . }) }";
    let result = transform_query(q).expect("transform should succeed");
    // Two triples: the outer `?s ex:knows ?o` and the flattened inner
    // `?s ex:type ex:Person`.
    assert!(result.sparql_nr.contains("type BGP = [Triple; 2]"));
    // The inner subject unifies with the outer-bound variable `?s`.
    assert!(result.sparql_nr.contains("variables.s == bgp[1].terms[0]"));
    // Inner predicate / object land as constant assertions.
    assert!(result.sparql_nr.contains("http://example.org/type"));
    assert!(result.sparql_nr.contains("http://example.org/Person"));
    // The EXISTS expression itself collapsed to `true`.
    assert!(result.sparql_nr.contains("assert(true);"));
}

#[test]
fn corpus_byte_identical() {
    let update = env::var("UPDATE_SNAPSHOTS").map(|v| v == "1").unwrap_or(false);
    let dir = snapshots_dir();

    for case in CORPUS {
        let result = transform_query(case.query)
            .unwrap_or_else(|e| panic!("transform failed for {}: {}", case.name, e));

        let metadata_pretty = serde_json::to_string_pretty(&result.metadata)
            .expect("serialise metadata");

        check_or_update(
            &dir.join(format!("{}.sparql.nr", case.name)),
            &result.sparql_nr,
            update,
            "sparql.nr",
            case.name,
        );
        check_or_update(
            &dir.join(format!("{}.main.nr", case.name)),
            &result.main_nr,
            update,
            "main.nr",
            case.name,
        );
        check_or_update(
            &dir.join(format!("{}.Nargo.toml", case.name)),
            &result.nargo_toml,
            update,
            "Nargo.toml",
            case.name,
        );
        check_or_update(
            &dir.join(format!("{}.metadata.json", case.name)),
            &metadata_pretty,
            update,
            "metadata.json",
            case.name,
        );
    }
}
