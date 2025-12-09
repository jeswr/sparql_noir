#!/usr/bin/env npx tsx
/**
 * Simple SPARQL Parsing Test
 * 
 * This script tests the Rust transform's ability to parse SPARQL queries.
 * It runs a set of test queries and reports which ones parse successfully.
 * 
 * Usage:
 *   npx tsx test/test-sparql-parsing.ts
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TRANSFORM_PATH = path.join(PROJECT_ROOT, 'transform/target/release/transform');

// Test queries organized by feature
const TEST_QUERIES: Record<string, string[]> = {
  'Basic Graph Pattern (BGP)': [
    `SELECT ?s ?p ?o WHERE { ?s ?p ?o }`,
    `SELECT ?x WHERE { ?x <http://example.org/p> <http://example.org/o> }`,
    `SELECT ?s WHERE { ?s <http://xmlns.com/foaf/0.1/name> "Alice" }`,
  ],
  
  'Multiple Triple Patterns': [
    `SELECT ?x ?y WHERE { ?x <http://example.org/knows> ?y . ?y <http://example.org/name> ?n }`,
    `SELECT ?s ?name WHERE { ?s a <http://example.org/Person> . ?s <http://example.org/name> ?name }`,
  ],
  
  'UNION': [
    `SELECT ?x WHERE { { ?x <http://example.org/p1> ?y } UNION { ?x <http://example.org/p2> ?y } }`,
    `SELECT ?s WHERE { { ?s a <http://example.org/Cat> } UNION { ?s a <http://example.org/Dog> } }`,
  ],
  
  'OPTIONAL': [
    `SELECT ?x ?y WHERE { ?x <http://example.org/p> ?y . OPTIONAL { ?x <http://example.org/q> ?z } }`,
    `SELECT ?s ?name ?email WHERE { ?s <http://example.org/name> ?name . OPTIONAL { ?s <http://example.org/email> ?email } }`,
  ],
  
  'FILTER (equality)': [
    `SELECT ?x WHERE { ?x <http://example.org/value> ?v FILTER(?v = 42) }`,
    `SELECT ?s WHERE { ?s <http://example.org/name> ?n FILTER(?n = "Alice") }`,
    `SELECT ?x ?y WHERE { ?x <http://example.org/p> ?y FILTER(?x = ?y) }`,
  ],
  
  'FILTER (comparison)': [
    `SELECT ?x WHERE { ?x <http://example.org/age> ?a FILTER(?a > 18) }`,
    `SELECT ?x WHERE { ?x <http://example.org/value> ?v FILTER(?v >= 10 && ?v <= 100) }`,
    `SELECT ?x WHERE { ?x <http://example.org/score> ?s FILTER(?s != 0) }`,
  ],
  
  'FILTER (functions)': [
    `SELECT ?x WHERE { ?x <http://example.org/name> ?n FILTER(STRLEN(?n) > 5) }`,
    `SELECT ?x WHERE { ?x <http://example.org/p> ?v FILTER(isURI(?v)) }`,
    `SELECT ?x WHERE { ?x <http://example.org/p> ?v FILTER(BOUND(?v)) }`,
  ],
  
  'BIND': [
    `SELECT ?x ?doubled WHERE { ?x <http://example.org/value> ?v BIND(?v * 2 AS ?doubled) }`,
    `SELECT ?s ?label WHERE { ?s <http://example.org/name> ?n BIND(CONCAT("Name: ", ?n) AS ?label) }`,
  ],
  
  'Property Paths (sequence /)': [
    `SELECT ?x ?z WHERE { ?x <http://example.org/knows>/<http://example.org/name> ?z }`,
    `SELECT ?s ?o WHERE { ?s <http://example.org/p>/<http://example.org/q>/<http://example.org/r> ?o }`,
  ],
  
  'Property Paths (alternative |)': [
    `SELECT ?x ?y WHERE { ?x <http://example.org/p1>|<http://example.org/p2> ?y }`,
  ],
  
  'Property Paths (inverse ^)': [
    `SELECT ?x ?y WHERE { ?x ^<http://example.org/parent> ?y }`,
  ],
  
  'Property Paths (one or more +)': [
    `SELECT ?x ?y WHERE { ?x <http://example.org/knows>+ ?y }`,
  ],
  
  'Property Paths (zero or more *)': [
    `SELECT ?x ?y WHERE { ?x <http://example.org/knows>* ?y }`,
  ],
  
  'Property Paths (optional ?)': [
    `SELECT ?x ?y WHERE { ?x <http://example.org/knows>? ?y }`,
  ],
  
  'DISTINCT': [
    `SELECT DISTINCT ?x WHERE { ?x <http://example.org/p> ?y }`,
  ],
  
  'ORDER BY': [
    `SELECT ?x ?v WHERE { ?x <http://example.org/value> ?v } ORDER BY ?v`,
    `SELECT ?x ?v WHERE { ?x <http://example.org/value> ?v } ORDER BY DESC(?v)`,
  ],
  
  'LIMIT/OFFSET': [
    `SELECT ?x WHERE { ?x <http://example.org/p> ?y } LIMIT 10`,
    `SELECT ?x WHERE { ?x <http://example.org/p> ?y } LIMIT 10 OFFSET 5`,
  ],
  
  // Features expected NOT to work (for completeness)
  'GROUP BY (unsupported)': [
    `SELECT ?x (COUNT(?y) AS ?cnt) WHERE { ?x <http://example.org/p> ?y } GROUP BY ?x`,
  ],
  
  'HAVING (unsupported)': [
    `SELECT ?x (COUNT(?y) AS ?cnt) WHERE { ?x <http://example.org/p> ?y } GROUP BY ?x HAVING(COUNT(?y) > 5)`,
  ],
  
  'Subqueries (unsupported)': [
    `SELECT ?x WHERE { ?x <http://example.org/p> ?y { SELECT ?y WHERE { ?y a <http://example.org/Thing> } } }`,
  ],
  
  'VALUES (unsupported)': [
    `SELECT ?x WHERE { VALUES ?x { <http://example.org/a> <http://example.org/b> } ?x <http://example.org/p> ?y }`,
  ],
  
  'SERVICE (unsupported)': [
    `SELECT ?x WHERE { SERVICE <http://example.org/sparql> { ?x <http://example.org/p> ?y } }`,
  ],
  
  'MINUS (unsupported)': [
    `SELECT ?x WHERE { ?x <http://example.org/p> ?y MINUS { ?x <http://example.org/q> ?z } }`,
  ],
  
  'EXISTS (unsupported)': [
    `SELECT ?x WHERE { ?x <http://example.org/p> ?y FILTER EXISTS { ?x <http://example.org/q> ?z } }`,
  ],
  
  'NOT EXISTS (unsupported)': [
    `SELECT ?x WHERE { ?x <http://example.org/p> ?y FILTER NOT EXISTS { ?x <http://example.org/q> ?z } }`,
  ],
  
  'CONSTRUCT (unsupported)': [
    `CONSTRUCT { ?s <http://example.org/newProp> ?o } WHERE { ?s <http://example.org/oldProp> ?o }`,
  ],
  
  'DESCRIBE (unsupported)': [
    `DESCRIBE <http://example.org/resource>`,
  ],
  
  'ASK': [
    `ASK { ?x <http://example.org/p> ?y }`,
  ],
};

interface TestResult {
  feature: string;
  query: string;
  success: boolean;
  error?: string;
}

async function testQuery(query: string): Promise<{ success: boolean; error?: string }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-parse-test-'));
  
  try {
    const dataPath = path.join(tempDir, 'data.ttl');
    const outputPath = path.join(tempDir, 'output.json');
    
    fs.writeFileSync(dataPath, '<http://example.org/s> <http://example.org/p> <http://example.org/o> .');
    
    // The transform uses -i for input, -o for output, -q for query string
    execSync(`"${TRANSFORM_PATH}" -i "${dataPath}" -o "${outputPath}" -q "${query.replace(/"/g, '\\"')}"`, {
      cwd: PROJECT_ROOT,
      timeout: 30000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    return { success: true };
  } catch (err: any) {
    const stderr = err.stderr || err.message || 'Unknown error';
    return { success: false, error: stderr.slice(0, 200) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('SPARQL Parsing Test - sparql_noir Rust Transform');
  console.log('='.repeat(70));
  console.log();
  
  // Check transform binary
  if (!fs.existsSync(TRANSFORM_PATH)) {
    console.error(`Error: Transform binary not found at ${TRANSFORM_PATH}`);
    console.error('Run: cd transform && cargo build --release');
    process.exit(1);
  }
  
  const results: TestResult[] = [];
  const summary: Record<string, { passed: number; total: number }> = {};
  
  for (const [feature, queries] of Object.entries(TEST_QUERIES)) {
    console.log(`\n## ${feature}`);
    console.log('-'.repeat(50));
    
    summary[feature] = { passed: 0, total: queries.length };
    
    for (const query of queries) {
      const result = await testQuery(query);
      
      results.push({
        feature,
        query: query.slice(0, 60) + (query.length > 60 ? '...' : ''),
        success: result.success,
        error: result.error
      });
      
      if (result.success) {
        summary[feature].passed++;
        console.log(`  ✓ ${query.slice(0, 50)}...`);
      } else {
        console.log(`  ✗ ${query.slice(0, 50)}...`);
        console.log(`    Error: ${result.error?.slice(0, 100)}`);
      }
    }
  }
  
  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  
  let totalPassed = 0;
  let totalTests = 0;
  
  for (const [feature, { passed, total }] of Object.entries(summary)) {
    totalPassed += passed;
    totalTests += total;
    const status = passed === total ? '✓' : (passed > 0 ? '~' : '✗');
    console.log(`  ${status} ${feature}: ${passed}/${total}`);
  }
  
  console.log('\n' + '-'.repeat(70));
  console.log(`Total: ${totalPassed}/${totalTests} queries parsed successfully`);
  console.log(`Pass rate: ${((totalPassed / totalTests) * 100).toFixed(1)}%`);
  
  // Features with full support
  const fullSupport = Object.entries(summary)
    .filter(([_, { passed, total }]) => passed === total && !_.includes('unsupported'))
    .map(([feature]) => feature);
  
  const partialSupport = Object.entries(summary)
    .filter(([_, { passed, total }]) => passed > 0 && passed < total && !_.includes('unsupported'))
    .map(([feature]) => feature);
  
  const noSupport = Object.entries(summary)
    .filter(([_, { passed }]) => passed === 0 && !_.includes('unsupported'))
    .map(([feature]) => feature);
  
  console.log('\n' + '='.repeat(70));
  console.log('FEATURE SUPPORT');
  console.log('='.repeat(70));
  
  if (fullSupport.length > 0) {
    console.log('\n✓ Full Support:');
    fullSupport.forEach(f => console.log(`  • ${f}`));
  }
  
  if (partialSupport.length > 0) {
    console.log('\n~ Partial Support:');
    partialSupport.forEach(f => console.log(`  • ${f}`));
  }
  
  if (noSupport.length > 0) {
    console.log('\n✗ Not Working:');
    noSupport.forEach(f => console.log(`  • ${f}`));
  }
}

main().catch(console.error);
