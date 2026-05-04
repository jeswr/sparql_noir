/**
 * Per-feature classification for SPARQL conformance tests.
 *
 * Each W3C test is bucketed by a single dominant feature (the "headline"
 * algebra construct it exercises) plus a list of all features observed,
 * so the report can emit both the §8.2 paper table (one row per feature)
 * and a per-test feature multiset.
 *
 * Classification is by inspection of the parsed algebra — not by
 * manifest-URL substring — so it stays accurate when test names drift.
 */

import { translate, Util, Algebra } from 'sparqlalgebrajs';

export type Feature =
  | 'BGP'
  | 'Filter'
  | 'Optional'
  | 'Union'
  | 'Minus'
  | 'Graph'
  | 'Path'
  | 'Bind'
  | 'Values'
  | 'Aggregate'
  | 'OrderBy'
  | 'Distinct'
  | 'Slice'
  | 'Construct'
  | 'Describe'
  | 'Ask'
  | 'Service'
  | 'Subquery'
  | 'Project';

export interface ClassificationResult {
  /** Single dominant feature for §8.2 aggregation. */
  headline: Feature;
  /** All features observed in the algebra tree. */
  all: Feature[];
}

/**
 * The headline ordering: the first feature in this list that appears in
 * the algebra is the test's dominant feature. Constructs that compose
 * the algebra (Project / Distinct / Slice etc.) are deliberately last
 * so a `SELECT DISTINCT { ?s :p ?o }` is classified as BGP, not Distinct.
 */
const HEADLINE_PRIORITY: Feature[] = [
  'Service',
  'Construct',
  'Describe',
  'Aggregate',
  'Subquery',
  'Path',
  'Minus',
  'Optional',
  'Union',
  'Graph',
  'Values',
  'Bind',
  'Filter',
  'OrderBy',
  'Distinct',
  'Slice',
  'Ask',
  'BGP',
  'Project',
];

/**
 * Classify a SPARQL query string by walking its algebra.
 * Returns `null` if the query cannot be parsed.
 */
export function classifyQuery(
  queryString: string,
  baseIRI?: string,
): ClassificationResult | null {
  let algebra: Algebra.Operation;
  try {
    algebra = translate(queryString, baseIRI ? { baseIRI } : {});
  } catch {
    return null;
  }

  const observed = new Set<Feature>();

  Util.recurseOperation(algebra, {
    bgp: (op: Algebra.Bgp) => {
      if (op.patterns.length > 0) observed.add('BGP');
      return true;
    },
    filter: () => {
      observed.add('Filter');
      return true;
    },
    leftjoin: () => {
      observed.add('Optional');
      return true;
    },
    union: () => {
      observed.add('Union');
      return true;
    },
    minus: () => {
      observed.add('Minus');
      return true;
    },
    graph: () => {
      observed.add('Graph');
      return true;
    },
    path: () => {
      observed.add('Path');
      return true;
    },
    extend: () => {
      observed.add('Bind');
      return true;
    },
    values: () => {
      observed.add('Values');
      return true;
    },
    group: () => {
      observed.add('Aggregate');
      return true;
    },
    orderby: () => {
      observed.add('OrderBy');
      return true;
    },
    distinct: () => {
      observed.add('Distinct');
      return true;
    },
    slice: () => {
      observed.add('Slice');
      return true;
    },
    construct: () => {
      observed.add('Construct');
      return true;
    },
    describe: () => {
      observed.add('Describe');
      return true;
    },
    ask: () => {
      observed.add('Ask');
      return true;
    },
    service: () => {
      observed.add('Service');
      return true;
    },
    project: () => {
      observed.add('Project');
      return true;
    },
  });

  // Subquery detection: Project nested under a non-Project operation.
  // sparqlalgebrajs surfaces inner SELECTs as nested PROJECT nodes.
  let projectDepth = 0;
  const visit = (op: Algebra.Operation): void => {
    if ((op as { type?: string }).type === 'project') {
      projectDepth += 1;
      if (projectDepth >= 2) observed.add('Subquery');
    }
    const children = (op as { input?: Algebra.Operation | Algebra.Operation[] }).input;
    if (Array.isArray(children)) {
      for (const c of children) visit(c);
    } else if (children) {
      visit(children);
    }
  };
  visit(algebra);

  let headline: Feature = 'BGP';
  for (const f of HEADLINE_PRIORITY) {
    if (observed.has(f)) {
      headline = f;
      break;
    }
  }

  // If nothing was observed at all (rare — empty WHERE), tag as BGP.
  if (observed.size === 0) observed.add('BGP');

  return { headline, all: [...observed] };
}
