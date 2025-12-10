#!/usr/bin/env npx tsx
/**
 * SPARQL 1.1 Test Suite Data Generator
 * 
 * Downloads the W3C SPARQL 1.1 test suite and generates positive test patterns
 * by extracting queries, their associated datasets, and expected bindings.
 * 
 * The output is used to create circuit validity tests that verify:
 * - Valid inputs (matching the expected bindings) pass the circuit
 * - Invalid inputs (synthetic negative tests) fail the circuit
 * 
 * The generator creates:
 * - query.rq: The SPARQL query
 * - data.ttl: The RDF dataset
 * - expected_bindings.json: Expected variable bindings
 * - metadata.json: Circuit metadata (patterns, variables, hidden inputs)
 * - signed_data.json: Signed RDF data with merkle proofs
 * - valid_inputs/*.json: Complete checkBinding inputs (BGP, Variables, Hidden)
 * 
 * Usage:
 *   npx tsx test/generate-circuit-tests.ts           # Generate all supported tests
 *   npx tsx test/generate-circuit-tests.ts --list    # List available tests
 *   npx tsx test/generate-circuit-tests.ts -t bgp    # Generate only BGP tests
 *   npx tsx test/generate-circuit-tests.ts --dry-run # Preview without writing files
 *   npx tsx test/generate-circuit-tests.ts --full    # Generate full checkBinding inputs
 */

import { Command } from 'commander';
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import N3 from 'n3';
import dereferenceToStore from 'rdf-dereference-store';
import {
  signDataInMemory,
  transformQueryInMemory,
  generateCheckBindingInputs,
  type SignedData,
  type CircuitMetadata,
  type CheckBindingInputs,
} from './lib/check-binding-inputs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'test', 'circuits', 'sparql11');
const CACHE_DIR = path.join(PROJECT_ROOT, '.rdf-test-suite-cache');
const TRANSFORM_PATH = path.join(PROJECT_ROOT, 'transform', 'target', 'release', 'transform');

// SPARQL 1.1 test manifest URLs
// Uses raw github content for reliability
const SPARQL11_BASE = 'https://raw.githubusercontent.com/w3c/rdf-tests/main/sparql/sparql11';
const SPARQL10_BASE = 'https://raw.githubusercontent.com/w3c/rdf-tests/main/sparql/sparql10';

const SPARQL11_MANIFESTS: Record<string, string> = {
  // SPARQL 1.1 Query evaluation tests (these have data + expected results)
  'aggregates': `${SPARQL11_BASE}/aggregates/manifest.ttl`,
  'bind': `${SPARQL11_BASE}/bind/manifest.ttl`,
  'bindings': `${SPARQL11_BASE}/bindings/manifest.ttl`,
  'construct': `${SPARQL11_BASE}/construct/manifest.ttl`,
  'exists': `${SPARQL11_BASE}/exists/manifest.ttl`,
  'functions': `${SPARQL11_BASE}/functions/manifest.ttl`,
  'grouping': `${SPARQL11_BASE}/grouping/manifest.ttl`,
  'negation': `${SPARQL11_BASE}/negation/manifest.ttl`,
  'project-expression': `${SPARQL11_BASE}/project-expression/manifest.ttl`,
  'property-path': `${SPARQL11_BASE}/property-path/manifest.ttl`,
  'service': `${SPARQL11_BASE}/service/manifest.ttl`,
  'subquery': `${SPARQL11_BASE}/subquery/manifest.ttl`,
  
  // SPARQL 1.0 tests - individual categories
  'sparql10-basic': `${SPARQL10_BASE}/basic/manifest.ttl`,
  'sparql10-triple-match': `${SPARQL10_BASE}/triple-match/manifest.ttl`,
  'sparql10-optional': `${SPARQL10_BASE}/optional/manifest.ttl`,
  'sparql10-optional-filter': `${SPARQL10_BASE}/optional-filter/manifest.ttl`,
  'sparql10-algebra': `${SPARQL10_BASE}/algebra/manifest.ttl`,
  'sparql10-expr-equals': `${SPARQL10_BASE}/expr-equals/manifest.ttl`,
  'sparql10-expr-ops': `${SPARQL10_BASE}/expr-ops/manifest.ttl`,
  'sparql10-distinct': `${SPARQL10_BASE}/distinct/manifest.ttl`,
  'sparql10-sort': `${SPARQL10_BASE}/sort/manifest.ttl`,
};

