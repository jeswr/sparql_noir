#!/usr/bin/env npx tsx
/**
 * Generate Edge Case Circuit Tests (v2)
 * 
 * This script generates circuit test inputs for edge case negative tests.
 * Unlike v1, this version uses EXPLICITLY DEFINED invalid inputs rather than
 * trying to derive them from data. Each test specifies exactly what BGP triple
 * and variable bindings to pass to the circuit.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import N3 from 'n3';
import type { Term, Quad, Literal, NamedNode } from '@rdfjs/types';
import { fileURLToPath } from 'url';

import { generateEdgeCaseTestsV2, EdgeCaseTestV2 } from './edge-case-tests.js';
import { 
  signDataInMemory, 
  transformQueryInMemory,
  generateCheckBindingInputs,
  SignedData, 
  CircuitMetadata,
  CheckBindingInputs,
} from './check-binding-inputs.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DF = N3.DataFactory;

// Dynamically import encoding functions
const { getTermEncodings, getTermEncodingString, runJson } = await import('../../src/encode.js');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'test', 'circuits', 'edge-cases');

/**
 * Encode a term to its Field representation (hex string)
 */
function encodeTerm(term: Term): string {
  const encodings = getTermEncodings([term]);
  return '0x' + encodings[0].toString(16);
}

/**
 * Convert an RDF.js Term to its string representation for bindings
 */
function termToBindingString(term: Term): string {
  switch (term.termType) {
    case 'NamedNode':
      return `<${term.value}>`;
    case 'BlankNode':
      return `_:${term.value}`;
    case 'Literal': {
      const lit = term as Literal;
      if (lit.language) {
        return `"${lit.value}"@${lit.language}`;
      }
      if (lit.datatype && lit.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
        return `"${lit.value}"^^<${lit.datatype.value}>`;
      }
      return `"${lit.value}"`;
    }
    default:
      return `"${term.value}"`;
  }
}

interface GeneratedInputs {
  test: EdgeCaseTestV2;
  validInputs: {
    public_key: object[];
    roots: object[];
    bgp: Array<{
      terms: string[];
      path: string[];
      directions: (0 | 1)[];
    }>;
    variables: Record<string, string>;
  } | null;
  invalidInputs: {
    public_key: object[];
    roots: object[];
    bgp: Array<{
      terms: string[];
      path: string[];
      directions: (0 | 1)[];
    }>;
    variables: Record<string, string>;
    expectedError: string;
  } | null;
  error?: string;
}

/**
 * Generate circuit inputs for an edge case test
 */
async function generateInputsForTest(test: EdgeCaseTestV2): Promise<GeneratedInputs> {
  const testDir = path.join(OUTPUT_DIR, test.name);
  fs.mkdirSync(testDir, { recursive: true });
  
  // Write query and data files
  fs.writeFileSync(path.join(testDir, 'query.rq'), test.query.trim());
  fs.writeFileSync(path.join(testDir, 'data.ttl'), test.validData.trim());
  
  let validInputs: GeneratedInputs['validInputs'] = null;
  let invalidInputs: GeneratedInputs['invalidInputs'] = null;
  let error: string | undefined;
  
  try {
    // Transform query to get metadata
    const metadata = await transformQueryInMemory(test.query.trim());
    
    // ============================================
    // Generate VALID inputs from valid data
    // ============================================
    try {
      const validSignedData = await signDataInMemory(test.validData.trim(), 'text/turtle');
      
      // Create binding from first quad
      const parser = new N3.Parser({ format: 'text/turtle' });
      const validQuads = parser.parse(test.validData.trim());
      
      if (validQuads.length > 0) {
        const quad = validQuads[0];
        const binding: Record<string, string> = {};
        
        for (const varName of metadata.variables) {
          if (varName === 's' || varName === 'subject') {
            binding[varName] = termToBindingString(quad.subject);
          } else if (varName === 'p' || varName === 'predicate') {
            binding[varName] = termToBindingString(quad.predicate);
          } else if (varName === 'o' || varName === 'object') {
            binding[varName] = termToBindingString(quad.object);
          } else {
            binding[varName] = termToBindingString(quad.subject);
          }
        }
        
        const checkBindingInputs = generateCheckBindingInputs(metadata, validSignedData, binding);
        
        if (checkBindingInputs) {
          validInputs = {
            public_key: [validSignedData.pubKey],
            roots: [{
              value: validSignedData.root,
              signature: validSignedData.signature,
            }],
            bgp: checkBindingInputs.bgp.map(t => ({
              terms: t.terms,
              path: t.path,
              directions: t.directions.map(d => (d ? 1 : 0) as 0 | 1),
            })),
            variables: checkBindingInputs.variables,
          };
        }
      }
    } catch (e: any) {
      console.warn(`  Warning: Could not generate valid inputs: ${e.message}`);
    }
    
    // ============================================
    // Generate INVALID inputs - EXPLICITLY DEFINED
    // ============================================
    try {
      const inv = test.invalidInputs;
      
      // Sign the data that will be used for the invalid triple's merkle proof
      const invalidSignedData = await signDataInMemory(inv.dataForSigning.trim(), 'text/turtle');
      
      // Encode the explicitly defined invalid triple
      const encodedSubject = encodeTerm(inv.triple.subject);
      const encodedPredicate = encodeTerm(inv.triple.predicate);
      const encodedObject = encodeTerm(inv.triple.object);
      const encodedGraph = encodeTerm(inv.triple.graph);
      
      // Encode the explicitly defined invalid variable bindings
      const encodedVariables: Record<string, string> = {};
      for (const [varName, term] of Object.entries(inv.variables)) {
        encodedVariables[varName] = encodeTerm(term);
      }
      
      // Create the invalid BGP using the signed data's merkle proof
      // but with the explicitly defined term encodings
      const invalidBgp = [{
        terms: [encodedSubject, encodedPredicate, encodedObject, encodedGraph],
        path: invalidSignedData.paths[0] || [],
        directions: (invalidSignedData.direction[0] || []).map(d => (d ? 1 : 0) as 0 | 1),
      }];
      
      invalidInputs = {
        public_key: [invalidSignedData.pubKey],
        roots: [{
          value: invalidSignedData.root,
          signature: invalidSignedData.signature,
        }],
        bgp: invalidBgp,
        variables: encodedVariables,
        expectedError: test.expectedError,
      };
      
    } catch (e: any) {
      console.warn(`  Warning: Could not generate invalid inputs: ${e.message}`);
    }
    
  } catch (e: any) {
    error = e.message;
  }
  
  return { test, validInputs, invalidInputs, error };
}

