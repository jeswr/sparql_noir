#!/usr/bin/env node
/**
 * Example usage of the SPARQL Noir API
 * 
 * This demonstrates the main API functions:
 * - sign() - Sign an RDF dataset
 * - info() - Get disclosure information for a query
 * - prove() - Generate a proof (requires Rust/Cargo and Nargo)
 * - verify() - Verify a proof
 */

import { sign, info } from '../dist/index.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import N3 from 'n3';

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
    // Load RDF data into an N3 Store (RDF/JS DatasetCore)
    const store = new N3.Store();
    const parser = new N3.Parser();
    const turtleData = fs.readFileSync(dataPath, 'utf8');
    
    await new Promise((resolve, reject) => {
      parser.parse(turtleData, (error, quad, prefixes) => {
        if (error) {
          reject(error);
        } else if (quad) {
          store.addQuad(quad);
        } else {
          resolve(undefined);
        }
      });
    });
    
    // Sign the RDF/JS dataset
    const signed = await sign(store);
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

1. Load and sign your dataset:
   import { sign } from '@jeswr/sparql-noir';
   import { Store, Parser } from 'n3';
   
   const store = new Store();
   const parser = new Parser();
   // Parse your RDF data into the store...
   const signed = await sign(store);

2. Generate a proof (requires Rust/Cargo and Nargo installed):
   import { prove } from '@jeswr/sparql-noir';
   const proof = await prove(query, signed);

3. Verify the proof:
   import { verify } from '@jeswr/sparql-noir';
   const result = await verify(proof);
   console.log('Valid:', result.success);
   
Note: The prove() function will automatically:
  - Generate the Noir circuit from your SPARQL query
  - Compile the circuit with Nargo
  - Generate the zero-knowledge proof
  - Clean up temporary files
  
The verify() function uses the compiled circuit included in the proof.
  `);

  console.log('='.repeat(60));
  console.log('✅ API example completed successfully');
  console.log('='.repeat(60));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
