#!/usr/bin/env node
/**
 * Example usage of the SPARQL Noir API
 * 
 * This demonstrates the main API functions:
 * - sign() - Sign an RDF dataset
 * - info() - Get disclosure information for a query
 * - prove() - Generate a proof (requires compiled circuit)
 * - verify() - Verify a proof
 */

import { sign, info } from '../dist/index.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');

async function main() {
  console.log('='.repeat(60));
  console.log('SPARQL Noir API Example');
  console.log('='.repeat(60));
  console.log();

  // Example 1: Sign an RDF dataset
  console.log('1. Signing an RDF dataset...');
  console.log('-'.repeat(60));
  
  const dataPath = join(repoRoot, 'inputs/data/data.ttl');
  
  if (!fs.existsSync(dataPath)) {
    console.error(`❌ Data file not found: ${dataPath}`);
    console.log('Please run this script from the repository root.');
    process.exit(1);
  }
  
  try {
    const signed = await sign(dataPath);
    console.log('✅ Successfully signed dataset');
    console.log('Root:', signed.root);
    console.log('Number of triples:', signed.triples?.length || 0);
    console.log('Has signature:', !!signed.signature);
    console.log('Has public key:', !!signed.pubKey);
    console.log();
  } catch (error) {
    console.error('❌ Failed to sign dataset:', error.message);
    console.log();
  }

  // Example 2: Get disclosure information
  console.log('2. Getting disclosure information...');
  console.log('-'.repeat(60));
  
  const query = `
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    SELECT ?name ?age WHERE {
      ?person foaf:name ?name .
      ?person foaf:age ?age .
      FILTER(?age >= 18)
    }
  `;
  
  const disclosure = info(query);
  console.log('Query:', query.trim());
  console.log();
  console.log('Disclosure Information:');
  console.log('  Merkle Depth:', disclosure.merkleDepth);
  console.log('  Signature Scheme:', disclosure.signatureScheme);
  console.log('  Disclosed Variables:', disclosure.disclosedVariables.join(', '));
  console.log('  Hidden Variables:', disclosure.hiddenVariables.join(', ') || '(none)');
  console.log();
  console.log('Summary:', disclosure.summary);
  console.log();

  // Example 3: API usage instructions
  console.log('3. Full workflow example (for reference):');
  console.log('-'.repeat(60));
  console.log(`
To use the complete API workflow:

1. Sign your dataset:
   import { sign } from '@jeswr/sparql-noir';
   const signed = await sign('data.ttl');

2. Generate a circuit from your query:
   npm run transform -- -q query.rq -o circuit/

3. Compile the circuit:
   cd circuit && nargo compile

4. Generate a proof:
   import { prove } from '@jeswr/sparql-noir';
   const proof = await prove('circuit/', signed);

5. Verify the proof:
   import { verify } from '@jeswr/sparql-noir';
   const result = await verify('circuit/', proof);
   console.log('Valid:', result.success);
  `);

  console.log('='.repeat(60));
  console.log('✅ API example completed successfully');
  console.log('='.repeat(60));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
