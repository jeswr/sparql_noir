import { ManifestLoader } from 'rdf-test-suite';
import * as fs from 'fs';
import path from 'path';
import { Writer } from 'n3';
import { translate, Util } from 'sparqlalgebrajs';
import { execSync } from 'child_process';
import { signRdfData } from './dist/scripts/sign.js';
import { generateProofs } from './dist/scripts/prove.js';
import { verifyProofs } from './dist/scripts/verify.js';

const __dirname = new URL('.', import.meta.url).pathname;

// Determine transform binary path (prefer pre-built release binary)
const transformBinaryPath = path.join(__dirname, 'transform', 'target', 'release', 'transform');
const usePrebuiltBinary = fs.existsSync(transformBinaryPath);
if (usePrebuiltBinary) {
  console.log(`Using pre-built transform binary: ${transformBinaryPath}`);
} else {
  console.log('Pre-built binary not found, will use cargo run (slower). Run "npm run build:transform" to build.');
}

// Parse CLI arguments
const args = process.argv.slice(2);
const witnessOnly = args.includes('--witness-only') || args.includes('-w');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node ts.js [options]

Options:
  -w, --witness-only  Only generate witness, skip proof generation and verification (faster)
  -h, --help          Show this help message

By default, full proof generation and verification is performed.
`);
  process.exit(0);
}

console.log(`Mode: ${witnessOnly ? 'witness-only (fast)' : 'full proof + verification'}\n`);

const loader = new ManifestLoader();

// Use SPARQL 1.0 tests which have basic BGP, OPTIONAL, FILTER tests
const tests = await loader.from("https://w3c.github.io/rdf-tests/sparql/sparql10/manifest.ttl");
const evaluationTests = tests.subManifests.flatMap(test => test.testEntries)
  .filter(test => {
    if (
      !test.types.includes('http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#QueryEvaluationTest') ||
      test.approval !== 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#Approved' ||
      !test.queryString.includes('SELECT')
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
      // Blank nodes
      /_:/,
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
      'orderBy',
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

for (const test of evaluationTests) {
  console.log(`\n=== Running test: ${test.name || test.uri} ===`);
  
  const writer = new Writer({ format: 'Turtle' });
  const dataContent = writer.quadsToString(test.queryData);
  
  // Skip tests with empty data
  if (!dataContent || dataContent.trim() === '') {
    console.log(`  Skipping: empty data`);
    continue;
  }
  
  console.log(`  Query: ${test.queryString.substring(0, 80).replace(/\n/g, ' ')}...`);
  
  const inputQueryPath = path.join(__dirname, 'inputs', 'sparql.rq');
  const inputDataPath = path.join(__dirname, 'inputs', 'data', 'data.ttl');
  const circuitDir = path.join(__dirname, 'noir_prove');
  
  fs.writeFileSync(inputQueryPath, test.queryString);
  fs.writeFileSync(inputDataPath, dataContent);

  // Verify files were written correctly
  const writtenQuery = fs.readFileSync(inputQueryPath, 'utf-8');
  console.log(`  Written query: ${writtenQuery.substring(0, 80).replace(/\n/g, ' ')}...`);

  try {
    // Transform SPARQL to Noir circuit
    if (usePrebuiltBinary) {
      execSync(`"${transformBinaryPath}" -q inputs/sparql.rq`, { stdio: 'inherit' });
    } else {
      execSync('cargo run --manifest-path transform/Cargo.toml --release -- -q inputs/sparql.rq', { stdio: 'inherit' });
    }
    
    // Compile the circuit (still needs CLI as it's nargo)
    execSync('cd noir_prove && nargo compile', { stdio: 'inherit' });
    
    // Sign the RDF data (now using imported function)
    console.log('  Signing RDF data...');
    const signedData = await signRdfData(inputDataPath);
    
    // Generate proofs or witness only based on CLI option
    const proveResult = await generateProofs({
      circuitDir,
      signedData,
      witnessOnly,
    });
    
    if (witnessOnly) {
      console.log(`  Witness generated successfully (${proveResult.witnesses?.length || 0} witness(es))`);
    } else {
      console.log(`  Proofs generated successfully (${proveResult.proofs?.length || 0} proof(s))`);
      
      // Verify proofs
      console.log('  Verifying proofs...');
      const verifyResult = await verifyProofs({
        circuitDir,
        proofData: proveResult,
      });
      
      if (!verifyResult.success) {
        throw new Error('Verification failed');
      }
      console.log('  Verification successful!');
    }

    console.log(fs.readFileSync(path.join(circuitDir, 'src', 'sparql.nr'), 'utf-8'));
  } catch (err) {
    console.error(`  Test failed: ${err.message}`);
    continue;
  }
}

console.log(evaluationTests.length);

// Further processing of tests...