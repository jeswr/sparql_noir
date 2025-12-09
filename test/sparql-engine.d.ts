/**
 * SPARQL Engine adapter for rdf-test-suite
 *
 * This implements the IQueryEngine interface to test sparql_noir's
 * SPARQL parsing and circuit generation capabilities.
 *
 * Usage with rdf-test-suite:
 *   npx rdf-test-suite ./dist/test/sparql-engine.js \
 *     https://w3c.github.io/rdf-tests/sparql/sparql11/manifest-all.ttl \
 *     -c .rdf-test-suite-cache -e -t syntax
 */
import * as RDF from '@rdfjs/types';
declare class QueryResultBoolean {
    readonly value: boolean;
    readonly type: "boolean";
    constructor(value: boolean);
    equals(that: {
        type: string;
        value?: boolean;
    }): boolean;
    toString(): string;
}
declare class QueryResultBindings {
    readonly variables: string[];
    readonly value: {
        [variable: string]: RDF.Term;
    }[];
    readonly type: "bindings";
    readonly checkOrder = false;
    constructor(variables: string[], value: {
        [variable: string]: RDF.Term;
    }[]);
    equals(that: {
        type: string;
        value?: unknown[];
    }, _laxCardinality?: boolean): boolean;
    toString(): string;
}
declare class QueryResultQuads {
    readonly value: RDF.Quad[];
    readonly type: "quads";
    constructor(value: RDF.Quad[]);
    equals(that: {
        type: string;
        value?: RDF.Quad[];
    }): boolean;
    toString(): string;
}
type IQueryResult = QueryResultBoolean | QueryResultBindings | QueryResultQuads;
/**
 * sparql_noir SPARQL Engine for rdf-test-suite
 *
 * This engine tests the Rust transform's ability to parse and process
 * SPARQL queries. It does NOT execute queries against data - it only
 * validates that the query can be converted to a Noir circuit.
 */
declare class SparqlNoirEngine {
    /**
     * Parse a SPARQL query to validate its syntax.
     * Uses the Rust transform to check if the query can be processed.
     */
    parse(queryString: string, _options?: {
        [key: string]: unknown;
    }): Promise<void>;
    /**
     * Execute a SPARQL query against the given data.
     *
     * Note: sparql_noir is a ZK proof system, not a traditional query engine.
     * This method validates the query can be processed and returns placeholder results.
     */
    query(data: RDF.Quad[], queryString: string, _options?: {
        [key: string]: unknown;
    }): Promise<IQueryResult>;
}
declare const engine: SparqlNoirEngine;
export default engine;
export { SparqlNoirEngine };
//# sourceMappingURL=sparql-engine.d.ts.map