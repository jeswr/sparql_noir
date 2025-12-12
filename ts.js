import { ManifestLoader } from 'rdf-test-suite';
import * as fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Writer, Parser } from 'n3';
import { translate, Util } from 'sparqlalgebrajs';
import { signRdfData, processRdfDataWithoutSigning } from './dist/scripts/sign.js';
import { generateProofs } from './dist/scripts/prove.js';
import { verifyProofs } from './dist/scripts/verify.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { transform: wasmTransform, transform_with_options: wasmTransformWithOptions } = require('./transform/pkg/transform.cjs');
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import os from 'os';

const __dirname = new URL('.', import.meta.url).pathname;

console.log('Using WASM transform module');

// Shared cache directory for noir dependencies (archives and libs)
const noirCacheDir = path.join(__dirname, 'temp', 'noir-cache');

// Cache directory for signed dataset results
const signedDataCacheDir = path.join(__dirname, 'temp', 'signed-cache');

// Cache directory for compiled circuits
const circuitCacheDir = path.join(__dirname, 'temp', 'circuit-cache');

// Cache directory for manifest/test data
const manifestCacheDir = path.join(__dirname, 'temp', 'manifest-cache');

/**
 * Get a cache key for the data content (MD5 hash of content + signing mode)
 */
function getSignedDataCacheKey(dataContent, skipSigning) {
  const hash = crypto.createHash('md5').update(dataContent).digest('hex');
  return `${hash}-${skipSigning ? 'nosig' : 'sig'}.json`;
}

/**
 * Try to get signed data from cache
 */
function getCachedSignedData(dataContent, skipSigning) {
  const cacheKey = getSignedDataCacheKey(dataContent, skipSigning);
  const cachePath = path.join(signedDataCacheDir, cacheKey);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Save signed data to cache
 */
function cacheSignedData(dataContent, skipSigning, signedData) {
  fs.mkdirSync(signedDataCacheDir, { recursive: true });
  const cacheKey = getSignedDataCacheKey(dataContent, skipSigning);
  const cachePath = path.join(signedDataCacheDir, cacheKey);
  fs.writeFileSync(cachePath, JSON.stringify(signedData));
}

/**
 * Get a cache key for compiled circuit (hash of sparql.nr + main.nr + Nargo.toml)
 */
function getCircuitCacheKey(sparqlNr, mainNr, nargoToml) {
  const combined = sparqlNr + '\n---\n' + mainNr + '\n---\n' + nargoToml;
  return crypto.createHash('md5').update(combined).digest('hex') + '.json';
}

/**
 * Try to get compiled circuit from cache
 */
function getCachedCircuit(sparqlNr, mainNr, nargoToml) {
  const cacheKey = getCircuitCacheKey(sparqlNr, mainNr, nargoToml);
  const cachePath = path.join(circuitCacheDir, cacheKey);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Save compiled circuit to cache
 */
function cacheCircuit(sparqlNr, mainNr, nargoToml, compiled) {
  fs.mkdirSync(circuitCacheDir, { recursive: true });
  const cacheKey = getCircuitCacheKey(sparqlNr, mainNr, nargoToml);
  const cachePath = path.join(circuitCacheDir, cacheKey);
  fs.writeFileSync(cachePath, JSON.stringify(compiled));
}

/**
 * Get cache key for manifest URL
 */
function getManifestCacheKey(manifestUrl) {
  const hash = crypto.createHash('md5').update(manifestUrl).digest('hex');
  return `manifest-${hash}.json`;
}

/**
 * Serialize test entry for caching (extract serializable data)
 */
function serializeTestEntry(test) {
  const writer = new Writer({ format: 'Turtle' });
  return {
    name: test.name,
    uri: test.uri,
    types: test.types,
    approval: test.approval,
    queryString: test.queryString,
    baseIRI: test.baseIRI,
    queryDataSerialized: writer.quadsToString(test.queryData || []),
    queryResultValue: test.queryResult?.value || [],
  };
}

/**
 * Deserialize test entry from cache
 */
function deserializeTestEntry(cached) {
  // Parse the serialized turtle back to quads
  const parser = new Parser();
  let queryData = [];
  try {
    queryData = parser.parse(cached.queryDataSerialized || '');
  } catch (e) {
    // If parsing fails, use empty array
  }
  
  return {
    name: cached.name,
    uri: cached.uri,
    types: cached.types,
    approval: cached.approval,
    queryString: cached.queryString,
    baseIRI: cached.baseIRI,
    queryData,
    queryResult: { value: cached.queryResultValue || [] },
  };
}

/**
 * Try to get manifest tests from cache
 */
function getCachedManifest(manifestUrl) {
  const cacheKey = getManifestCacheKey(manifestUrl);
  const cachePath = path.join(manifestCacheDir, cacheKey);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      console.log(`Loading ${cached.length} tests from manifest cache`);
      return cached.map(deserializeTestEntry);
    } catch (e) {
      console.log('Manifest cache corrupted, will re-fetch');
      return null;
    }
  }
  return null;
}

