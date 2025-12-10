#!/usr/bin/env npx tsx
/**
 * Circuit Test Runner
 * 
 * Runs the generated circuit tests by:
 * 1. Transforming queries to Noir circuits
 * 2. Compiling circuits with nargo
 * 3. Executing checkBinding with valid inputs (should pass)
 * 4. Executing checkBinding with invalid inputs (should fail)
 * 
 * Usage:
 *   npx tsx test/run-circuit-tests.ts              # Run all tests
 *   npx tsx test/run-circuit-tests.ts -t bgp       # Run tests matching pattern
 *   npx tsx test/run-circuit-tests.ts -c bind      # Run tests in category
 *   npx tsx test/run-circuit-tests.ts --compile-only # Only compile, don't run
 */

import { Command } from 'commander';
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { serializeProve } from '../src/serializeProve.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(PROJECT_ROOT, 'test', 'circuits', 'sparql11');
const TRANSFORM_PATH = path.join(PROJECT_ROOT, 'transform', 'target', 'release', 'transform');
const CIRCUITS_OUTPUT = path.join(PROJECT_ROOT, 'test', 'circuits', 'compiled');

interface TestResult {
  name: string;
  category: string;
  transformed: boolean;
  compiled: boolean;
  validInputsPassed: number;
  validInputsFailed: number;
  invalidInputsPassed: number;  // These SHOULD fail
  invalidInputsFailed: number;  // These SHOULD fail (so passing is bad)
  errors: string[];
}

const program = new Command();

program
  .name('run-circuit-tests')
  .description('Run circuit validity tests')
  .option('-t, --test <pattern>', 'Filter tests by pattern')
  .option('-c, --category <name>', 'Only run tests in category', 'all')
  .option('--compile-only', 'Only compile circuits, do not run tests')
  .option('--skip-compile', 'Skip compilation, assume circuits are already compiled')
  .option('-v, --verbose', 'Verbose output')
  .option('--max <n>', 'Maximum tests to run', '20')
  .option('--parallel <n>', 'Number of parallel compilations', '4')
  .parse();

const opts = program.opts();

/**
 * Ensure transform binary is built
 */
function ensureTransformBuilt(): void {
  if (!fs.existsSync(TRANSFORM_PATH)) {
    console.log('Building transform binary...');
    execSync('cargo build --release', {
      cwd: path.join(PROJECT_ROOT, 'transform'),
      stdio: opts.verbose ? 'inherit' : 'pipe',
    });
  }
}

/**
 * List all test directories
 */
function listTests(): Array<{ name: string; category: string; path: string }> {
  const tests: Array<{ name: string; category: string; path: string }> = [];
  
  if (!fs.existsSync(TESTS_DIR)) {
    return tests;
  }
  
  const categories = fs.readdirSync(TESTS_DIR).filter(f => 
    fs.statSync(path.join(TESTS_DIR, f)).isDirectory()
  );
  
  for (const category of categories) {
    if (opts.category !== 'all' && category !== opts.category) continue;
    
    const categoryDir = path.join(TESTS_DIR, category);
    const testDirs = fs.readdirSync(categoryDir).filter(f =>
      fs.statSync(path.join(categoryDir, f)).isDirectory()
    );
    
    for (const testName of testDirs) {
      const testPath = path.join(categoryDir, testName);
      
      // Filter by pattern if specified
      if (opts.test) {
        const pattern = new RegExp(opts.test, 'i');
        if (!pattern.test(testName)) continue;
      }
      
      tests.push({ name: testName, category, path: testPath });
    }
  }
  
  return tests;
}

/**
 * Transform a query to a Noir circuit
 */
