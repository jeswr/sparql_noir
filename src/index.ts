/**
 * SPARQL Noir - Zero-knowledge proofs for SPARQL query results
 * 
 * This is the main API entry point for the sparql_noir package.
 */

import type { Quad, DatasetCore } from '@rdfjs/types';
import type { SignedData } from './scripts/sign.js';
import type { ProveResult } from './scripts/prove.js';
import type { VerifyResult } from './scripts/verify.js';
import { defaultConfig } from './config.js';
import N3 from 'n3';
import { RDFC10 } from 'rdfjs-c14n';

// Export core functionality for advanced use
export { processQuadsForMerkle } from './scripts/sign.js';
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
 * Sign an RDF dataset, producing a signed dataset with Merkle root and signature.
 * 
 * @param dataset - RDF/JS DatasetCore containing the quads to sign
 * @param config - Optional configuration (uses defaults if not provided)
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
  // TODO: Apply config if provided (currently uses defaultConfig)
  const { processQuadsForMerkle } = await import('./scripts/sign.js');
  const { runJson } = await import('./encode.js');
  const crypto = (await import('crypto')).default;
  const secp256k1 = (await import('secp256k1')).default;
  // @ts-expect-error - secp256r1 has no type definitions
  const secp256r1 = (await import('secp256r1')).default;
  const { EdDSAPoseidon } = await import('@zk-kit/eddsa-poseidon');
  const { Base8, mulPointEscalar } = await import('@zk-kit/baby-jubjub');
  const { Schnorr } = await import('@aztec/foundation/crypto');
  const { Fq } = await import('@aztec/foundation/fields');
  const { quadToStringQuad } = await import('rdf-string-ttl');
  
  // Convert dataset to canonicalized quads
  const quads = (new N3.Parser()).parse(await new RDFC10().canonicalize(dataset));
  
  // Process quads for Merkle tree
  const { triples, noirInput } = await processQuadsForMerkle(quads);
  
  // Generate Merkle tree via Noir execution
  const jsonRes = runJson(`[${noirInput}]`)[0];
  
  // Add quad string representations
  jsonRes.nquads = quads.map((quad: Quad) => quadToStringQuad(quad));
  
  // Generate cryptographic signature
  let privKey = crypto.randomBytes(32);

  if (defaultConfig.signature === 'secp256k1' || defaultConfig.signature === 'secp256r1') {
    const pkg = defaultConfig.signature === 'secp256k1' ? secp256k1 : secp256r1;
    while (!pkg.privateKeyVerify(privKey))
      privKey = crypto.randomBytes(32);

    const pubKey = pkg.publicKeyCreate(privKey, false);
    const sigObj = (pkg.ecdsaSign || pkg.sign)(Buffer.from(jsonRes.root_u8), privKey);
    jsonRes.signature = Array.from(sigObj.signature);
    jsonRes.pubKey = {
      x: Array.from(pubKey.slice(1, 33)),
      y: Array.from(pubKey.slice(33, 65)),
    };
  } else if (defaultConfig.signature === 'babyjubjubOpt') {
    const ed = new EdDSAPoseidon(privKey);
    const signature = ed.signMessage(jsonRes.root);

    const left = mulPointEscalar(Base8, signature.S);
    const k8 = mulPointEscalar(ed.publicKey, 8n);

    jsonRes.signature = {
      r: {
        x: '0x' + signature.R8[0].toString(16),
        y: '0x' + signature.R8[1].toString(16),
      },
      left: {
        x: '0x' + left[0].toString(16),
        y: '0x' + left[1].toString(16),
      },
      s: '0x' + signature.S.toString(16),
    };
    jsonRes.pubKey = {
      value: {
        x: '0x' + ed.publicKey[0].toString(16),
        y: '0x' + ed.publicKey[1].toString(16),
      },
      k8: {
        x: '0x' + k8[0].toString(16),
        y: '0x' + k8[1].toString(16),
      },
    };
  } else if (defaultConfig.signature === 'schnorr') {
    const schnorr = new Schnorr();
    const schnorrPrivKey = Fq.random();

    const messageBuf = Buffer.from(jsonRes.root_u8);
    const signature = await schnorr.constructSignature(messageBuf, schnorrPrivKey);
    const publicKey = await schnorr.computePublicKey(schnorrPrivKey);

    jsonRes.signature = Array.from(signature.toBuffer());
    jsonRes.pubKey = {
      x: publicKey.x.toJSON(),
      y: publicKey.y.toJSON(),
      is_infinite: false,
    };
  } else {
    throw new Error(`Unsupported signature type: ${defaultConfig.signature}`);
  }

  delete jsonRes.root_u8;

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
 */
export async function prove(
  query: string,
  signedDatasets: SignedData | SignedData[],
  config?: Partial<Config>
): Promise<ProveResult> {
  const fs = (await import('fs')).default;
  const path = (await import('path')).default;
  const os = (await import('os')).default;
  const { execSync } = await import('child_process');
  const { generateProofs } = await import('./scripts/prove.js');
  
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
    
    // Generate circuit using transform
    const circuitDir = path.join(tmpDir, 'circuit');
    const transformCmd = `cargo run --manifest-path ${path.join(process.cwd(), 'transform/Cargo.toml')} -- -q ${queryFile} -o ${circuitDir}`;
    execSync(transformCmd, { stdio: 'pipe' });
    
    // Compile circuit
    execSync(`cd ${circuitDir} && nargo compile`, { stdio: 'pipe' });
    
    // Read compiled circuit
    const targetDir = path.join(circuitDir, 'target');
    const circuitFiles = fs.readdirSync(targetDir).filter((f: string) => f.endsWith('.json'));
    if (circuitFiles.length === 0) {
      throw new Error('No compiled circuit found');
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
        (proof as any).compiledCircuit = compiledCircuit;
      }
    }
    
    return result;
  } finally {
    // Clean up temporary directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Verify a proof is valid.
 * 
 * @param proof - Proof object to verify (must include compiled circuit from prove())
 * @param config - Optional configuration
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
  const { UltraHonkBackend } = await import('@aztec/bb.js');
  
  // Verify each proof in the result
  let verifiedCount = 0;
  let failedCount = 0;
  const proofs = proof.proofs || [];
  
  for (const proofItem of proofs) {
    try {
      // Get the compiled circuit from the proof
      const compiledCircuit = (proofItem as any).compiledCircuit;
      if (!compiledCircuit) {
        throw new Error('Proof does not contain compiled circuit information. Make sure to use the proof returned from prove().');
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
        failedCount++;
      }
    } catch (error) {
      failedCount++;
    }
  }
  
  return {
    verified: verifiedCount,
    failed: failedCount,
    total: proofs.length,
    success: failedCount === 0,
  };
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


