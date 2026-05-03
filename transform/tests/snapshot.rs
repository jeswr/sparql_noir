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

use transform::transform_query;

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
];

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

/// `NOT EXISTS` is rejected at lowering — see `spec/exists.md` §3 / §6
/// for the deferred sorted-Merkle-commitment design.
#[test]
fn not_exists_is_rejected_with_pointer_to_design_doc() {
    let q = "PREFIX ex: <http://example.org/>\n\
             SELECT ?s WHERE { ?s ex:knows ?o . FILTER(NOT EXISTS { ?o ex:age ?age . }) }";
    match transform_query(q) {
        Ok(_) => panic!("expected NOT EXISTS to be rejected, but transform succeeded"),
        Err(err) => assert!(
            err.contains("NOT EXISTS") && err.contains("spec/exists.md"),
            "expected error to mention NOT EXISTS and spec/exists.md, got: {}",
            err
        ),
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
