/**
 * SPARQL Noir - Zero-knowledge proofs for SPARQL query results
 * 
 * This is the main API entry point for the sparql_noir package.
 */

import type { SignedData, SignOptions } from './scripts/sign.js';
import type { ProveOptions, ProofOutput, ProveResult } from './scripts/prove.js';
import type { VerifyOptions, VerifyResult } from './scripts/verify.js';
import { defaultConfig } from './config.js';

// Export core functionality
export { signRdfData, processRdfDataWithoutSigning } from './scripts/sign.js';
export { generateProofs } from './scripts/prove.js';
export { verifyProofs } from './scripts/verify.js';

// Export types
export type { SignedData, SignOptions, ProveOptions, ProofOutput, ProveResult, VerifyOptions, VerifyResult };

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
 * Sign an RDF dataset, producing a signed dataset with Merkle root and signature.
 * 
 * @param dataset - Path to the RDF dataset file (Turtle/N-Quads)
 * @param config - Optional configuration (uses defaults if not provided)
 * @returns Signed dataset with Merkle root, signature, and encoded triples
 * 
 * @example
 * ```typescript
 * import { sign } from '@jeswr/sparql-noir';
 * 
 * const signed = await sign('data.ttl');
 * console.log('Root:', signed.root);
 * console.log('Signature:', signed.signature);
 * ```
 */
export async function sign(
  dataset: string,
  config?: Partial<Config>
): Promise<SignedData> {
  // TODO: Apply config if provided (currently uses defaultConfig)
  const { signRdfData } = await import('./scripts/sign.js');
  return signRdfData(dataset);
}

/**
 * Generate a zero-knowledge proof that a SPARQL query holds over signed datasets.
 * 
 * @param query - SPARQL SELECT query string
 * @param circuitDir - Path to the compiled circuit directory
 * @param signedDatasets - Array of signed datasets to query
 * @param config - Optional configuration
 * @returns Proof object with proof bytes, verification key, and metadata
 * 
 * @example
 * ```typescript
 * import { prove } from '@jeswr/sparql-noir';
 * 
 * const proof = await prove(
 *   'SELECT ?name WHERE { ?person foaf:name ?name }',
 *   './circuit',
 *   [signedDataset]
 * );
 * ```
 */
export async function prove(
  circuitDir: string,
  signedDatasets: SignedData | SignedData[] | null,
  config?: Partial<Config>
): Promise<ProveResult> {
  const { generateProofs } = await import('./scripts/prove.js');
  
  // Handle single dataset or array
  const datasets = signedDatasets 
    ? (Array.isArray(signedDatasets) ? signedDatasets : [signedDatasets])
    : null;
  const signedData = datasets && datasets.length === 1 ? datasets[0]! : null;
  
  // TODO: Handle multiple datasets properly
  if (datasets && datasets.length > 1) {
    throw new Error('Multiple datasets not yet supported in API');
  }
  
  return generateProofs({
    circuitDir,
    signedData,
  });
}

/**
 * Verify a proof is valid.
 * 
 * @param circuitDir - Path to the compiled circuit directory
 * @param proof - Proof object to verify
 * @param config - Optional configuration
 * @returns Verification result indicating if the proof is valid
 * 
 * @example
 * ```typescript
 * import { verify } from '@jeswr/sparql-noir';
 * 
 * const result = await verify('./circuit', proof);
 * if (result.success) {
 *   console.log('Proof is valid!');
 * }
 * ```
 */
export async function verify(
  circuitDir: string,
  proof: ProveResult,
  config?: Partial<Config>
): Promise<VerifyResult> {
  const { verifyProofs } = await import('./scripts/verify.js');
  
  return verifyProofs({
    circuitDir,
    proofData: proof,
  });
}

/**
 * Get disclosure information for a query and configuration.
 * Returns information about what will be disclosed vs. hidden in the proof.
 * 
 * @param query - SPARQL SELECT query string
 * @param config - Optional configuration
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
  // Parse the query to extract variables
  // TODO: Implement proper SPARQL parsing to determine disclosed vs hidden variables
  
  // For now, return a basic implementation
  const selectMatch = query.match(/SELECT\s+(.*?)\s+WHERE/i);
  const variables = selectMatch 
    ? selectMatch[1]!.match(/\?(\w+)/g)?.map(v => v.substring(1)) || []
    : [];
  
  return {
    query,
    merkleDepth: config?.merkleDepth || defaultConfig.merkleDepth,
    pathSegmentMax: 8, // Default from spec
    signatureScheme: config?.signature || defaultConfig.signature,
    disclosedVariables: variables,
    hiddenVariables: [], // All projected variables are disclosed by default
    summary: `This query discloses ${variables.length} variable(s): ${variables.join(', ')}. ` +
             `Merkle depth: ${config?.merkleDepth || defaultConfig.merkleDepth}, ` +
             `Signature: ${config?.signature || defaultConfig.signature}.`
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


