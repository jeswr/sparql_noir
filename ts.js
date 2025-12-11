import { ManifestLoader } from 'rdf-test-suite';
import * as fs from 'fs';
import path from 'path';
import { Writer } from 'n3';
import { translate, Util } from 'sparqlalgebrajs';
import { signRdfData, processRdfDataWithoutSigning } from './dist/scripts/sign.js';
import { generateProofs } from './dist/scripts/prove.js';
import { verifyProofs } from './dist/scripts/verify.js';
import { transform as wasmTransform, transform_with_options as wasmTransformWithOptions } from './transform/pkg/transform.js';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import os from 'os';

const __dirname = new URL('.', import.meta.url).pathname;

console.log('Using WASM transform module');

// Parse CLI arguments
const args = process.argv.slice(2);
const witnessOnly = args.includes('--witness-only') || args.includes('-w');
const skipSigning = args.includes('--skip-signing') || args.includes('-s');
const concurrencyArg = args.find(a => a.startsWith('--concurrency=') || a.startsWith('-j'));
const concurrency = concurrencyArg 
  ? parseInt(concurrencyArg.split('=')[1] || concurrencyArg.slice(2), 10) 
  : os.cpus().length;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node ts.js [options]

Options:
  -w, --witness-only      Only generate witness, skip proof generation and verification (faster)
  -s, --skip-signing      Skip signature verification (use simplified circuit, much faster)
  -j<N>, --concurrency=N  Number of parallel tests (default: number of CPUs)
  -h, --help              Show this help message

