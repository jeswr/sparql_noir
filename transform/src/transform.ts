import { Store, Term, Variable } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { matchTerm } from 'rdf-terms';
import { Algebra, Factory, Util, toSparql, translate } from 'sparqlalgebrajs';
import { v4 as uuidv4 } from 'uuid';
import { QueryEngine } from "@comunica/query-sparql";
import { SparqlOperator } from "@comunica/utils-expression-evaluator";

interface Options {
  /**
   * The maximum depth of the path expression to be processed.
   */
  maxDepth: number;
}

const factory = new Factory();

/**
 * Generate a unique variable name for use in SPARQL operations
 * @returns A unique variable name prefixed with 'v' followed by a UUID
 */
function generateVariable(): string {
  return 'v' + uuidv4().replace(/-/g, '');
}

/**
 * Convert a path expression to a Basic Graph Pattern (BGP), join, or union operation
 * @param subject - The subject term of the path
 * @param path - The path expression or term to convert
 * @param object - The object term of the path
 * @returns A BGP, join, or union operation representing the path
 * @throws Error for unsupported path expression types
 */
function pathToBgp(subject: Term, path: Algebra.PropertyPathSymbol, object: Term, options: Options): Algebra.Operation {
  // Handle PathExpression cases
  switch (path.type) {
    case Algebra.types.LINK:
      return factory.createBgp([
        factory.createPattern(subject, path.iri, object, DataFactory.defaultGraph())
      ]);
    case Algebra.types.INV:
      return pathToBgp(object, path.path, subject, options);
    case Algebra.types.SEQ:
      let s = subject;
      const joins: Algebra.Operation[] = [];
      for (let j = 0; j < path.input.length; j++) {
        const o = j === path.input.length - 1 ? object : DataFactory.variable(generateVariable());
        joins.push(pathToBgp(s, path.input[j], o, options));
        s = o;
      }
      return factory.createJoin(joins);
    case Algebra.types.ONE_OR_MORE_PATH:
  // Degrade to exactly one occurrence to align with current metadata planner.
  return pathToBgp(subject, path.path, object, options);
    case Algebra.types.ZERO_OR_MORE_PATH:
  // Degrade to zero-or-one occurrence for now.
  return pathToBgp(subject, factory.createZeroOrOnePath(path.path), object, options);
    case Algebra.types.ALT:
      // TODO: Future - reduce the number of variables created by the alt case. For instance
      // using a VALUES call on any 'link' paths
      return factory.createUnion(path.input.map(input => pathToBgp(subject, input, object, options)));
    case Algebra.types.ZERO_OR_ONE_PATH:
      let extend: Algebra.Extend;
      if (subject.termType === 'Variable') {
        if (object.termType === 'Variable') {
          console.warn('ZeroOrOnePath with two variables, using BIND - bugs exist if object not bound at this stage');
        }

        // The commented out filter was an attempt to ensure the subject is bound, 
        // but it over filters because it checks that it is bound within scope of the
        // extedn
        extend = factory.createExtend(
          // factory.createFilter(
            factory.createBgp([]),
          //   factory.createOperatorExpression(
          //     SparqlOperator.BOUND,
          //     [factory.createTermExpression(object)]
          //   )
          // ),
          subject,
          factory.createTermExpression(object)
        );
      } else if (object.termType === 'Variable') {
        extend = factory.createExtend(
          // factory.createFilter(
            factory.createBgp([]),
          //   factory.createOperatorExpression(
          //     SparqlOperator.BOUND,
          //     [factory.createTermExpression(subject)]
          //   )
          // ),
          object,
          factory.createTermExpression(subject)
        );
      } else if (subject.equals(object)) {
        return factory.createNop();
      } else {
        return pathToBgp(subject, path.path, object, options);
      }
      return factory.createUnion([
        pathToBgp(subject, path.path, object, options),
        extend
      ]);
    default:
      throw new Error(`Unsupported path expression: ${path.type}`);
  }
}

/**
 * Recursively replace PATH operations with equivalent BGP/Join/Union trees before mapping.
 */
