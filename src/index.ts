/**
 * SPARQL Noir - Zero-knowledge proofs for SPARQL query results
 * 
 * This is the main API entry point for the sparql_noir package.
 */

import type { Quad, DatasetCore } from '@rdfjs/types';
import type { SignedData } from './scripts/sign.js';
import type { ProveResult, ProofOutput } from './scripts/prove.js';
import type { VerifyResult } from './scripts/verify.js';
import { defaultConfig } from './config.js';
import N3 from 'n3';
import { RDFC10 } from 'rdfjs-c14n';
import { processQuadsForMerkle, generateSignature } from './scripts/sign.js';
import { runJson } from './encode.js';
import { quadToStringQuad } from 'rdf-string-ttl';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { UltraHonkBackend } from '@aztec/bb.js';
import { generateProofs } from './scripts/prove.js';

// Export core functionality for advanced use
export { processQuadsForMerkle, generateSignature } from './scripts/sign.js';
export { generateProofs } from './scripts/prove.js';
export { verifyProofs } from './scripts/verify.js';

// Export types
export type { SignedData, ProveResult, VerifyResult };

// Export configuration
export { defaultConfig, stringHashes, fieldHashes, merkleDepths, signatures } from './config.js';

// Export encoding utilities
export { 
  encodeString, 
  encodeNamedNode, 
  encodeDatatypeIri,
  getTermEncodingString 
} from './encode.js';

/**
 * Configuration options for SPARQL Noir
 */
export interface Config {
  /** Hash function for strings (blake3, sha256, keccak256, etc.) */
  stringHash: string;
  /** Hash function for field elements (pedersen, poseidon2, mimc, etc.) */
  fieldHash: string;
  /** Merkle tree depth (determines max number of triples: 2^depth) */
  merkleDepth: number;
  /** Signature scheme (schnorr, secp256k1, secp256r1, babyjubjubOpt) */
  signature: string;
  /** String hash output size in bytes */
  stringHashOutputSize: number;
}

/**
 * Extended ProofOutput with compiled circuit for verification
 */
interface ProofOutputWithCircuit extends ProofOutput {
  compiledCircuit?: any;
}

/**
 * Sign an RDF dataset, producing a signed dataset with Merkle root and signature.
 * 
 * @param dataset - RDF/JS DatasetCore containing the quads to sign
 * @param config - Optional configuration (hash functions, signature scheme, merkle depth)
 * @returns Signed dataset with Merkle root, signature, and encoded triples
 * 
 * @example
 * ```typescript
 * import { sign } from '@jeswr/sparql-noir';
 * import { Store } from 'n3';
 * 
 * const store = new Store();
 * // ... add triples to store
 * const signed = await sign(store);
 * console.log('Root:', signed.root);
 * console.log('Signature:', signed.signature);
 * ```
 */
export async function sign(
  dataset: DatasetCore,
  config?: Partial<Config>
): Promise<SignedData> {
  // Merge config with defaults
  const effectiveConfig = { ...defaultConfig, ...config };
  
  // Convert dataset to canonicalized quads
  const quads = (new N3.Parser()).parse(await new RDFC10().canonicalize(dataset));
  
  // Process quads for Merkle tree
  const { noirInput } = await processQuadsForMerkle(quads);
  
  // Generate Merkle tree via Noir execution
  const jsonRes = runJson(`[${noirInput}]`)[0];
  
  // Add quad string representations
  jsonRes.nquads = quads.map((quad: Quad) => quadToStringQuad(quad));
  
  // Generate cryptographic signature using shared logic
  await generateSignature(jsonRes, effectiveConfig.signature);

  return jsonRes as SignedData;
}

/**
 * Generate a zero-knowledge proof that a SPARQL query holds over signed datasets.
 * 
 * @param query - SPARQL SELECT query string
 * @param signedDatasets - Signed dataset(s) to query over
 * @param config - Optional configuration
 * @returns Proof object with proof bytes, verification key, and metadata
 * 
 * @example
 * ```typescript
 * import { prove } from '@jeswr/sparql-noir';
 * 
 * const proof = await prove(
 *   'SELECT ?name WHERE { ?person foaf:name ?name }',
 *   signedDataset
 * );
 * ```
 * 
 * @note Requires Nargo to be installed for circuit compilation
 */