// Categories we can process (have data + bindings, no unsupported features)
const SUPPORTED_CATEGORIES = [
  'bind',
  'bindings',
  'property-path',
  'sparql10-basic',
  'sparql10-triple-match',
  'sparql10-optional',
  'sparql10-algebra',
  'sparql10-expr-equals',
  'sparql10-distinct',
];

// RDF namespaces
const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const QT = 'http://www.w3.org/2001/sw/DataAccess/tests/test-query#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

interface TestCase {
  name: string;
  comment?: string;
  queryUrl: string;
  dataUrl?: string;
  resultUrl?: string;
  type: string;
  category: string;
}

interface ProcessedTest {
  name: string;
  query: string;
  data: string;
  bindings: Array<Record<string, string>>;
  variables: string[];
  // Full checkBinding inputs (when --full flag is used)
  metadata?: CircuitMetadata;
  signedData?: SignedData;
  checkBindingInputs?: Array<CheckBindingInputs | null>;
}

const program = new Command();

program
  .name('generate-circuit-tests')
  .description('Generate circuit validity tests from SPARQL 1.1 test suite')
  .option('-t, --test <pattern>', 'Filter tests by pattern')
  .option('-c, --category <name>', 'Only process specific category', 'all')
  .option('--list', 'List available tests without generating')
  .option('--dry-run', 'Preview what would be generated')
  .option('--force', 'Overwrite existing test files')
  .option('-v, --verbose', 'Verbose output')
  .option('--max <n>', 'Maximum tests to process', '100')
  .option('--full', 'Generate full checkBinding inputs (BGP, Variables, Hidden)')
  .parse();

const opts = program.opts();

/**
 * Fetch and cache a URL
 */
async function fetchWithCache(url: string): Promise<string> {
  const cacheKey = Buffer.from(url).toString('base64').replace(/[/+=]/g, '_');
  const cachePath = path.join(CACHE_DIR, cacheKey);
  
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf-8');
  }
  
  if (opts.verbose) {
    console.log(`  Fetching: ${url}`);
  }
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const text = await response.text();
    fs.writeFileSync(cachePath, text);
    return text;
  } catch (err) {
    throw new Error(`Failed to fetch ${url}: ${err}`);
  }
}

/**
 * Parse a manifest file and extract test cases
 */
async function parseManifest(manifestUrl: string, category: string): Promise<TestCase[]> {
  const content = await fetchWithCache(manifestUrl);
  const store = new N3.Store();
  const parser = new N3.Parser({ baseIRI: manifestUrl });
  
  try {
    const quads = parser.parse(content);
    store.addQuads(quads);
  } catch (err) {
    console.error(`  Error parsing manifest: ${err}`);
    return [];
  }
  
  const tests: TestCase[] = [];
  
  // Find all test entries (mf:entries contains a list of tests)
  const entriesQuads = store.getQuads(null, N3.DataFactory.namedNode(MF + 'entries'), null, null);
  
  for (const entryQuad of entriesQuads) {
    // Parse RDF list
    const testUris = parseRdfList(store, entryQuad.object);
    
    for (const testUri of testUris) {
      const test = extractTestCase(store, testUri, category, manifestUrl);
      if (test) {
        tests.push(test);
      }
    }
  }
  
  return tests;
}

/**
 * Parse an RDF list into an array of terms
 */
function parseRdfList(store: N3.Store, listHead: N3.Term): N3.Term[] {
  const items: N3.Term[] = [];
  let current = listHead;
  const NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';
  
  while (current.value !== NIL) {
    const firstQuads = store.getQuads(current, N3.DataFactory.namedNode(RDF + 'first'), null, null);
    const restQuads = store.getQuads(current, N3.DataFactory.namedNode(RDF + 'rest'), null, null);
    
    if (firstQuads.length > 0) {
      items.push(firstQuads[0].object);
    }
    
    if (restQuads.length > 0) {
      current = restQuads[0].object;
    } else {
      break;
    }
  }
  
  return items;
}

/**
 * Extract test case details from a test URI
 */
