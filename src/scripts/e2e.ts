#!/usr/bin/env node
/**
 * e2e.ts - End-to-end test for SPARQL Noir pipeline
 * 
 * Tests the complete workflow:
 * 1. Sign RDF data with Merkle tree + signature
 * 2. Transform SPARQL query to Noir circuit
 * 3. Compile the generated circuit
 * 4. Generate ZK proofs for query results
 * 5. Verify the proofs
 */
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { Command } from 'commander';

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
const circuitDir = path.join(outputDir, 'circuit');
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

function runCommand(command: string, description: string): TestResult {
  const start = Date.now();
  log(`Starting: ${description}`);
  logVerbose(`Command: ${command}`);
  
  try {
    const output = execSync(command, { 
      cwd: rootDir, 
      encoding: 'utf8',
      stdio: opts.verbose ? 'inherit' : 'pipe'
    });
    const duration = Date.now() - start;
    log(`✓ ${description} (${(duration / 1000).toFixed(2)}s)`);
    return { step: description, success: true, duration, output: output?.toString() };
  } catch (err) {
    const duration = Date.now() - start;
    const error = (err as Error).message || String(err);
    log(`✗ ${description} failed`);
    console.error(error);
    return { step: description, success: false, duration, error };
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

  // Step 1: Sign RDF data
  results.push(runCommand(
    `node dist/scripts/sign.js -i "${dataPath}" -o "${signedPath}"`,
    'Sign RDF data'
  ));
  if (!results[results.length - 1]!.success) {
    printSummary(testStart);
    process.exit(1);
  }

  // Step 2: Transform SPARQL to Noir circuit
  const query = fs.readFileSync(queryPath, 'utf8').replace(/\n/g, ' ');
  results.push(runCommand(
    `cargo run --manifest-path transform/Cargo.toml -- -i "${dataPath}" -o "${outputDir}/transform.json" -q "${query}"`,
    'Transform SPARQL to Noir'
  ));
  if (!results[results.length - 1]!.success) {
    printSummary(testStart);
    process.exit(1);
  }

  // Step 3: Compile the circuit (circuit is generated in noir_prove/)
  results.push(runCommand(
    `cd noir_prove && nargo compile`,
    'Compile Noir circuit'
  ));
  if (!results[results.length - 1]!.success) {
    printSummary(testStart);
    process.exit(1);
  }

  // Step 4: Generate proofs
  results.push(runCommand(
    `node dist/scripts/prove.js -c noir_prove -s "${signedPath}" -o "${proofPath}"`,
    'Generate ZK proofs'
  ));
  if (!results[results.length - 1]!.success) {
    printSummary(testStart);
    process.exit(1);
  }

  // Step 5: Verify proofs
  results.push(runCommand(
    `node dist/scripts/verify.js -i "${proofPath}" -c noir_prove`,
    'Verify ZK proofs'
  ));

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