export async function prove(
  query: string,
  signedDatasets: SignedData | SignedData[],
  config?: Partial<Config>
): Promise<ProveResult> {
  // Merge config with defaults
  const effectiveConfig = { ...defaultConfig, ...config };
  
  // Validate Nargo installation
  try {
    const { execSync } = await import('child_process');
    execSync('nargo --version', { stdio: 'pipe' });
  } catch (error) {
    throw new Error('Nargo is not installed or not in PATH. Please install Nargo from https://noir-lang.org/docs/getting_started/installation/');
  }
  
  // Handle single dataset or array
  const datasets = Array.isArray(signedDatasets) ? signedDatasets : [signedDatasets];
  const signedData = datasets.length === 1 ? datasets[0]! : null;
  
  // TODO: Handle multiple datasets properly
  if (datasets.length > 1) {
    throw new Error('Multiple datasets not yet supported in API');
  }
  
  // Create temporary directory for circuit generation
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-noir-'));
  
  try {
    // Write query to temporary file
    const queryFile = path.join(tmpDir, 'query.rq');
    fs.writeFileSync(queryFile, query);
    
    // Use WASM to generate circuit
    const circuitDir = path.join(tmpDir, 'circuit');
    try {
      // Try to import the WASM module if it exists (using dynamic import with variable to avoid TS checking)
      const wasmPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../transform/pkg/transform.cjs');
      let wasmModule: any;
      try {
        const { default: loadModule } = await import('module');
        const moduleRequire = loadModule.createRequire(import.meta.url);
        wasmModule = moduleRequire(wasmPath);
      } catch (error) {
        throw new Error('WASM transform module not found. Please build it first with: npm run build:wasm');
      }
      
      const output = wasmModule.transform_query(query, circuitDir);
      if (!output || output.error) {
        throw new Error(`Circuit generation failed: ${output?.error || 'Unknown error'}`);
      }
    } catch (error) {
      throw new Error(`Failed to generate circuit using WASM: ${(error as Error).message}`);
    }
    
    // Compile circuit with Nargo
    const { execSync } = await import('child_process');
    try {
      execSync('nargo compile', { 
        cwd: circuitDir,
        stdio: 'pipe'
      });
    } catch (error) {
      throw new Error(`Circuit compilation failed: ${(error as Error).message}`);
    }
    
    // Read compiled circuit
    const targetDir = path.join(circuitDir, 'target');
    const circuitFiles = fs.readdirSync(targetDir).filter((f: string) => f.endsWith('.json'));
    if (circuitFiles.length === 0) {
      throw new Error('No compiled circuit found after compilation');
    }
    const compiledCircuit = JSON.parse(fs.readFileSync(path.join(targetDir, circuitFiles[0]!), 'utf8'));
    
    // Generate proof
    const result = await generateProofs({
      circuitDir,
      signedData,
    });
    
    // Attach compiled circuit to each proof for verification
    if (result.proofs) {
      for (const proof of result.proofs) {
        (proof as ProofOutputWithCircuit).compiledCircuit = compiledCircuit;
      }
    }
    
    return result;
  } finally {
    // Clean up temporary directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
      console.warn(`Failed to clean up temporary directory: ${(error as Error).message}`);
    }
  }
}

/**
 * Verify a proof is valid.
 * 
 * @param proof - Proof object to verify (must include compiled circuit from prove())
 * @param config - Optional configuration (currently unused but reserved for future use)
 * @returns Verification result indicating if the proof is valid
 * 
 * @example
 * ```typescript
 * import { verify } from '@jeswr/sparql-noir';
 * 
 * const result = await verify(proof);
 * if (result.success) {
 *   console.log('Proof is valid!');
 * }
 * ```
 */