By default, full proof generation and verification is performed.
`);
  process.exit(0);
}

console.log(`Mode: ${witnessOnly ? 'witness-only' : 'full proof + verification'}${skipSigning ? ' (skip-signing)' : ''}`);
console.log(`Concurrency: ${concurrency} parallel tests\n`);

const loader = new ManifestLoader();

// Use SPARQL 1.0 tests which have basic BGP, OPTIONAL, FILTER tests
const tests = await loader.from("https://w3c.github.io/rdf-tests/sparql/sparql10/manifest.ttl");
const evaluationTests = tests.subManifests.flatMap(test => test.testEntries)
  .filter(test => {
    if (
      !test.types.includes('http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#QueryEvaluationTest') ||
      test.approval !== 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#Approved' ||
      !test.queryString.includes('SELECT')
      // Skip queries with empty results sets
      || test.queryResult.value.length === 0
    ) {
      return false;
    }

    // Check for unsupported SPARQL features in the query string
    const unsupportedPatterns = [
      /\bEXISTS\s*\{/i,
      /\bNOT\s+EXISTS\s*\{/i,
      /\bisNumeric\s*\(/i,
      /\bABS\s*\(/i,
      /\bCONTAINS\s*\(/i,
      /\bSTRSTARTS\s*\(/i,
      /\bSTRENDS\s*\(/i,
      /\bSUBSTR\s*\(/i,
      /\bREPLACE\s*\(/i,
      /\bUCASE\s*\(/i,
      /\bLCASE\s*\(/i,
      /\bENCODE_FOR_URI\s*\(/i,
      /\bCONCAT\s*\(/i,
      /\bROUND\s*\(/i,
      /\bCEIL\s*\(/i,
      /\bFLOOR\s*\(/i,
      /\bRAND\s*\(/i,
      /\bNOW\s*\(/i,
      /\bYEAR\s*\(/i,
      /\bMONTH\s*\(/i,
      /\bDAY\s*\(/i,
      /\bHOURS\s*\(/i,
      /\bMINUTES\s*\(/i,
      /\bSECONDS\s*\(/i,
      /\bTIMEZONE\s*\(/i,
      /\bTZ\s*\(/i,
      /\bMD5\s*\(/i,
      /\bSHA1\s*\(/i,
      /\bSHA256\s*\(/i,
      /\bSHA384\s*\(/i,
      /\bSHA512\s*\(/i,
      /\bCOALESCE\s*\(/i,
      /\bIF\s*\(/i,
      /\bIN\s*\(/i,
      /\bNOT\s+IN\s*\(/i,
      // Additional unsupported functions from error analysis
      /\bLANGMATCHES\s*\(/i,
      /\bLANG\s*\(/i,
      /\bSTR\s*\(/i,
      /\bDATATYPE\s*\(/i,
      /\bIsBLANK\s*\(/i,
      /\bIsIRI\s*\(/i,
      /\bIsURI\s*\(/i,
      /\bIsLITERAL\s*\(/i,

      //
      /\bREGEX\s*\(/i,
      /\bsameTerm\s*\(/i,
      /\bBOUND\s*\(/i,
      // Blank nodes
      /_:/,
      // Special float/double values that Noir doesn't support
      /\bNaN\b/i,
      /\bINF\b/i,
      /"INF"/,
      /"-INF"/,
      /"NaN"/,
      // REDUCED keyword
      /\bREDUCED\b/i,
      // LIMIT/OFFSET (uses Slice which we don't support)
      /\bLIMIT\b/i,
      /\bOFFSET\b/i,
    ];

    for (const pattern of unsupportedPatterns) {
      if (pattern.test(test.queryString)) {
        return false;
      }
    }

    const unsupported = [
      'group',
      'minus',
      'ask',
      'construct',
      'orderby',  // lowercase - this is what sparqlalgebrajs uses
      'distinct',
      'leftJoin', // OPTIONAL - not fully implemented

      // Want to include
      'ZeroOrMorePath',
      'ZeroOrOnePath',
      'values',
      'extend',  // BIND
    ]

    let supported = true;

    const query = translate(test.queryString, { baseIRI: test.baseIRI });
    const unsupportedObject = {};

    for (const key of unsupported) {
      unsupportedObject[key] = () => {
        supported = false;
      };
    }

    Util.recurseOperation(query, unsupportedObject);

    return supported;
  });

// Create temp directory for test artifacts
const tempBaseDir = path.join(__dirname, 'temp', 'test-runs');
if (fs.existsSync(tempBaseDir)) {
  fs.rmSync(tempBaseDir, { recursive: true });
}
fs.mkdirSync(tempBaseDir, { recursive: true });

// Test results tracking
const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  failures: [],
};

/**
 * Run a single test in an isolated directory
 */
async function runTest(test, testIndex) {
  const testName = test.name || test.uri;
  const writer = new Writer({ format: 'Turtle' });
  const dataContent = writer.quadsToString(test.queryData);
  
  // Skip tests with empty data
  if (!dataContent || dataContent.trim() === '') {
    return { status: 'skipped', name: testName, reason: 'empty data' };
  }
  
  // Create isolated directory for this test
  const testDir = path.join(tempBaseDir, `test-${testIndex}`);
  const circuitDir = path.join(testDir, 'circuit');
  const circuitSrcDir = path.join(circuitDir, 'src');
  fs.mkdirSync(circuitSrcDir, { recursive: true });
  
  const inputDataPath = path.join(testDir, 'data.ttl');
  fs.writeFileSync(inputDataPath, dataContent);

  try {
    // Transform SPARQL to Noir circuit using WASM module
    const transformResultJson = skipSigning 
      ? wasmTransformWithOptions(test.queryString, true)  // skip_signing = true
      : wasmTransform(test.queryString);
    const transformResult = JSON.parse(transformResultJson);
    
    // Check for errors
    if (transformResult.error) {
      throw new Error(`Transform error: ${transformResult.error}`);
    }
    
    // Write the generated circuit files
    fs.writeFileSync(path.join(circuitSrcDir, 'sparql.nr'), transformResult.sparql_nr);
    fs.writeFileSync(path.join(circuitSrcDir, 'main.nr'), transformResult.main_nr);
    
    // Adjust Nargo.toml paths to use absolute paths from the workspace
    const libPath = path.join(__dirname, 'noir/lib/').replace(/\\/g, '/');
    const nargoToml = transformResult.nargo_toml.replace(
      /path = "\.\.\/noir\/lib\//g, 
      `path = "${libPath}`);
    fs.writeFileSync(path.join(circuitDir, 'Nargo.toml'), nargoToml);
    fs.writeFileSync(path.join(circuitDir, 'metadata.json'), JSON.stringify(transformResult.metadata, null, 2));
    
    // Compile the circuit using WASM (with silent logging)
    const fm = createFileManager(circuitDir);
    const compiledArtifacts = await compile_program(fm, undefined, () => {}, () => {});
    
    // Save the compiled artifacts
    const targetDir = path.join(circuitDir, 'target');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'sparql_proof.json'),
      JSON.stringify(compiledArtifacts.program || compiledArtifacts, null, 2)
    );
    
    // Sign or process the RDF data based on mode
    const signedData = skipSigning 
      ? await processRdfDataWithoutSigning(inputDataPath)
      : await signRdfData(inputDataPath);
    
    // Generate proofs or witness only based on CLI option
    const proveResult = await generateProofs({
      circuitDir,
      signedData,
      witnessOnly,
      skipSigning,
    });
    
    if (!witnessOnly) {
      // Verify proofs
      const verifyResult = await verifyProofs({
        circuitDir,
        proofData: proveResult,
      });
      
      if (!verifyResult.success) {
        throw new Error('Verification failed');
      }
    }

    // Clean up test directory on success
    fs.rmSync(testDir, { recursive: true });
    
    return { status: 'passed', name: testName };
  } catch (err) {
    const sparqlNrPath = path.join(circuitSrcDir, 'sparql.nr');
    const sparqlNr = fs.existsSync(sparqlNrPath) 
      ? fs.readFileSync(sparqlNrPath, 'utf-8')
      : null;
    
    // Clean up test directory on failure too
    fs.rmSync(testDir, { recursive: true });
    
    return {
      status: 'failed',
      name: testName,
      query: test.queryString,
      error: err.message,
      sparqlNr,
    };
  }
}

