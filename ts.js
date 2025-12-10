import { ManifestLoader } from 'rdf-test-suite';
import * as fs from 'fs';
import path from 'path';
import { Writer } from 'n3';
import { translate, Util } from 'sparqlalgebrajs';
import { execSync } from 'child_process';

const __dirname = new URL('.', import.meta.url).pathname;

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
  
  fs.writeFileSync(path.join(__dirname, 'inputs', 'sparql.rq'), test.queryString);
  fs.writeFileSync(path.join(__dirname, 'inputs', 'data', 'data.ttl'), dataContent);

  // Verify files were written correctly
  const writtenQuery = fs.readFileSync(path.join(__dirname, 'inputs', 'sparql.rq'), 'utf-8');
  console.log(`  Written query: ${writtenQuery.substring(0, 80).replace(/\n/g, ' ')}...`);

  try {
    execSync('npm run transform -- -q inputs/sparql.rq', { stdio: 'inherit' });
    execSync('cd noir_prove && nargo compile', { stdio: 'inherit' });
    execSync('npm run sign -- -i inputs/data/data.ttl -o temp/signed.json', { stdio: 'inherit' });
    execSync('npm run prove -- -c ./noir_prove -s temp/signed.json -o temp/proof.json', { stdio: 'inherit' });
    execSync('npm run verify -- -i temp/proof.json -c ./noir_prove', { stdio: 'inherit' });

    console.log(fs.readFileSync(path.join(__dirname, 'noir_prove', 'src', 'sparql.nr'), 'utf-8'));
  } catch (err) {
    console.error(`  Test failed: ${err.message}`);
    continue;
  }
}

console.log(evaluationTests.length);

// Further processing of tests...