/**
 * Save manifest tests to cache
 */
function cacheManifest(manifestUrl, testEntries) {
  fs.mkdirSync(manifestCacheDir, { recursive: true });
  const cacheKey = getManifestCacheKey(manifestUrl);
  const cachePath = path.join(manifestCacheDir, cacheKey);
  const serialized = testEntries.map(serializeTestEntry);
  fs.writeFileSync(cachePath, JSON.stringify(serialized));
  console.log(`Cached ${testEntries.length} tests from manifest`);
}

/**
 * Load manifest tests, using cache if available
 */
async function loadManifestWithCache(manifestUrl, skipCache = false) {
  // Try cache first (unless disabled)
  if (!skipCache) {
    const cached = getCachedManifest(manifestUrl);
    if (cached) {
      return cached;
    }
  }
  
  // Fetch from network
  console.log('Fetching manifest from network...');
  const loader = new ManifestLoader();
  const tests = await loader.from(manifestUrl);
  const testEntries = tests.subManifests.flatMap(test => test.testEntries);
  
  // Cache for next run (unless disabled)
  if (!skipCache) {
    cacheManifest(manifestUrl, testEntries);
  }
  
  return testEntries;
}

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
// Default to witness-only and skip-signing for faster testing (opt-out with --full-proof/--with-signing)
const witnessOnly = !args.includes('--full-proof') && !args.includes('-p');
const skipSigning = !args.includes('--with-signing') && !args.includes('-S');
const quietMode = !args.includes('--verbose') && !args.includes('-v');
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
const transformOnly = args.includes('--transform-only') || args.includes('-t');
const showTiming = args.includes('--timing') || args.includes('-T');
const noCacheCircuit = args.includes('--no-cache-circuit');
const noCacheManifest = args.includes('--no-cache-manifest');

// Path to store failing test names
const failedTestsFile = path.join(__dirname, 'temp', 'failed-tests.json');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node ts.js [options]

Options:
  -p, --full-proof        Generate full ZK proofs (default: witness-only)
  -S, --with-signing      Enable signature verification (default: skip-signing)
  -v, --verbose           Enable verbose logging (quiet by default)
  -j<N>, --concurrency=N  Number of parallel tests (default: number of CPUs)
  -f=PATTERN, --filter=PATTERN  Only run tests matching PATTERN (case-insensitive regex)
  -i=N, --index=N         Only run test at index N
  -r=START-END, --range=START-END  Only run tests from index START to END (inclusive)
  -F, --failed, --rerun-failed  Only run tests that failed in the previous run
  -1, --single-binding    Only generate witness for one binding per test (faster)
  -b=N, --max-bindings=N  Maximum number of bindings to process per test
  -t, --transform-only    Only test SPARQL->Noir transform, skip compile/prove (fastest)
  -T, --timing            Show timing breakdown for each test
  --no-cache-circuit      Disable circuit compilation caching
  --no-cache-manifest     Disable manifest/test data caching (re-fetch from network)
  -h, --help              Show this help message