function transformQuery(testPath: string, outputDir: string): { success: boolean; error?: string } {
  const queryPath = path.join(testPath, 'query.rq');
  
  if (!fs.existsSync(queryPath)) {
    return { success: false, error: 'query.rq not found' };
  }
  
  fs.mkdirSync(outputDir, { recursive: true });
  
  // Transform outputs to noir_prove/ in PROJECT_ROOT, not to outputDir
  const result = spawnSync(TRANSFORM_PATH, ['-q', queryPath], {
    encoding: 'utf-8',
    timeout: 30000,
    cwd: PROJECT_ROOT,
  });
  
  if (result.status !== 0) {
    return { success: false, error: result.stderr || result.stdout };
  }
  
  // Copy generated files from noir_prove/ to outputDir
  const noirProveDir = path.join(PROJECT_ROOT, 'noir_prove');
  const srcDir = path.join(noirProveDir, 'src');
  
  try {
    // Copy metadata.json
    const metadataFile = path.join(noirProveDir, 'metadata.json');
    if (fs.existsSync(metadataFile)) {
      fs.copyFileSync(metadataFile, path.join(outputDir, 'metadata.json'));
    }
    
    // Copy and fix Nargo.toml - update relative paths to point to PROJECT_ROOT/noir/lib
    const nargoFile = path.join(noirProveDir, 'Nargo.toml');
    if (fs.existsSync(nargoFile)) {
      let nargoContent = fs.readFileSync(nargoFile, 'utf-8');
      // Replace relative paths with absolute paths to noir/lib
      const noirLibPath = path.join(PROJECT_ROOT, 'noir', 'lib');
      nargoContent = nargoContent.replace(
        /path = "\.\.\/noir\/lib\/(\w+)"/g,
        `path = "${noirLibPath}/$1"`
      );
      fs.writeFileSync(path.join(outputDir, 'Nargo.toml'), nargoContent);
    }
    
    // Copy src directory
    const destSrcDir = path.join(outputDir, 'src');
    fs.mkdirSync(destSrcDir, { recursive: true });
    if (fs.existsSync(srcDir)) {
      for (const file of fs.readdirSync(srcDir)) {
        fs.copyFileSync(path.join(srcDir, file), path.join(destSrcDir, file));
      }
    }
  } catch (err) {
    return { success: false, error: `Failed to copy files: ${err}` };
  }
  
  return { success: true };
}

/**
 * Compile a Noir circuit
 */
function compileCircuit(circuitDir: string): { success: boolean; error?: string } {
  const result = spawnSync('nargo', ['compile'], {
    cwd: circuitDir,
    encoding: 'utf-8',
    timeout: 120000,  // 2 minutes for compilation
  });
  
  if (result.status !== 0) {
    return { success: false, error: result.stderr || result.stdout };
  }
  
  return { success: true };
}

/**
 * Execute a circuit with given inputs
 */
function executeCircuit(
  circuitDir: string, 
  inputs: Record<string, unknown>
): { success: boolean; error?: string } {
  // Write Prover.toml using the existing serializeProve function
  const proverToml = path.join(circuitDir, 'Prover.toml');
  const tomlContent = serializeProve(inputs as any);
  fs.writeFileSync(proverToml, tomlContent);
  
  const result = spawnSync('nargo', ['execute'], {
    cwd: circuitDir,
    encoding: 'utf-8',
    timeout: 60000,
  });
  
  if (result.status !== 0) {
    return { success: false, error: result.stderr || result.stdout };
  }
  
  return { success: true };
}

/**
 * Run a single test
 */