function extractTestCase(store: N3.Store, testUri: N3.Term, category: string, baseUrl: string): TestCase | null {
  // Get test type
  const typeQuads = store.getQuads(testUri, N3.DataFactory.namedNode(RDF + 'type'), null, null);
  if (typeQuads.length === 0) return null;
  
  const testType = typeQuads[0].object.value;
  
  // We only care about QueryEvaluationTest (has data + expected results)
  if (!testType.includes('QueryEvaluationTest') && !testType.includes('PositiveSyntaxTest')) {
    return null;
  }
  
  // Get test name
  const nameQuads = store.getQuads(testUri, N3.DataFactory.namedNode(MF + 'name'), null, null);
  const name = nameQuads.length > 0 ? nameQuads[0].object.value : path.basename(testUri.value);
  
  // Get comment/description
  const commentQuads = store.getQuads(testUri, N3.DataFactory.namedNode(RDFS + 'comment'), null, null);
  const comment = commentQuads.length > 0 ? commentQuads[0].object.value : undefined;
  
  // Get action (contains query and data)
  const actionQuads = store.getQuads(testUri, N3.DataFactory.namedNode(MF + 'action'), null, null);
  if (actionQuads.length === 0) return null;
  
  const action = actionQuads[0].object;
  
  let queryUrl: string | undefined;
  let dataUrl: string | undefined;
  
  // Helper to resolve relative URLs
  const resolveUrl = (url: string): string => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    // Resolve relative to manifest base
    const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
    return baseDir + url;
  };
  
  if (action.termType === 'NamedNode') {
    // Simple case: action is directly the query URL
    queryUrl = resolveUrl(action.value);
  } else {
    // Complex case: action is a blank node with query/data properties
    const queryQuads = store.getQuads(action, N3.DataFactory.namedNode(QT + 'query'), null, null);
    const dataQuads = store.getQuads(action, N3.DataFactory.namedNode(QT + 'data'), null, null);
    
    if (queryQuads.length > 0) {
      queryUrl = resolveUrl(queryQuads[0].object.value);
    }
    if (dataQuads.length > 0) {
      dataUrl = resolveUrl(dataQuads[0].object.value);
    }
  }
  
  if (!queryUrl) return null;
  
  // Get expected result
  const resultQuads = store.getQuads(testUri, N3.DataFactory.namedNode(MF + 'result'), null, null);
  const resultUrl = resultQuads.length > 0 ? resolveUrl(resultQuads[0].object.value) : undefined;
  
  return {
    name,
    comment,
    queryUrl,
    dataUrl,
    resultUrl,
    type: testType,
    category,
  };
}

/**
 * Check if a query is supported by our transform
 */
