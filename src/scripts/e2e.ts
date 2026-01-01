#!/usr/bin/env node
/**
 * e2e.ts - End-to-end test for SPARQL Noir pipeline
 * 
 * Tests the complete workflow using the index.ts API:
 * 1. Sign RDF data with Merkle tree + signature
 * 2. Generate ZK proofs for query results (includes transform + compile)
 * 3. Verify the proofs
 */
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import N3 from 'n3';
import { sign, prove, verify } from '../index.js';

const program = new Command();

program
  .name('e2e')
  .description('End-to-end test for SPARQL Noir pipeline')
  .option('-d, --data <path>', 'Input RDF data file', 'inputs/data/data.ttl')
  .option('-q, --query <path>', 'SPARQL query file', 'inputs/sparql.rq')
  .option('-o, --output <dir>', 'Output directory for test artifacts', 'temp/e2e')
  .option('--keep', 'Keep intermediate files after test')
  .option('-v, --verbose', 'Verbose output')
  .parse();

const opts = program.opts<{
  data: string;
  query: string;
  output: string;
  keep?: boolean;
  verbose?: boolean;
}>();

// Resolve paths
const rootDir = process.cwd();
const dataPath = path.resolve(rootDir, opts.data);
const queryPath = path.resolve(rootDir, opts.query);
const outputDir = path.resolve(rootDir, opts.output);
const signedPath = path.join(outputDir, 'signed.json');
const proofPath = path.join(outputDir, 'proof.json');

interface TestResult {
  step: string;
  success: boolean;
  duration: number;
  output?: string;
  error?: string;
}

const results: TestResult[] = [];

function log(message: string) {
  console.log(`[E2E] ${message}`);
}

function logVerbose(message: string) {
  if (opts.verbose) {
    console.log(`[E2E:DEBUG] ${message}`);
  }
}

async function runStep<T>(
  description: string,
  fn: () => Promise<T>
): Promise<{ result: TestResult; value?: T }> {
  const start = Date.now();
  log(`Starting: ${description}`);
  
  try {
    const value = await fn();
    const duration = Date.now() - start;
    log(`✓ ${description} (${(duration / 1000).toFixed(2)}s)`);
    return { 
      result: { step: description, success: true, duration }, 
      value 
    };
  } catch (err) {
    const duration = Date.now() - start;
    const error = (err as Error).message || String(err);
    log(`✗ ${description} failed`);
    console.error(error);
    return { 
      result: { step: description, success: false, duration, error } 
    };
  }
}

async function main() {
  const testStart = Date.now();
  
  console.log('\n========================================');
  console.log('SPARQL Noir E2E Test');
  console.log('========================================\n');
  
  // Validate inputs
  if (!fs.existsSync(dataPath)) {
    console.error(`Error: Data file not found: ${dataPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(queryPath)) {
    console.error(`Error: Query file not found: ${queryPath}`);
    process.exit(1);
  }
  
  log(`Data: ${dataPath}`);
  log(`Query: ${queryPath}`);
  log(`Output: ${outputDir}`);
  console.log('');

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  // Load RDF data into N3 store
  const rdfData = fs.readFileSync(dataPath, 'utf8');
  const parser = new N3.Parser();
  const store = new N3.Store();
  store.addQuads(parser.parse(rdfData));

  // Load SPARQL query
  const query = fs.readFileSync(queryPath, 'utf8');
  logVerbose(`Query: ${query}`);

  // Step 1: Sign RDF data using index.ts API
  const signResult = await runStep('Sign RDF data', async () => {
    const signedData = await sign(store);
    // Save signed data for inspection
    fs.writeFileSync(signedPath, JSON.stringify(signedData, null, 2));
    logVerbose(`Signed data saved to: ${signedPath}`);
    return signedData;
  });
  results.push(signResult.result);
  if (!signResult.result.success || !signResult.value) {
    printSummary(testStart);
    process.exit(1);
  }
  const signedData = signResult.value;

  // Step 2: Generate proofs using index.ts API (includes transform + compile)
  const proveResult = await runStep('Generate ZK proofs', async () => {
    const proofResult = await prove(query, signedData);
    // Save proof for inspection
    fs.writeFileSync(proofPath, JSON.stringify(proofResult, (_, v) => 
      v instanceof Uint8Array ? Array.from(v) : v
    , 2));
    logVerbose(`Proof saved to: ${proofPath}`);
    return proofResult;
  });
  results.push(proveResult.result);
  if (!proveResult.result.success || !proveResult.value) {
    printSummary(testStart);
    process.exit(1);
  }
  const proofResult = proveResult.value;

  // Step 3: Verify proofs using index.ts API
  const verifyResult = await runStep('Verify ZK proofs', async () => {
    const result = await verify(proofResult);
    logVerbose(`Verification result: ${JSON.stringify(result)}`);
    if (!result.success) {
      throw new Error(`Verification failed: ${result.errors?.join(', ')}`);
    }
    return result;
  });
  results.push(verifyResult.result);

  // Print summary
  printSummary(testStart);

  // Cleanup if requested
  if (!opts.keep) {
    logVerbose('Keeping intermediate files (use --no-keep to remove)');
  }

  // Exit with appropriate code
  const allPassed = results.every(r => r.success);
  process.exit(allPassed ? 0 : 1);
}

function printSummary(testStart: number) {
  const totalDuration = Date.now() - testStart;
  
  console.log('\n========================================');
  console.log('Test Summary');
  console.log('========================================\n');
  
  for (const result of results) {
    const status = result.success ? '✓' : '✗';
    const time = (result.duration / 1000).toFixed(2);
    console.log(`${status} ${result.step}: ${time}s`);
  }
  
  console.log('');
  const passed = results.filter(r => r.success).length;
  const total = results.length;
  console.log(`Total: ${passed}/${total} steps passed`);
  console.log(`Duration: ${(totalDuration / 1000).toFixed(2)}s`);
  
  if (passed === total) {
    console.log('\n✓ All E2E tests passed!\n');
  } else {
    console.log('\n✗ E2E tests failed!\n');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
