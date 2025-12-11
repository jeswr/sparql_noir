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

// Shared cache directory for noir dependencies (archives and libs)
const noirCacheDir = path.join(__dirname, 'temp', 'noir-cache');

/**
 * Initialize the shared noir dependency cache by copying from noir_prove
 * which already has pre-downloaded dependencies
 */
function initializeNoirCache() {
  if (!fs.existsSync(noirCacheDir)) {
    fs.mkdirSync(noirCacheDir, { recursive: true });
  }
  
  // Source directories with cached dependencies
  const sourceArchives = path.join(__dirname, 'noir_prove', 'archives');
  const sourceLibs = path.join(__dirname, 'noir_prove', 'libs');
  const cacheArchives = path.join(noirCacheDir, 'archives');
  const cacheLibs = path.join(noirCacheDir, 'libs');
  
  // Copy archives if source exists and cache doesn't
  if (fs.existsSync(sourceArchives) && !fs.existsSync(cacheArchives)) {
    fs.cpSync(sourceArchives, cacheArchives, { recursive: true });
    console.log('Cached noir dependency archives');
  }
  
  // Copy libs if source exists and cache doesn't
  if (fs.existsSync(sourceLibs) && !fs.existsSync(cacheLibs)) {
    fs.cpSync(sourceLibs, cacheLibs, { recursive: true });
    console.log('Cached noir dependency libraries');
  }
}

/**
 * Link cached dependencies to a circuit directory
 */
