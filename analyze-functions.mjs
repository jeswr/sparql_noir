import { ManifestLoader } from 'rdf-test-suite';

const manifestUrl = 'https://w3c.github.io/rdf-tests/sparql/sparql10/manifest.ttl';
const runner = new ManifestLoader();
const man = await runner.from(manifestUrl, { baseManifest: manifestUrl });

const tests = [];
function collectTests(manifest) {
  if (manifest.subManifests) manifest.subManifests.forEach(collectTests);
  if (manifest.tests) tests.push(...manifest.tests);
}
collectTests(man);

// Check functions
const functions = {
  'LANG()': /\bLANG\s*\(/i,
  'STR()': /\bSTR\s*\(/i,
  'DATATYPE()': /\bDATATYPE\s*\(/i,
  'LANGMATCHES()': /\bLANGMATCHES\s*\(/i,
  'BOUND()': /\bBOUND\s*\(/i,
  'REGEX()': /\bREGEX\s*\(/i,
};
const counts = {};
const testsByFn = {};

for (const t of tests) {
  if (!t.queryFile) continue;
  try {
    const resp = await fetch(t.queryFile);
    const query = await resp.text();
    for (const [fn, re] of Object.entries(functions)) {
      if (re.test(query)) {
        counts[fn] = (counts[fn] || 0) + 1;
        testsByFn[fn] = testsByFn[fn] || [];
        testsByFn[fn].push(t.name || t.uri.split('/').pop());
      }
    }
  } catch {}
}

console.log('Function usage in SPARQL 1.0 tests:');
for (const [fn, count] of Object.entries(counts).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${fn}: ${count} tests`);
  testsByFn[fn]?.slice(0, 5).forEach(n => console.log(`    - ${n}`));
  if ((testsByFn[fn]?.length || 0) > 5) console.log(`    ... and ${testsByFn[fn].length - 5} more`);
}