function normalizePaths(op: Algebra.Operation, options: Options): Algebra.Operation {
  switch (op.type) {
    case Algebra.types.PATH:
      return pathToBgp(op.subject, op.predicate, op.object, options);
    case Algebra.types.PROJECT:
      return factory.createProject(normalizePaths(op.input, options), op.variables);
    case Algebra.types.JOIN:
      return factory.createJoin(op.input.map(child => normalizePaths(child, options)));
    case Algebra.types.UNION:
      return factory.createUnion(op.input.map(child => normalizePaths(child, options)));
    case Algebra.types.FILTER:
      return factory.createFilter(normalizePaths(op.input, options), op.expression);
    case Algebra.types.EXTEND:
      return factory.createExtend(normalizePaths(op.input, options), op.variable, op.expression);
    case Algebra.types.SLICE:
      return factory.createSlice(normalizePaths(op.input, options), op.start, op.length);
    case Algebra.types.ORDER_BY:
      return factory.createOrderBy(normalizePaths(op.input, options), op.expressions);
    case Algebra.types.REDUCED:
      return factory.createReduced(normalizePaths(op.input, options));
    case Algebra.types.DISTINCT:
      return factory.createDistinct(normalizePaths(op.input, options));
    case Algebra.types.GROUP:
      return factory.createGroup(normalizePaths(op.input, options), op.variables, op.aggregates);
    case Algebra.types.SERVICE:
      return factory.createService(normalizePaths(op.input, options), op.name, op.silent);
    default:
      return op;
  }
}

/**
 * Convert a triple pattern to an extend operation that includes the triple as a result variable
 * @param variables - Array of variables to which the new triple variable will be added
 * @param pattern - The triple pattern to convert
 * @returns An extend operation that includes the triple pattern as a variable
 */
function toExtend(patternMap: Map<string, Algebra.Pattern>, variables: Variable[], pattern: Algebra.Pattern): any {
  const variable = DataFactory.variable(generateVariable());
  variables.push(variable);

  let { subject, predicate, object } = pattern;

  // Convert blank nodes to variables
  if (subject.termType === 'BlankNode') {
    subject = DataFactory.variable(generateVariable());
  }
  if (object.termType === 'BlankNode') {
    object = DataFactory.variable(generateVariable());
  }
  
  patternMap.set(variable.value, pattern);

  // Create a TRIPLE expression to represent the triple
  return factory.createExtend(
    factory.createBgp([factory.createPattern(subject, predicate, object, DataFactory.defaultGraph())]),
    variable,
    factory.createOperatorExpression(
      'triple',
      [termToExpression(subject), termToExpression(predicate), termToExpression(object)]
    )        
  );
}

/**
 * Convert a term to an expression
 */
function termToExpression(term: Term): Algebra.TermExpression {
  return factory.createTermExpression(term);
}

/**
 * Convert a BGP to joins of extended patterns
 */
function convertBgp(patternMap: Map<string, Algebra.Pattern>, variables: Variable[], patterns: Algebra.Pattern[]): any {
  if (patterns.length === 0) {
    return factory.createBgp([]); // No patterns to convert, return a no-operation
    // throw new Error('Empty BGP');
  }

  return patterns.slice(1).reduce((result, pattern) => {
    return factory.createJoin([result, toExtend(patternMap, variables, pattern)]);
  }, toExtend(patternMap, variables, patterns[0]));
}

/**
 * Transform a SPARQL query to include triples as result variables
 * @param algebra - The SPARQL algebra operation to transform
 * @returns The transformed operation with triples included as result variables
 * @throws Error if the operation is not a SELECT query (project operation)
 */