function linkCachedDependencies(circuitDir) {
  const cacheArchives = path.join(noirCacheDir, 'archives');
  const cacheLibs = path.join(noirCacheDir, 'libs');
  const targetArchives = path.join(circuitDir, 'archives');
  const targetLibs = path.join(circuitDir, 'libs');
  
  // Symlink archives directory if cache exists
  if (fs.existsSync(cacheArchives) && !fs.existsSync(targetArchives)) {
    fs.symlinkSync(cacheArchives, targetArchives, 'dir');
  }
  
  // Symlink libs directory if cache exists
  if (fs.existsSync(cacheLibs) && !fs.existsSync(targetLibs)) {
    fs.symlinkSync(cacheLibs, targetLibs, 'dir');
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);
const witnessOnly = args.includes('--witness-only') || args.includes('-w');
const skipSigning = args.includes('--skip-signing') || args.includes('-s');
const quietMode = args.includes('--quiet') || args.includes('-q');
const concurrencyArg = args.find(a => a.startsWith('--concurrency=') || a.startsWith('-j'));
const concurrency = concurrencyArg 
  ? parseInt(concurrencyArg.split('=')[1] || concurrencyArg.slice(2), 10) 
  : os.cpus().length;

// Test filtering options
const filterArg = args.find(a => a.startsWith('--filter=') || a.startsWith('-f='));
const testFilter = filterArg ? filterArg.split('=')[1] : null;
const indexArg = args.find(a => a.startsWith('--index=') || a.startsWith('-i='));
const testIndex = indexArg ? parseInt(indexArg.split('=')[1], 10) : null;
const rangeArg = args.find(a => a.startsWith('--range=') || a.startsWith('-r='));
const testRange = rangeArg ? rangeArg.split('=')[1].split('-').map(n => parseInt(n, 10)) : null;
const rerunFailed = args.includes('--failed') || args.includes('--rerun-failed') || args.includes('-F');
const singleBinding = args.includes('--single-binding') || args.includes('-1');
const maxBindingsArg = args.find(a => a.startsWith('--max-bindings=') || a.startsWith('-b='));
const maxBindings = singleBinding ? 1 : (maxBindingsArg ? parseInt(maxBindingsArg.split('=')[1], 10) : undefined);

// Path to store failing test names
const failedTestsFile = path.join(__dirname, 'temp', 'failed-tests.json');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node ts.js [options]

Options:
  -w, --witness-only      Only generate witness, skip proof generation and verification (faster)
  -s, --skip-signing      Skip signature verification (use simplified circuit, much faster)
  -q, --quiet             Suppress verbose logging (only show test results)
  -j<N>, --concurrency=N  Number of parallel tests (default: number of CPUs)
  -f=PATTERN, --filter=PATTERN  Only run tests matching PATTERN (case-insensitive regex)
  -i=N, --index=N         Only run test at index N
  -r=START-END, --range=START-END  Only run tests from index START to END (inclusive)
  -F, --failed, --rerun-failed  Only run tests that failed in the previous run
  -1, --single-binding    Only generate witness for one binding per test (faster)
  -b=N, --max-bindings=N  Maximum number of bindings to process per test
  -h, --help              Show this help message

Examples:
  node ts.js -f="isBlank"           Run only tests with "isBlank" in the name
  node ts.js -i=5                   Run only test at index 5
  node ts.js -r=10-20               Run tests from index 10 to 20
  node ts.js -s -w -f="equality"    Run equality tests with skip-signing and witness-only
  node ts.js -s -w --failed         Re-run only tests that failed last time
  node ts.js -s -w -1               Run all tests with only one binding each (fastest)

By default, full proof generation and verification is performed.

Noir dependencies are cached in temp/noir-cache/ and shared across all tests
via symlinks to avoid re-downloading for each test compilation.
`);
  process.exit(0);
}

// Helper to suppress console.log in quiet mode
const originalConsoleLog = console.log;
function suppressLogs() {
  if (quietMode) {
    console.log = () => {};
  }
}
function restoreLogs() {
  console.log = originalConsoleLog;
}

console.log(`Mode: ${witnessOnly ? 'witness-only' : 'full proof + verification'}${skipSigning ? ' (skip-signing)' : ''}${quietMode ? ' (quiet)' : ''}`);
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
      // Arithmetic operations in FILTER (not supported in transform)
      /\?\w+\s*\*\s*\?/i,  // multiplication: ?var * ?var
      /\?\w+\s*\+\s*\?/i,  // addition: ?var + ?var
      /\?\w+\s*-\s*\?/i,   // subtraction: ?var - ?var
      /[=<>]\s*\+\d/,      // unary plus: = +3
      /[=<>]\s*-\?/,       // unary minus: = -?var
      /-\?\w+\s*=/,        // unary minus on left: -?var =
      // Boolean effective value tests - bare variable in FILTER not supported
      /FILTER\s*\(\s*\?\w+\s*\)/i,         // FILTER(?v)
      /FILTER\s*\(\s*!\s*\?\w+\s*\)/i,     // FILTER(!?v)
      /FILTER\s*\(\s*"[^"]*"\^\^[^)]*&&\s*\?\w+\s*\)/i,  // FILTER("..."^^type && ?v)
      /FILTER\s*\(\s*"[^"]*"\^\^[^)]*\|\|\s*\?\w+\s*\)/i, // FILTER("..."^^type || ?v)
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
      'leftjoin', // OPTIONAL - not fully implemented (lowercase per sparqlalgebrajs)

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

// Initialize shared noir dependency cache
initializeNoirCache();

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
    
    // Link cached noir dependencies to avoid re-downloading for each test
    linkCachedDependencies(circuitDir);
    
    // Compile the circuit using WASM (suppress noisy console output)
    const fm = createFileManager(circuitDir);
    suppressLogs();
    let compiledArtifacts;
    try {
      compiledArtifacts = await compile_program(fm, undefined, () => {}, () => {});
    } finally {
      restoreLogs();
    }
    
    // Save the compiled artifacts
    const targetDir = path.join(circuitDir, 'target');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'sparql_proof.json'),
      JSON.stringify(compiledArtifacts.program || compiledArtifacts, null, 2)
    );
    
    // Sign or process the RDF data based on mode (suppress verbose output)
    suppressLogs();
    let signedData;
    try {
      signedData = skipSigning 
        ? await processRdfDataWithoutSigning(inputDataPath)
        : await signRdfData(inputDataPath);
    } finally {
      restoreLogs();
    }
    
    // Generate proofs or witness only based on CLI option (suppress verbose output)
    suppressLogs();
    let proveResult;
    try {
      proveResult = await generateProofs({
        circuitDir,
        signedData,
        witnessOnly,
        skipSigning,
        maxBindings,
      });
    } finally {
      restoreLogs();
    }
    
    if (!witnessOnly) {
      // Verify proofs (suppress verbose output)
      suppressLogs();
      let verifyResult;
      try {
        verifyResult = await verifyProofs({
          circuitDir,
          proofData: proveResult,
        });
      } finally {
        restoreLogs();
      }
      
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

// Apply test filters
let testsToRun = evaluationTests;
let filterDescription = '';

if (rerunFailed) {
  if (fs.existsSync(failedTestsFile)) {
    const failedTestNames = JSON.parse(fs.readFileSync(failedTestsFile, 'utf-8'));
    if (failedTestNames.length > 0) {
      testsToRun = testsToRun.filter(t => failedTestNames.includes(t.name || t.uri));
      filterDescription = ` (re-running ${failedTestNames.length} previously failed)`;
    } else {
      console.log('No previously failed tests to re-run.');
      process.exit(0);
    }
  } else {
    console.log('No previous test run found. Run tests first without --failed.');
    process.exit(0);
  }
}

if (testFilter) {
  const regex = new RegExp(testFilter, 'i');
  testsToRun = testsToRun.filter(t => regex.test(t.name || t.uri));
  filterDescription = ` (filtered by pattern: "${testFilter}")`;
}

if (testIndex !== null) {
  if (testIndex >= 0 && testIndex < testsToRun.length) {
    testsToRun = [testsToRun[testIndex]];
    filterDescription = ` (index: ${testIndex})`;
  } else {
    console.error(`Error: Test index ${testIndex} is out of range (0-${testsToRun.length - 1})`);
    process.exit(1);
  }
}

if (testRange) {
  const [start, end] = testRange;
  if (start >= 0 && end < testsToRun.length && start <= end) {
    testsToRun = testsToRun.slice(start, end + 1);
    filterDescription = ` (range: ${start}-${end})`;
  } else {
    console.error(`Error: Test range ${start}-${end} is invalid (valid: 0-${testsToRun.length - 1})`);
    process.exit(1);
  }
}

if (testsToRun.length === 0) {
  console.log('No tests match the filter criteria.');
  process.exit(0);
}

// Run all tests in parallel
console.log(`Running ${testsToRun.length} of ${evaluationTests.length} tests${filterDescription}...\n`);
const testResults = await runTestsWithConcurrency(testsToRun, concurrency);

// Aggregate results
const failedTestNames = [];
for (const result of testResults) {
  if (result.status === 'passed') {
    results.passed++;
  } else if (result.status === 'skipped') {
    results.skipped++;
  } else {
    results.failed++;
    results.failures.push(result);
    failedTestNames.push(result.name);
  }
}

// Save failed test names for --failed option
fs.mkdirSync(path.dirname(failedTestsFile), { recursive: true });
fs.writeFileSync(failedTestsFile, JSON.stringify(failedTestNames, null, 2));

// Print summary
console.log('\n' + '─'.repeat(60));
console.log('\nTest Results:');
console.log(`  ${results.passed} passed`);
console.log(`  ${results.failed} failed`);
console.log(`  ${results.skipped} skipped`);
console.log(`  ${testsToRun.length} run (${evaluationTests.length} total available)\n`);

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