async function runTest(test: { name: string; category: string; path: string }): Promise<TestResult> {
  const result: TestResult = {
    name: test.name,
    category: test.category,
    transformed: false,
    compiled: false,
    validInputsPassed: 0,
    validInputsFailed: 0,
    invalidInputsPassed: 0,
    invalidInputsFailed: 0,
    errors: [],
  };
  
  const circuitDir = path.join(CIRCUITS_OUTPUT, test.category, test.name);
  
  // Step 1: Transform query to circuit
  if (!opts.skipCompile) {
    if (opts.verbose) console.log(`  Transforming ${test.name}...`);
    
    const transformResult = transformQuery(test.path, circuitDir);
    if (!transformResult.success) {
      result.errors.push(`Transform failed: ${transformResult.error}`);
      return result;
    }
    result.transformed = true;
    
    // Step 2: Compile circuit
    if (opts.verbose) console.log(`  Compiling ${test.name}...`);
    
    const compileResult = compileCircuit(circuitDir);
    if (!compileResult.success) {
      result.errors.push(`Compile failed: ${compileResult.error}`);
      return result;
    }
    result.compiled = true;
  } else {
    result.transformed = true;
    result.compiled = fs.existsSync(path.join(circuitDir, 'target'));
  }
  
  if (opts.compileOnly) {
    return result;
  }
  
  // Step 3: Run valid inputs (should all pass)
  const validInputsDir = path.join(test.path, 'valid_inputs');
  if (fs.existsSync(validInputsDir)) {
    const inputFiles = fs.readdirSync(validInputsDir).filter(f => f.endsWith('.json'));
    
    for (const inputFile of inputFiles) {
      const inputPath = path.join(validInputsDir, inputFile);
      
      try {
        const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
        
        // Check if this has full checkBinding inputs
        if (!inputData.bgp || !inputData.variables || !inputData.public_key || !inputData.roots) {
          if (opts.verbose) console.log(`    Skipping ${inputFile}: missing required inputs (bgp/variables/public_key/roots)`);
          continue;
        }
        
        if (opts.verbose) console.log(`    Running valid input: ${inputFile}...`);
        
        const execResult = executeCircuit(circuitDir, {
          public_key: inputData.public_key,
          roots: inputData.roots,
          bgp: inputData.bgp,
          variables: inputData.variables,
          hidden: inputData.hidden || {},
        });
        
        if (execResult.success) {
          result.validInputsPassed++;
        } else {
          result.validInputsFailed++;
          if (opts.verbose) {
            console.log(`      FAILED: ${execResult.error?.slice(0, 200)}`);
          }
        }
      } catch (err) {
        result.errors.push(`Error reading ${inputFile}: ${err}`);
      }
    }
  }
  
  // Step 4: Run invalid inputs (should all fail - so passing means the test caught the error)
  const invalidInputsDir = path.join(test.path, 'invalid_inputs');
  if (fs.existsSync(invalidInputsDir)) {
    const inputFiles = fs.readdirSync(invalidInputsDir).filter(f => f.endsWith('.json'));
    
    for (const inputFile of inputFiles) {
      const inputPath = path.join(invalidInputsDir, inputFile);
      
      try {
        const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
        
        if (!inputData.bgp || !inputData.variables || !inputData.public_key || !inputData.roots) {
          continue;
        }
        
        if (opts.verbose) console.log(`    Running invalid input: ${inputFile}...`);
        
        const execResult = executeCircuit(circuitDir, {
          public_key: inputData.public_key,
          roots: inputData.roots,
          bgp: inputData.bgp,
          variables: inputData.variables,
          hidden: inputData.hidden || {},
        });
        
        if (!execResult.success) {
          // Circuit correctly rejected invalid input
          result.invalidInputsPassed++;
        } else {
          // Circuit incorrectly accepted invalid input
          result.invalidInputsFailed++;
          if (opts.verbose) {
            console.log(`      UNEXPECTED PASS: invalid input was accepted`);
          }
        }
      } catch (err) {
        result.errors.push(`Error reading ${inputFile}: ${err}`);
      }
    }
  }
  
  return result;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Circuit Test Runner');
  console.log('='.repeat(60));
  console.log();
  
  // Ensure transform is built
  ensureTransformBuilt();
  
  // List tests
  const tests = listTests();
  const maxTests = parseInt(opts.max, 10);
  const testsToRun = tests.slice(0, maxTests);
  
  console.log(`Found ${tests.length} tests, running ${testsToRun.length}`);
  console.log();
  
  // Run tests
  const results: TestResult[] = [];
  
  for (const test of testsToRun) {
    console.log(`[${test.category}/${test.name}]`);
    const result = await runTest(test);
    results.push(result);
    
    // Print summary
    if (result.errors.length > 0) {
      console.log(`  ❌ ${result.errors[0]}`);
    } else if (opts.compileOnly) {
      console.log(`  ✅ Compiled`);
    } else {
      const validStatus = result.validInputsFailed === 0 && result.validInputsPassed > 0
        ? '✅' : (result.validInputsPassed === 0 ? '⚠️' : '❌');
      console.log(`  ${validStatus} Valid: ${result.validInputsPassed} passed, ${result.validInputsFailed} failed`);
      
      if (result.invalidInputsPassed + result.invalidInputsFailed > 0) {
        const invalidStatus = result.invalidInputsFailed === 0 ? '✅' : '❌';
        console.log(`  ${invalidStatus} Invalid: ${result.invalidInputsPassed} rejected, ${result.invalidInputsFailed} wrongly accepted`);
      }
    }
  }
  
  // Print summary
  console.log();
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  
  const transformed = results.filter(r => r.transformed).length;
  const compiled = results.filter(r => r.compiled).length;
  const totalValidPassed = results.reduce((sum, r) => sum + r.validInputsPassed, 0);
  const totalValidFailed = results.reduce((sum, r) => sum + r.validInputsFailed, 0);
  const totalInvalidPassed = results.reduce((sum, r) => sum + r.invalidInputsPassed, 0);
  const totalInvalidFailed = results.reduce((sum, r) => sum + r.invalidInputsFailed, 0);
  
  console.log(`Transformed: ${transformed}/${results.length}`);
  console.log(`Compiled: ${compiled}/${results.length}`);
  
  if (!opts.compileOnly) {
    console.log(`Valid inputs: ${totalValidPassed} passed, ${totalValidFailed} failed`);
    console.log(`Invalid inputs: ${totalInvalidPassed} rejected, ${totalInvalidFailed} wrongly accepted`);
  }
  
  // Exit with error if any tests failed
  if (totalValidFailed > 0 || totalInvalidFailed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
