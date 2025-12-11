import { ManifestLoader } from 'rdf-test-suite';
import { translate, Util } from 'sparqlalgebrajs';

const loader = new ManifestLoader();
const tests = await loader.from('https://w3c.github.io/rdf-tests/sparql/sparql10/manifest.ttl');
const evaluationTests = tests.subManifests.flatMap(test => test.testEntries)
  .filter(test => 
    test.types.includes('http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#QueryEvaluationTest') &&
    test.approval === 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#Approved' &&
    test.queryString.includes('SELECT') &&
    test.queryResult.value.length > 0
  );

// Find tests blocked only by blank nodes
const blankNodePatterns = [/_:/, /\[\s*[^\]]*\s*\]/];
const functionPatterns = [
  /\bEXISTS\s*\{/i, /\bLANGMATCHES\s*\(/i, /\bLANG\s*\(/i,
  /\bSTR\s*\(/i, /\bDATATYPE\s*\(/i, /\bREGEX\s*\(/i, /\bBOUND\s*\(/i,
  /\bLIMIT\b/i, /\bOFFSET\b/i, /\bNaN\b/i, /\bINF\b/i
];
const unsupportedOps = ['group', 'minus', 'orderby', 'distinct', 'leftjoin', 'graph', 'ZeroOrMorePath', 'values'];

console.log('Tests blocked ONLY by blank nodes:\n');

for (const test of evaluationTests) {
  const hasBN = blankNodePatterns.some(p => p.test(test.queryString));
  const hasFunc = functionPatterns.some(p => p.test(test.queryString));
  
  if (!hasBN || hasFunc) continue;
  
  // Check algebra operations
  let hasUnsupportedOp = false;
  try {
    const query = translate(test.queryString, { baseIRI: test.baseIRI });
    for (const op of unsupportedOps) {
      Util.recurseOperation(query, { [op]: () => { hasUnsupportedOp = true; } });
    }
  } catch(e) {
    hasUnsupportedOp = true;
  }
  
  if (!hasUnsupportedOp) {
    console.log(`${test.name}:`);
    console.log(test.queryString);
    console.log('---\n');
  }
}