/**
 * Write test inputs to disk
 */
function writeTestFiles(inputs: GeneratedInputs): void {
  const testDir = path.join(OUTPUT_DIR, inputs.test.name);
  
  // Write test metadata
  fs.writeFileSync(
    path.join(testDir, 'test-metadata.json'),
    JSON.stringify({
      name: inputs.test.name,
      description: inputs.test.description,
      category: inputs.test.category,
      expectedError: inputs.test.expectedError,
      hasValidInputs: inputs.validInputs !== null,
      hasInvalidInputs: inputs.invalidInputs !== null,
      error: inputs.error,
    }, null, 2)
  );
  
  // Write valid inputs
  if (inputs.validInputs) {
    const validDir = path.join(testDir, 'valid_inputs');
    fs.mkdirSync(validDir, { recursive: true });
    fs.writeFileSync(
      path.join(validDir, 'case_1.json'),
      JSON.stringify(inputs.validInputs, null, 2)
    );
  }
  
  // Write invalid inputs
  if (inputs.invalidInputs) {
    const invalidDir = path.join(testDir, 'invalid_inputs');
    fs.mkdirSync(invalidDir, { recursive: true });
    fs.writeFileSync(
      path.join(invalidDir, 'explicit_mismatch.json'),
      JSON.stringify(inputs.invalidInputs, null, 2)
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('============================================================');
  console.log('Edge Case Test Generator (v2 - Explicit Invalid Inputs)');
  console.log('============================================================\n');
  
  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  
  // Generate all edge case tests
  const tests = generateEdgeCaseTestsV2();
  console.log(`Found ${tests.length} edge case test definitions\n`);
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const test of tests) {
    console.log(`[${test.category}/${test.name}]`);
    console.log(`  ${test.description}`);
    
    try {
      const inputs = await generateInputsForTest(test);
      
      if (inputs.error) {
        console.log(`  ⚠️  Error: ${inputs.error}`);
        errorCount++;
      } else {
        writeTestFiles(inputs);
        
        const validCount = inputs.validInputs ? 1 : 0;
        const invalidCount = inputs.invalidInputs ? 1 : 0;
        console.log(`  ✅ Generated: ${validCount} valid, ${invalidCount} invalid inputs`);
        successCount++;
      }
    } catch (e: any) {
      console.log(`  ❌ Failed: ${e.message}`);
      errorCount++;
    }
  }
  
  console.log('\n============================================================');
  console.log('Summary');
  console.log('============================================================');
  console.log(`Success: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Output: ${OUTPUT_DIR}`);
}

main().catch(console.error);
