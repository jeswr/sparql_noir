use crate::encoding::{get_graph_encoding_string, get_term_encoding_string};
use oxrdf::{Dataset, GraphName, Term};
use oxrdfio::{RdfFormat, RdfParser};
use serde::Serialize;
use spareval::{QueryEvaluator, QueryResults};
use spargebra::algebra::GraphPattern;
use spargebra::term::{NamedNodePattern, TermPattern, TriplePattern};
use spargebra::{Query, SparqlParser};
use std::fs;
use std::io::BufReader;
use std::path::Path;

#[derive(Serialize)]
pub struct BindingOutput {
    pub variables: Vec<String>,
    pub assignments: Vec<String>,
    pub bgp_triples: Vec<[String; 4]>,
    pub paths: Vec<[String; 11]>,
    pub direction: Vec<[String; 10]>,
}

fn guess_format_from_ext(path: &Path) -> Option<RdfFormat> {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
    {
        Some(ext) if ext == "ttl" => Some(RdfFormat::Turtle),
        Some(ext) if ext == "nt" => Some(RdfFormat::NTriples),
        Some(ext) if ext == "nq" => Some(RdfFormat::NQuads),
        Some(ext) if ext == "trig" => Some(RdfFormat::TriG),
        Some(ext) if ext == "rdf" || ext == "xml" => Some(RdfFormat::RdfXml),
        Some(ext) if ext == "jsonld" => Some(RdfFormat::JsonLd {
            profile: oxrdfio::JsonLdProfileSet::default(),
        }),
        _ => None,
    }
}

fn collect_triple_patterns(gp: &GraphPattern, out: &mut Vec<TriplePattern>) {
    match gp {
        GraphPattern::Bgp { patterns } => out.extend(patterns.clone()),
        GraphPattern::Join { left, right } => {
            collect_triple_patterns(left, out);
            collect_triple_patterns(right, out);
        }
        GraphPattern::Filter { inner, .. } => collect_triple_patterns(inner, out),
        GraphPattern::Extend { inner, .. } => collect_triple_patterns(inner, out),
        GraphPattern::Project { inner, .. } => collect_triple_patterns(inner, out),
        _ => {}
    }
}

pub fn evaluate_bindings(
    input_rdf: &str,
    query_str: &str,
    out_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // Build dataset
    let path = Path::new(input_rdf);
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let format = guess_format_from_ext(path).ok_or("Unknown RDF format")?;

    let mut dataset = Dataset::default();
    for quad in RdfParser::from_format(format).for_reader(reader) {
        let q = quad?;
        dataset.insert(q.as_ref());
    }

    // Parse query (provided directly as string)
    let query = SparqlParser::new().parse_query(query_str)?;

    // Variables and patterns
    let (pattern_ref, mut vars): (&GraphPattern, Vec<String>) = match &query {
        Query::Select { pattern, .. } => (pattern, Vec::new()),
        _ => return Err("Only SELECT queries supported for binding export".into()),
    };
    let mut patterns: Vec<TriplePattern> = Vec::new();
    collect_triple_patterns(pattern_ref, &mut patterns);

    // Evaluate
    let evaluator = QueryEvaluator::new();
    let results = evaluator.execute(&dataset, &query)?;
    // Initialize vars from results header
    if let QueryResults::Solutions(ref solutions) = results {
        vars = solutions
            .variables()
            .iter()
            .map(|v| v.as_str().to_string())
            .collect();
    }
    let mut assignments: Vec<String> = vec!["0x0".to_string(); vars.len()];
    let mut bgp_triples: Vec<[String; 4]> = Vec::with_capacity(patterns.len());

    match results {
        QueryResults::Solutions(mut it) => {
            if let Some(sol) = it.next() {
                let sol = sol?;
                // Variables assignments
                for (i, name) in vars.iter().enumerate() {
                    if let Some(term) = sol.get(name.as_str()) {
                        assignments[i] = get_term_encoding_string(&term);
                    }
                }

                // Instantiate BGP triples using solution
                for tp in patterns {
                    // subject
                    let s_term: Term = match tp.subject {
                        TermPattern::NamedNode(nn) => Term::from(nn),
                        TermPattern::Variable(v) => sol
                            .get(v.as_str())
                            .cloned()
                            .ok_or("Unbound subject variable")?,
                        TermPattern::BlankNode(b) => Term::from(b),
                        TermPattern::Literal(l) => Term::from(l),
                    };
                    // predicate
                    let p_term: Term = match tp.predicate {
                        NamedNodePattern::NamedNode(nn) => Term::from(nn),
                        NamedNodePattern::Variable(v) => sol
                            .get(v.as_str())
                            .cloned()
                            .ok_or("Unbound predicate variable")?,
                    };
                    // object
                    let o_term: Term = match tp.object {
                        TermPattern::NamedNode(nn) => Term::from(nn),
                        TermPattern::Variable(v) => sol
                            .get(v.as_str())
                            .cloned()
                            .ok_or("Unbound object variable")?,
                        TermPattern::BlankNode(b) => Term::from(b),
                        TermPattern::Literal(l) => Term::from(l),
                    };

                    let triple_enc = [
                        get_term_encoding_string(&s_term),
                        get_term_encoding_string(&p_term),
                        get_term_encoding_string(&o_term),
                        get_graph_encoding_string(&GraphName::DefaultGraph),
                    ];
                    bgp_triples.push(triple_enc);
                }
            }
        }
        _ => return Err("Non-solution query not supported here".into()),
    }

    // Placeholder Merkle fields
    let paths: Vec<[String; 11]> = (0..bgp_triples.len())
        .map(|_| core::array::from_fn(|_| "0x0".to_string()))
        .collect();
    let direction: Vec<[String; 10]> = (0..bgp_triples.len())
        .map(|_| core::array::from_fn(|_| "0x00".to_string()))
        .collect();

    let out = BindingOutput {
        variables: vars,
        assignments,
        bgp_triples,
        paths,
        direction,
    };
    fs::write(out_path, serde_json::to_string_pretty(&out)?)?;
    Ok(())
}