Examples:
  node ts.js -f="isBlank"           Run only tests with "isBlank" in the name
  node ts.js -i=5                   Run only test at index 5
  node ts.js -r=10-20               Run tests from index 10 to 20
  node ts.js -f="equality"          Run equality tests (witness-only, no signing by default)
  node ts.js --failed               Re-run only tests that failed last time
  node ts.js -1                     Run all tests with only one binding each (fastest)
  node ts.js -p -S                  Run full proof generation with signing (slowest)

By default: witness-only mode, no signature verification, quiet output.

Manifest and test data are cached in temp/manifest-cache/ after first fetch.
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

// Use SPARQL 1.0 tests which have basic BGP, OPTIONAL, FILTER tests
const manifestUrl = "https://w3c.github.io/rdf-tests/sparql/sparql10/manifest.ttl";
const allTestEntries = await loadManifestWithCache(manifestUrl, noCacheManifest);
const evaluationTests = allTestEntries
  .filter(test => {
    if (
      !test.types.includes('http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#QueryEvaluationTest') ||
      test.approval !== 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#Approved' ||
      (!test.queryString.includes('SELECT') && !test.queryString.includes('ASK'))
      // Skip queries with empty results sets
      || test.queryResult.value.length === 0
    ) {
      return false;
    }

    // Skip specific tests that require features our ZK encoding doesn't support
    // sameTerm-not-eq: requires distinguishing value equality from term identity
    // (our encoding treats "1"^^xsd:integer and "1.0"^^xsd:double as the same value)
    // open-cmp-01/02: "open world" comparisons between incompatible types
    // (e.g., strings vs dates) - ZK circuits need concrete numeric representations
    const unsupportedTests = ['sameTerm-not-eq', 'open-cmp-01', 'open-cmp-02'];
    if (unsupportedTests.includes(test.name)) {
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
      // /\bSHA256\s*\(/i,
      /\bSHA384\s*\(/i,
      /\bSHA512\s*\(/i,
      /\bCOALESCE\s*\(/i,
      /\bIF\s*\(/i,
      /\bIN\s*\(/i,
      /\bNOT\s+IN\s*\(/i,
      // SPARQL accessor functions - now supported (LANG, STR, DATATYPE, LANGMATCHES)
      // /\bLANGMATCHES\s*\(/i,  // enabled
      // /\bLANG\s*\(/i,         // enabled
      // /\bSTR\s*\(/i,          // enabled
      // /\bDATATYPE\s*\(/i,     // enabled

      //
      /\bREGEX\s*\(/i,
      // /\bBOUND\s*\(/i,  // BOUND is supported (returns true/false based on variable binding)
      // Blank nodes - both bracket syntax [ ... ] and explicit _: syntax are now supported
      // /_:/,  // Explicit blank node syntax - enabled
      // /\[\s*[^\]]*\s*\]/,  // Square bracket blank node syntax [ ... ] - enabled
      // RDF list syntax (1 2 3) generates blank nodes
      /\(\s*\??\w+(?:\s+\??\w+)*\s*\)/,  // List syntax like (1) or (?v ?w)
      // Special float/double values that Noir doesn't support
      /\bNaN\b/i,
      /\bINF\b/i,
      /"INF"/,
      /"-INF"/,
      /"NaN"/,
      // REDUCED, LIMIT/OFFSET now accepted (post-processing handled outside circuit)
      // /\bREDUCED\b/i,
      // /\bLIMIT\b/i,
      // /\bOFFSET\b/i,
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
      // 'ask',  // ASK queries are supported by transform
      'construct',
      // 'orderby',  // ORDER BY - now accepted (post-processing)
      // 'distinct', // DISTINCT - now accepted (post-processing)
      // 'leftjoin', // OPTIONAL - now implemented as UNION of (left) and (left+right)
      // 'graph',    // GRAPH - implemented, handles named graph patterns

      // Want to include
      'ZeroOrMorePath',
      // 'ZeroOrOnePath', // enabled - handled by transform
      'values',
      // 'extend',  // BIND - enabled, handled by transform
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
  const timing = { transform: 0, compile: 0, sign: 0, prove: 0, verify: 0 };
  let proveErrors = []; // Errors collected from proof generation (quiet mode)
  
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
    let startTime = Date.now();
    const transformResultJson = skipSigning 
      ? wasmTransformWithOptions(test.queryString, true)  // skip_signing = true
      : wasmTransform(test.queryString);
    const transformResult = JSON.parse(transformResultJson);
    timing.transform = Date.now() - startTime;
    
    // Check for errors
    if (transformResult.error) {
      throw new Error(`Transform error: ${transformResult.error}`);
    }
    
    // In transform-only mode, just check the transform succeeded
    if (transformOnly) {
      fs.rmSync(testDir, { recursive: true });
      return { status: 'passed', name: testName, timing };
    }
    
    // Adjust Nargo.toml paths to use absolute paths from the workspace
    const libPath = path.join(__dirname, 'noir/lib/').replace(/\\/g, '/');
    const nargoToml = transformResult.nargo_toml.replace(
      /path = "\.\.\/noir\/lib\//g, 
      `path = "${libPath}`);
    fs.writeFileSync(path.join(circuitDir, 'Nargo.toml'), nargoToml);
    
    // Link cached noir dependencies to avoid re-downloading for each test
    linkCachedDependencies(circuitDir);
    
    // Create target directory for compiled circuits
    const targetDir = path.join(circuitDir, 'target');
    fs.mkdirSync(targetDir, { recursive: true });
    
    // Sign or process the RDF data based on mode (use cache if available)
    startTime = Date.now();
    let signedData = getCachedSignedData(dataContent, skipSigning);
    if (!signedData) {
      suppressLogs();
      try {
        signedData = skipSigning 
          ? await processRdfDataWithoutSigning(inputDataPath)
          : await signRdfData(inputDataPath);
        cacheSignedData(dataContent, skipSigning, signedData);
      } finally {
        restoreLogs();
      }
    }
    timing.sign = Date.now() - startTime;
    
    // Build list of circuit variants to try (most optionals first, then fewer)
    // The base circuit has all optionals matched, optional_circuits have fewer
    const circuitVariants = [];
    
    // Base circuit (all optionals matched)
    circuitVariants.push({
      sparql_nr: transformResult.sparql_nr,
      main_nr: transformResult.main_nr,
      metadata: transformResult.metadata,
      matched_optionals: Array.from({ length: transformResult.metadata?.num_optionals || 0 }, (_, i) => i),
    });
    
    // Add optional circuits (sorted from most optionals to least)
    if (transformResult.optional_circuits) {
      const sortedOptional = [...transformResult.optional_circuits].sort(
        (a, b) => (b.matched_optionals?.length || 0) - (a.matched_optionals?.length || 0)
      );
      for (const oc of sortedOptional) {
        circuitVariants.push({
          sparql_nr: oc.sparql_nr,
          main_nr: transformResult.main_nr, // main.nr is shared
          metadata: oc.metadata,
          matched_optionals: oc.matched_optionals,
        });
      }
    }
    
    // Helper to compile a circuit variant
    const compileVariant = async (variant) => {
      const fm = createFileManager(circuitDir);
      suppressLogs();
      try {
        const compiled = await compile_program(fm, undefined, 
          (msg) => {}, 
          (msg) => {}
        );
        if (!compiled || (!compiled.program && !compiled.abi)) {
          return null;
        }
        return compiled;
      } catch {
        return null;
      } finally {
        restoreLogs();
      }
    };
    
    // Helper to get cached circuit
    const getCachedVariant = (variant) => {
      if (noCacheCircuit) return null;
      return getCachedCircuit(variant.sparql_nr, variant.main_nr, nargoToml);
    };
    
    // Helper to cache circuit
    const cacheVariant = (variant, compiled) => {
      if (!noCacheCircuit) {
        cacheCircuit(variant.sparql_nr, variant.main_nr, nargoToml, compiled.program || compiled);
      }
    };
    
    // Generate proofs or witness (prove.ts handles variant selection)
    startTime = Date.now();
    let proveResult;
    try {
      proveResult = await generateProofs({
        circuitDir,
        signedData,
        witnessOnly,
        skipSigning,
        maxBindings,
        quiet: true,
        circuitVariants,
        compileVariant,
        getCachedCircuit: getCachedVariant,
        cacheCircuit: cacheVariant,
      });
      // Collect any errors from the prove result
      if (proveResult.errors && proveResult.errors.length > 0) {
        proveErrors = proveResult.errors;
      }
    } catch (err) {
      throw err;
    }
    timing.prove = Date.now() - startTime;
    
    if (!witnessOnly) {
      // Verify proofs (suppress verbose output)
      startTime = Date.now();
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
      timing.verify = Date.now() - startTime;
      
      if (!verifyResult.success) {
        throw new Error('Verification failed');
      }
    }

    // Clean up test directory on success
    fs.rmSync(testDir, { recursive: true });
    
    return { status: 'passed', name: testName, timing };
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
      timing,
      proveErrors: proveErrors.length > 0 ? proveErrors : undefined,
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
      let timingStr = '';
      if (showTiming && result.timing) {
        const t = result.timing;
        const parts = [];
        if (t.transform) parts.push(`T:${t.transform}ms`);
        if (t.compile) parts.push(`C:${t.compile}ms`);
        if (t.sign) parts.push(`S:${t.sign}ms`);
        if (t.prove) parts.push(`P:${t.prove}ms`);
        if (t.verify) parts.push(`V:${t.verify}ms`);
        if (parts.length) timingStr = ` [${parts.join(' ')}]`;
      }
      console.log(`  ${symbol} ${result.name}${suffix}${timingStr}`);
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

// Path for detailed error log
const errorLogFile = path.join(__dirname, 'temp', 'error-log.txt');

// Print summary
console.log('\n' + '─'.repeat(60));
console.log('\nTest Results:');
console.log(`  ${results.passed} passed`);
console.log(`  ${results.failed} failed`);
console.log(`  ${results.skipped} skipped`);
console.log(`  ${testsToRun.length} run (${evaluationTests.length} total available)\n`);

// Write failure details to error log file
if (results.failures.length > 0) {
  const errorLogLines = [];
  errorLogLines.push(`Test Run: ${new Date().toISOString()}`);
  errorLogLines.push(`Mode: ${witnessOnly ? 'witness-only' : 'full proof'}${skipSigning ? ' (skip-signing)' : ''}`);
  errorLogLines.push('─'.repeat(60));
  errorLogLines.push('');
  
  for (const failure of results.failures) {
    errorLogLines.push(`✗ ${failure.name}`);
    errorLogLines.push(`  Error: ${failure.error}`);
    errorLogLines.push(`  Query:`);
    errorLogLines.push(`    ${failure.query.split('\n').join('\n    ')}`);
    if (failure.sparqlNr) {
      errorLogLines.push(`  Generated sparql.nr:`);
      errorLogLines.push(`    ${failure.sparqlNr.split('\n').join('\n    ')}`);
    }
    if (failure.proveErrors && failure.proveErrors.length > 0) {
      errorLogLines.push(`  Proof generation warnings:`);
      for (const proveErr of failure.proveErrors) {
        errorLogLines.push(`    ${proveErr}`);
      }
    }
    errorLogLines.push('');
  }
  
  fs.writeFileSync(errorLogFile, errorLogLines.join('\n'));
  console.log(`Error details written to: ${errorLogFile}\n`);
}

// Exit with error code if any tests failed
if (results.failed > 0) {
  process.exit(1);
}