async function isQuerySupported(query: string): Promise<{ supported: boolean; error?: string }> {
  if (!fs.existsSync(TRANSFORM_PATH)) {
    // Try building
    try {
      execSync('cargo build --release', {
        cwd: path.join(PROJECT_ROOT, 'transform'),
        stdio: 'pipe',
      });
    } catch {
      return { supported: false, error: 'Transform binary not built' };
    }
  }
  
  try {
    const result = spawnSync(TRANSFORM_PATH, ['-q', query], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    
    if (result.status === 0) {
      return { supported: true };
    }
    
    return { supported: false, error: result.stderr || result.stdout };
  } catch (err: any) {
    return { supported: false, error: err.message };
  }
}

/**
 * Parse SPARQL results file (XML or JSON format)
 */
async function parseResults(resultUrl: string): Promise<{ variables: string[]; bindings: Array<Record<string, string>> } | null> {
  try {
    const content = await fetchWithCache(resultUrl);
    
    // Try to detect format
    if (content.trim().startsWith('<?xml') || content.trim().startsWith('<sparql')) {
      return parseXmlResults(content);
    } else if (content.trim().startsWith('{')) {
      return parseJsonResults(content);
    } else if (content.includes('\t') || resultUrl.endsWith('.tsv')) {
      return parseTsvResults(content);
    } else if (content.includes('rs:ResultSet') || content.includes('result-set#') || 
               resultUrl.endsWith('.ttl') || resultUrl.endsWith('.rdf')) {
      return parseRdfResults(content);
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse SPARQL results in RDF format (rs:ResultSet vocabulary)
 */
function parseRdfResults(turtle: string): { variables: string[]; bindings: Array<Record<string, string>> } | null {
  try {
    const store = new N3.Store();
    const parser = new N3.Parser();
    const quads = parser.parse(turtle);
    store.addQuads(quads);
    
    const RS = 'http://www.w3.org/2001/sw/DataAccess/tests/result-set#';
    
    // Find resultVariable declarations
    const variables: string[] = [];
    const varQuads = store.getQuads(null, N3.DataFactory.namedNode(RS + 'resultVariable'), null, null);
    for (const q of varQuads) {
      variables.push(q.object.value);
    }
    
    // Find solutions
    const bindings: Array<Record<string, string>> = [];
    const solutionQuads = store.getQuads(null, N3.DataFactory.namedNode(RS + 'solution'), null, null);
    
    for (const solQuad of solutionQuads) {
      const solution = solQuad.object;
      const binding: Record<string, string> = {};
      
      // Find bindings in this solution
      const bindingQuads = store.getQuads(solution, N3.DataFactory.namedNode(RS + 'binding'), null, null);
      
      for (const bQuad of bindingQuads) {
        const bindingNode = bQuad.object;
        
        // Get variable name
        const varQuads = store.getQuads(bindingNode, N3.DataFactory.namedNode(RS + 'variable'), null, null);
        const varName = varQuads.length > 0 ? varQuads[0].object.value : null;
        
        // Get value
        const valueQuads = store.getQuads(bindingNode, N3.DataFactory.namedNode(RS + 'value'), null, null);
        
        if (varName && valueQuads.length > 0) {
          const valueNode = valueQuads[0].object;
          
          if (valueNode.termType === 'NamedNode') {
            binding[varName] = `<${valueNode.value}>`;
          } else if (valueNode.termType === 'BlankNode') {
            binding[varName] = `_:${valueNode.value}`;
          } else if (valueNode.termType === 'Literal') {
            const lit = valueNode as N3.Literal;
            if (lit.language) {
              binding[varName] = `"${lit.value}"@${lit.language}`;
            } else if (lit.datatype && lit.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
              binding[varName] = `"${lit.value}"^^<${lit.datatype.value}>`;
            } else {
              binding[varName] = `"${lit.value}"`;
            }
          }
        }
      }
      
      if (Object.keys(binding).length > 0) {
        bindings.push(binding);
      }
    }
    
    return { variables, bindings };
  } catch (err) {
    return null;
  }
}

/**
 * Parse SPARQL XML results format
 */
function parseXmlResults(xml: string): { variables: string[]; bindings: Array<Record<string, string>> } | null {
  const variables: string[] = [];
  const bindings: Array<Record<string, string>> = [];
  
  // Extract variables
  const varMatches = xml.matchAll(/<variable\s+name="([^"]+)"/g);
  for (const match of varMatches) {
    variables.push(match[1]);
  }
  
  // Extract bindings
  const resultMatches = xml.matchAll(/<result>([\s\S]*?)<\/result>/g);
  for (const resultMatch of resultMatches) {
    const binding: Record<string, string> = {};
    const bindingMatches = resultMatch[1].matchAll(/<binding\s+name="([^"]+)">\s*<(uri|literal|bnode)[^>]*>([^<]*)<\/(uri|literal|bnode)>\s*<\/binding>/g);
    
    for (const bMatch of bindingMatches) {
      const varName = bMatch[1];
      const termType = bMatch[2];
      const value = bMatch[3];
      
      if (termType === 'uri') {
        binding[varName] = `<${value}>`;
      } else if (termType === 'bnode') {
        binding[varName] = `_:${value}`;
      } else {
        binding[varName] = `"${value}"`;
      }
    }
    
    if (Object.keys(binding).length > 0) {
      bindings.push(binding);
    }
  }
  
  return { variables, bindings };
}

/**
 * Parse SPARQL JSON results format
 */
function parseJsonResults(json: string): { variables: string[]; bindings: Array<Record<string, string>> } | null {
  try {
    const data = JSON.parse(json);
    const variables = data.head?.vars || [];
    const bindings: Array<Record<string, string>> = [];
    
    for (const result of data.results?.bindings || []) {
      const binding: Record<string, string> = {};
      for (const [varName, termObj] of Object.entries(result)) {
        const term = termObj as { type: string; value: string };
        if (term.type === 'uri') {
          binding[varName] = `<${term.value}>`;
        } else if (term.type === 'bnode') {
          binding[varName] = `_:${term.value}`;
        } else {
          binding[varName] = `"${term.value}"`;
        }
      }
      if (Object.keys(binding).length > 0) {
        bindings.push(binding);
      }
    }
    
    return { variables, bindings };
  } catch {
    return null;
  }
}

/**
 * Parse TSV results format
 */
function parseTsvResults(tsv: string): { variables: string[]; bindings: Array<Record<string, string>> } | null {
  const lines = tsv.trim().split('\n');
  if (lines.length < 1) return null;
  
  const variables = lines[0].split('\t').map(v => v.replace('?', ''));
  const bindings: Array<Record<string, string>> = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t');
    const binding: Record<string, string> = {};
    
    for (let j = 0; j < variables.length && j < values.length; j++) {
      const value = values[j].trim();
      if (value) {
        binding[variables[j]] = value;
      }
    }
    
    if (Object.keys(binding).length > 0) {
      bindings.push(binding);
    }
  }
  
  return { variables, bindings };
}

/**
 * Process a test case and generate circuit test files
 */
async function processTestCase(test: TestCase): Promise<ProcessedTest | null> {
  if (opts.verbose) {
    console.log(`  Processing: ${test.name}`);
  }
  
  // Fetch query
  let query: string;
  try {
    query = await fetchWithCache(test.queryUrl);
  } catch (err) {
    if (opts.verbose) console.log(`    Skip: Could not fetch query`);
    return null;
  }
  
  // Check if query is supported
  const supported = await isQuerySupported(query);
  if (!supported.supported) {
    if (opts.verbose) console.log(`    Skip: Query not supported - ${supported.error?.slice(0, 100)}`);
    return null;
  }
  
  // Fetch data (if any)
  let data = '';
  if (test.dataUrl) {
    try {
      data = await fetchWithCache(test.dataUrl);
    } catch {
      // Use empty data
      data = '';
    }
  }
  
  // Fetch and parse results
  let bindings: Array<Record<string, string>> = [];
  let variables: string[] = [];
  
  if (test.resultUrl) {
    const results = await parseResults(test.resultUrl);
    if (results) {
      bindings = results.bindings;
      variables = results.variables;
    }
  }
  
  // Extract variables from query if not in results
  if (variables.length === 0) {
    const varMatches = query.match(/SELECT\s+(DISTINCT\s+)?(.+?)\s+(WHERE|FROM|\{)/is);
    if (varMatches) {
      const varsStr = varMatches[2];
      if (varsStr.trim() !== '*') {
        const vars = varsStr.match(/\?\w+/g);
        if (vars) {
          variables = vars.map(v => v.slice(1)); // Remove ?
        }
      }
    }
  }
  
  const result: ProcessedTest = {
    name: test.name,
    query,
    data,
    bindings,
    variables,
  };
  
  // Generate full checkBinding inputs if --full flag is set
  if (opts.full && data && bindings.length > 0) {
    try {
      if (opts.verbose) console.log(`    Generating full checkBinding inputs...`);
      
      // Transform query to get metadata
      const metadata = await transformQueryInMemory(query);
      result.metadata = metadata;
      
      // Sign data to get encoded triples with merkle proofs
      const signedData = await signDataInMemory(data);
      result.signedData = signedData;
      
      // Generate checkBinding inputs for each binding
      const checkBindingInputs: Array<CheckBindingInputs | null> = [];
      for (const binding of bindings) {
        const inputs = generateCheckBindingInputs(metadata, signedData, binding);
        checkBindingInputs.push(inputs);
      }
      result.checkBindingInputs = checkBindingInputs;
      
      if (opts.verbose) {
        const validCount = checkBindingInputs.filter(x => x !== null).length;
        console.log(`    Generated ${validCount}/${bindings.length} valid checkBinding inputs`);
      }
    } catch (err) {
      if (opts.verbose) {
        console.log(`    Warning: Could not generate full inputs: ${err}`);
      }
      // Continue without full inputs
    }
  }
  
  return result;
}

/**
 * Generate test files for a processed test
 */
function generateTestFiles(test: ProcessedTest, category: string): void {
  const safeName = test.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const testDir = path.join(OUTPUT_DIR, category, safeName);
  
  if (fs.existsSync(testDir) && !opts.force) {
    if (opts.verbose) console.log(`    Skip: ${testDir} exists (use --force to overwrite)`);
    return;
  }
  
  const hasFullInputs = test.checkBindingInputs && test.checkBindingInputs.some(x => x !== null);
  
  if (opts.dryRun) {
    console.log(`  Would create: ${testDir}/`);
    console.log(`    - query.rq`);
    console.log(`    - data.ttl`);
    console.log(`    - expected_bindings.json`);
    if (hasFullInputs) {
      console.log(`    - metadata.json`);
      console.log(`    - signed_data.json`);
    }
    console.log(`    - valid_inputs/ (${test.bindings.length} binding sets)`);
    return;
  }
  
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(path.join(testDir, 'valid_inputs'), { recursive: true });
  fs.mkdirSync(path.join(testDir, 'invalid_inputs'), { recursive: true });
  
  // Write query
  fs.writeFileSync(path.join(testDir, 'query.rq'), test.query);
  
  // Write data
  fs.writeFileSync(path.join(testDir, 'data.ttl'), test.data || '# Empty dataset');
  
  // Write expected bindings
  fs.writeFileSync(path.join(testDir, 'expected_bindings.json'), JSON.stringify({
    variables: test.variables,
    bindings: test.bindings,
  }, null, 2));
  
  // Write metadata if available
  if (test.metadata) {
    fs.writeFileSync(path.join(testDir, 'metadata.json'), JSON.stringify(test.metadata, null, 2));
  }
  
  // Write signed data if available
  if (test.signedData) {
    fs.writeFileSync(path.join(testDir, 'signed_data.json'), JSON.stringify(test.signedData, null, 2));
  }
  
  // Generate valid input files (one per binding)
  for (let i = 0; i < test.bindings.length; i++) {
    const binding = test.bindings[i];
    const inputPath = path.join(testDir, 'valid_inputs', `case_${i + 1}.json`);
    
    // If we have full checkBinding inputs, include them
    if (test.checkBindingInputs && test.checkBindingInputs[i] && test.signedData) {
      const checkInputs = test.checkBindingInputs[i]!;
      const signedData = test.signedData;
      
      // Build roots array with value and signature
      const roots = [{
        value: signedData.root,
        signature: signedData.signature,
      }];
      
      fs.writeFileSync(inputPath, JSON.stringify({
        description: `Valid binding ${i + 1} from SPARQL 1.1 test suite`,
        binding: binding,
        // Full circuit inputs
        public_key: [signedData.pubKey],
        roots: roots,
        bgp: checkInputs.bgp,
        variables: checkInputs.variables,
      }, null, 2));
    } else {
      // Fallback: just save the binding
      fs.writeFileSync(inputPath, JSON.stringify({
        description: `Valid binding ${i + 1} from SPARQL 1.1 test suite`,
        variables: binding,
      }, null, 2));
    }
  }
  
  // Placeholder for invalid inputs (to be generated synthetically)
  fs.writeFileSync(
    path.join(testDir, 'invalid_inputs', 'README.md'),
    '# Invalid Inputs\n\nThese will be synthetically generated.\n'
  );
  
  const fullInputCount = test.checkBindingInputs?.filter(x => x !== null).length || 0;
  const inputDesc = hasFullInputs 
    ? `${fullInputCount}/${test.bindings.length} full inputs` 
    : `${test.bindings.length} bindings`;
  
  console.log(`  Created: ${safeName}/ (${inputDesc})`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('SPARQL 1.1 Test Suite - Circuit Test Generator');
  console.log('='.repeat(60));
  console.log();
  
  // Determine categories to process
  let categories = SUPPORTED_CATEGORIES;
  if (opts.category !== 'all') {
    if (!SPARQL11_MANIFESTS[opts.category as keyof typeof SPARQL11_MANIFESTS]) {
      console.error(`Unknown category: ${opts.category}`);
      console.error(`Available: ${Object.keys(SPARQL11_MANIFESTS).join(', ')}`);
      process.exit(1);
    }
    categories = [opts.category];
  }
  
  let totalTests = 0;
  let processedTests = 0;
  const maxTests = parseInt(opts.max, 10);
  
  for (const category of categories) {
    const manifestUrl = SPARQL11_MANIFESTS[category as keyof typeof SPARQL11_MANIFESTS];
    if (!manifestUrl) continue;
    
    console.log(`\n[${category}] Fetching manifest...`);
    
    const tests = await parseManifest(manifestUrl, category);
    console.log(`  Found ${tests.length} tests`);
    
    if (opts.list) {
      for (const test of tests) {
        console.log(`    - ${test.name} (${test.type.split('#').pop()})`);
      }
      continue;
    }
    
    // Filter tests if pattern specified
    let filteredTests = tests;
    if (opts.test) {
      const pattern = new RegExp(opts.test, 'i');
      filteredTests = tests.filter(t => pattern.test(t.name));
      console.log(`  Filtered to ${filteredTests.length} tests`);
    }
    
    for (const test of filteredTests) {
      if (processedTests >= maxTests) {
        console.log(`\nReached max tests limit (${maxTests})`);
        break;
      }
      
      totalTests++;
      const processed = await processTestCase(test);
      
      if (processed) {
        generateTestFiles(processed, category);
        processedTests++;
      }
    }
    
    if (processedTests >= maxTests) break;
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`Summary: ${processedTests} tests generated out of ${totalTests} examined`);
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
