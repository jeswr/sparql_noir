#!/usr/bin/env npx tsx

/**
 * Test runner for transform snapshot tests
 * 
 * This script runs the Rust transform tests that verify generated Noir code
 * matches expected output. It catches common bugs like:
 * - Variables struct containing non-projected variables
 * - Missing static term assertions (predicates, objects)
 * - Missing filter constraints
 * - IEEE 754 comparisons evaluated at Rust compile time
 * 
 * Usage:
 *   npx tsx test/run-snapshot-tests.ts           # Run all snapshot tests
 *   npx tsx test/run-snapshot-tests.ts --update  # Update expected.nr files from current output
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = resolve(__dirname, 'fixtures');
const TRANSFORM_MANIFEST = resolve(__dirname, '../transform/Cargo.toml');

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

function normalizeWhitespace(s: string): string {
  return s.split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

function runTransform(query: string): string {
  const result = spawnSync('cargo', ['run', '--manifest-path', TRANSFORM_MANIFEST, '--', '-q', query], {
    encoding: 'utf-8',
    cwd: resolve(__dirname, '..'),
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`Transform failed: ${result.stderr || result.stdout}`);
  }

  // Read the generated sparql.nr
  const sparqlNrPath = resolve(__dirname, '../noir_prove/src/sparql.nr');
  if (!existsSync(sparqlNrPath)) {
    throw new Error(`Transform did not generate ${sparqlNrPath}`);
  }
  
  return readFileSync(sparqlNrPath, 'utf-8');
}

function runSnapshotTest(testName: string, updateMode: boolean): TestResult {
  const fixtureDir = join(FIXTURES_DIR, testName);
  const queryPath = join(fixtureDir, 'query.rq');
  const expectedPath = join(fixtureDir, 'expected.nr');

  if (!existsSync(queryPath)) {
    return { name: testName, passed: false, error: `Missing query.rq` };
  }

  const query = readFileSync(queryPath, 'utf-8');
  
  try {
    const actual = runTransform(query);
    const actualNormalized = normalizeWhitespace(actual);

    if (updateMode) {
      writeFileSync(expectedPath, actual);
      return { name: testName, passed: true, error: 'Updated' };
    }

    if (!existsSync(expectedPath)) {
      return { name: testName, passed: false, error: `Missing expected.nr (run with --update to create)` };
    }

    const expected = readFileSync(expectedPath, 'utf-8');
    const expectedNormalized = normalizeWhitespace(expected);

    if (actualNormalized !== expectedNormalized) {
      return {
        name: testName,
        passed: false,
        error: `Output mismatch\n--- Expected ---\n${expected}\n--- Actual ---\n${actual}`
      };
    }

    return { name: testName, passed: true };
  } catch (e: any) {
    return { name: testName, passed: false, error: e.message };
  }
}

function runAllTests(updateMode: boolean): void {
  console.log('Running transform snapshot tests...\n');
  
  if (!existsSync(FIXTURES_DIR)) {
    console.error(`Fixtures directory not found: ${FIXTURES_DIR}`);
    process.exit(1);
  }

  const testDirs = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  if (testDirs.length === 0) {
    console.error('No test fixtures found');
    process.exit(1);
  }

  const results: TestResult[] = [];
  
  for (const testName of testDirs) {
    const result = runSnapshotTest(testName, updateMode);
    results.push(result);
    
    const icon = result.passed ? '✓' : '✗';
    const status = result.passed ? 'passed' : 'FAILED';
    console.log(`${icon} ${testName}: ${status}`);
    
    if (!result.passed && result.error) {
      console.log(`  Error: ${result.error.split('\n')[0]}`);
    }
  }

  console.log('\n---');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Also run the Rust tests for complete coverage
function runRustTests(): void {
  console.log('\nRunning Rust transform tests...\n');
  
  const result = spawnSync('cargo', ['test', '--manifest-path', TRANSFORM_MANIFEST], {
    encoding: 'utf-8',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.error('Rust tests failed');
    process.exit(1);
  }
}

// Main
const args = process.argv.slice(2);
const updateMode = args.includes('--update');
const rustOnly = args.includes('--rust-only');
const tsOnly = args.includes('--ts-only');

if (!tsOnly) {
  runRustTests();
}

if (!rustOnly) {
  runAllTests(updateMode);
}