export async function verify(
  proof: ProveResult,
  config?: Partial<Config>
): Promise<VerifyResult> {
  // Verify each proof in the result
  let verifiedCount = 0;
  let failedCount = 0;
  const proofs = proof.proofs || [];
  const errors: string[] = [];
  
  for (let i = 0; i < proofs.length; i++) {
    const proofItem = proofs[i]!;
    try {
      // Get the compiled circuit from the proof
      const compiledCircuit = (proofItem as ProofOutputWithCircuit).compiledCircuit;
      if (!compiledCircuit) {
        const error = `Proof ${i + 1} does not contain compiled circuit information. Make sure to use the proof returned from prove().`;
        errors.push(error);
        throw new Error(error);
      }
      
      const backend = new UltraHonkBackend(compiledCircuit.bytecode, { threads: 6 });
      
      const proofData = {
        proof: proofItem.proof instanceof Uint8Array
          ? proofItem.proof
          : new Uint8Array(proofItem.proof),
        publicInputs: proofItem.publicInputs as string[],
      };
      
      const isValid = await backend.verifyProof(proofData);
      backend.destroy();
      
      if (isValid) {
        verifiedCount++;
      } else {
        const error = `Proof ${i + 1} verification failed: invalid proof`;
        errors.push(error);
        failedCount++;
      }
    } catch (error) {
      const errorMsg = `Proof ${i + 1} verification error: ${(error as Error).message}`;
      errors.push(errorMsg);
      failedCount++;
    }
  }
  
  return {
    verified: verifiedCount,
    failed: failedCount,
    total: proofs.length,
    success: failedCount === 0,
    errors: errors.length > 0 ? errors : undefined,
  } as VerifyResult;
}

/**
 * Get disclosure information for a query and configuration.
 * Returns information about what will be disclosed vs. hidden in the proof.
 * 
 * @param query - SPARQL SELECT query string
 * @param config - Optional configuration (hash functions, signature scheme, merkle depth)
 * @returns Disclosure information including disclosed and hidden variables
 * 
 * @example
 * ```typescript
 * import { info } from '@jeswr/sparql-noir';
 * 
 * const disclosure = info('SELECT ?name WHERE { ?person foaf:name ?name }');
 * console.log('Disclosed variables:', disclosure.disclosedVariables);
 * console.log('Hidden variables:', disclosure.hiddenVariables);
 * ```
 */
export function info(
  query: string,
  config?: Partial<Config>
): DisclosureInfo {
  // Merge config with defaults
  const effectiveConfig = { ...defaultConfig, ...config };
  
  // Parse the query to extract variables
  // TODO: Use proper SPARQL parser (spargebra) for more robust parsing
  const selectMatch = query.match(/SELECT\s+(.*?)\s+WHERE/is);
  const variables = selectMatch 
    ? selectMatch[1]!.match(/\?(\w+)/g)?.map(v => v.substring(1)) || []
    : [];
  
  return {
    query,
    merkleDepth: effectiveConfig.merkleDepth,
    pathSegmentMax: 8, // Default from spec
    signatureScheme: effectiveConfig.signature,
    disclosedVariables: variables,
    hiddenVariables: [], // All projected variables are disclosed by default
    summary: `This query discloses ${variables.length} variable(s): ${variables.join(', ')}. ` +
             `Merkle depth: ${effectiveConfig.merkleDepth}, ` +
             `Signature: ${effectiveConfig.signature}.`
  };
}

/**
 * Disclosure information for a query and configuration
 */
export interface DisclosureInfo {
  /** The SPARQL query (always disclosed) */
  query: string;
  /** Merkle tree depth disclosed */
  merkleDepth: number;
  /** Maximum property path segment length */
  pathSegmentMax: number;
  /** Signature scheme used */
  signatureScheme: string;
  /** Variables that will be disclosed in the proof */
  disclosedVariables: string[];
  /** Variables that will remain hidden */
  hiddenVariables: string[];
  /** Human-readable summary */
  summary: string;
}
