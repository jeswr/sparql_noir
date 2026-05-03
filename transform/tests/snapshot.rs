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
