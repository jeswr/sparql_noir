import { ManifestLoader } from 'rdf-test-suite';

const loader = new ManifestLoader();
// Use SPARQL 1.0 tests
const tests = await loader.from("https://w3c.github.io/rdf-tests/sparql/sparql10/manifest.ttl");
const evaluationTests = tests.subManifests.flatMap(test => test.testEntries)
  .filter(test => {
    return test.types.includes('http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#QueryEvaluationTest') &&
      test.approval === 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#Approved' &&
      test.queryString.includes('SELECT');
  });

for (const test of evaluationTests.slice(0, 20)) {
  console.log('=== ' + test.name + ' ===');
  console.log(test.queryString);
  console.log();
}
console.log('Total:', evaluationTests.length);