export function transformQuery(algebra: Algebra.Operation, options?: Partial<Options>): {
  algebra: Algebra.Operation;
  patternMap: Map<string, Algebra.Pattern>;
} {
  if (algebra.type !== 'project') {
    throw new Error('Only SELECT queries (project operations) are supported');
  }

  const patternMap = new Map<string, Algebra.Pattern>();

  const norm = normalizePaths(algebra, { maxDepth: options?.maxDepth ?? 10 });

  const resultAlgebra = Util.mapOperation(norm, {
    bgp: (bgp) => ({
      result: convertBgp(patternMap, algebra.variables, bgp.patterns),
      recurse: false,
    }),
    // paths already normalized
    // join: (op) => {
    //   // for any consectuive set of paths and bgps in the input
    //   // put the paths before the BGPS
    //   const inputOperations: Algebra.Operation[] = [];
    //   let paths: Algebra.Path[] = [];
    //   let bgps: Algebra.Bgp[] = [];
    //   for (const input of op.input) {
    //     if (input.type === Algebra.types.PATH) {
    //       paths.push(input);
    //     } else if (input.type === Algebra.types.BGP) {
    //       bgps.push(input);
    //     } else {
    //       inputOperations.push(
    //         ...bgps,
    //         ...paths,
    //       );
    //       paths = [];
    //       bgps = [];
    //     }
    //   }
    //   inputOperations.push(
    //     ...bgps,
    //     ...paths,
    //   );
    //   return {
    //     result: factory.createJoin(inputOperations),
    //     recurse: true,
    //   }
    // }
  });

  return {
    algebra: resultAlgebra,
    patternMap: patternMap,
  }
}

export function getBindOrder(patterns: Algebra.Pattern[], map: Map<string, Algebra.Pattern>): string[] {
  return patterns.map(pattern => {
    for (const [key, value] of map.entries()) {
      if (matchTerm(pattern.subject, value.subject) &&
          matchTerm(pattern.predicate, value.predicate) &&
          matchTerm(pattern.object, value.object) &&
          matchTerm(pattern.graph, value.graph)) {
        return key;
      }
    }
    throw new Error(`Pattern not found in map: ${pattern.subject.value} ${pattern.predicate.value} ${pattern.object.value}`);
  })
}

export async function *getBindings(
  query: Algebra.Operation,
  source: Store,
  patternsOrUnion: Algebra.Pattern[] | { branches: Algebra.Pattern[][] }
) {
  // Note: FILTER semantics, including SPARQL datatype handling (DATATYPE, LANG, regex, etc.),
  // are evaluated by Comunica's engine as part of queryBindings(algebra,...). The Noir circuit
  // only asserts structural triple membership and variable equalities. This split keeps the
  // heavy SPARQL semantics out of-circuit while ensuring results align with SPARQL compliance.
  const { algebra, patternMap } = transformQuery(query);

  const bindings = await new QueryEngine().queryBindings(algebra, {
    sources: [source],
  });

  const isUnion = typeof patternsOrUnion === 'object' && patternsOrUnion !== null && Array.isArray((patternsOrUnion as any).branches);
  const branchBindOrders: string[][] = isUnion
    ? (patternsOrUnion as { branches: Algebra.Pattern[][] }).branches.map(branch => getBindOrder(branch, patternMap))
    : [getBindOrder(patternsOrUnion as Algebra.Pattern[], patternMap)];

  for await (let elem of bindings) {
    if (isUnion) {
      let matched = false;
      for (let i = 0; i < branchBindOrders.length && !matched; i++) {
        const order = branchBindOrders[i];
        const bgp: any[] = [];
        let ok = true;
        for (const va of order) {
          const result = elem.get(va);
          if (!result || result.termType !== 'Quad') {
            ok = false;
            break;
          }
          bgp.push(result);
        }
        if (!ok) continue;
        // Remove only variables for the chosen branch
        let pruned = elem;
        for (const va of order) pruned = pruned.delete(va);
        matched = true;
        yield { bgp, bindings: pruned };
      }
      continue;
    }

    const order = branchBindOrders[0];
    const bgp = order.map(va => {
      const result = elem.get(va);
      if (!result) {
        throw new Error(`Variable ${va} not found in bindings`);
      }
      if (result.termType !== 'Quad') {
        throw new Error(`Expected Quad for variable ${va}, got ${result.termType}`);
      }
      return result;
    });
    for (const va of order) {
      elem = elem.delete(va);
    }
    yield {
      bgp,
      bindings: elem,
    }
  }
}
