import { ManifestLoader } from 'rdf-test-suite';
import * as fs from 'fs';
import path from 'path';
import { Writer } from 'n3';
import { translate, Util } from 'sparqlalgebrajs';
import { execSync } from 'child_process';

const __dirname = new URL('.', import.meta.url).pathname;

const loader = new ManifestLoader();

const tests = await loader.from("https://w3c.github.io/rdf-tests/sparql/sparql11/manifest-sparql11-query.ttl");
const evaluationTests = tests.subManifests.flatMap(test => test.testEntries)
  .filter(test => {
    if (
      !test.types.includes('http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#QueryEvaluationTest') ||
      test.approval !== 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#Approved' ||
      !test.queryString.includes('SELECT')
    ) {
      return false;
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
  
  await Promise.all([
    fs.promises.writeFile(path.join(__dirname, 'inputs', 'sparql.rq'), test.queryString),
    fs.promises.writeFile(path.join(__dirname, 'inputs', 'data', 'data.ttl'), dataContent),
  ]);

  try {
    execSync('npm run transform', { stdio: 'inherit' });
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