/**
 * Run tests with controlled concurrency
 */
async function runTestsWithConcurrency(tests, maxConcurrency) {
  const testResults = [];
  let nextIndex = 0;
  let completedCount = 0;
  
  async function runNext() {
    while (nextIndex < tests.length) {
      const currentIndex = nextIndex++;
      const test = tests[currentIndex];
      const result = await runTest(test, currentIndex);
      testResults[currentIndex] = result;
      completedCount++;
      
      // Print progress
      const symbol = result.status === 'passed' ? '✓' : result.status === 'skipped' ? '○' : '✗';
      const suffix = result.status === 'skipped' ? ` (skipped: ${result.reason})` : '';
      console.log(`  ${symbol} ${result.name}${suffix}`);
    }
  }
  
  // Start concurrent workers
  const workers = [];
  for (let i = 0; i < Math.min(maxConcurrency, tests.length); i++) {
    workers.push(runNext());
  }
  
  await Promise.all(workers);
  return testResults;
}

// Run all tests in parallel
console.log(`Running ${evaluationTests.length} tests...\n`);
const testResults = await runTestsWithConcurrency(evaluationTests, concurrency);

// Aggregate results
for (const result of testResults) {
  if (result.status === 'passed') {
    results.passed++;
  } else if (result.status === 'skipped') {
    results.skipped++;
  } else {
    results.failed++;
    results.failures.push(result);
  }
}

// Print summary
console.log('\n' + '─'.repeat(60));
console.log('\nTest Results:');
console.log(`  ${results.passed} passed`);
console.log(`  ${results.failed} failed`);
console.log(`  ${results.skipped} skipped`);
console.log(`  ${evaluationTests.length} total\n`);

// Print failure details
if (results.failures.length > 0) {
  console.log('─'.repeat(60));
  console.log('\nFailure Details:\n');
  
  for (const failure of results.failures) {
    console.log(`✗ ${failure.name}`);
    console.log(`  Error: ${failure.error}`);
    console.log(`  Query:\n    ${failure.query.split('\n').join('\n    ')}`);
    if (failure.sparqlNr) {
      console.log(`  Generated sparql.nr:\n    ${failure.sparqlNr.split('\n').join('\n    ')}`);
    }
    console.log('');
  }
}

// Exit with error code if any tests failed
if (results.failed > 0) {
  process.exit(1);
}