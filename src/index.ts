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
import { UltraHonkBackend } from '@aztec/bb.js';
import { generateProofsInMemory } from './scripts/prove.js';
import { compile_program } from '@noir-lang/noir_wasm';
import type { CompiledCircuit } from '@noir-lang/noir_js';
import { getNoirLibFiles } from './noir-lib-bundle.js';

// --- Circuit Cache ---

/**
 * Cache for compiled circuits, keyed by query string.
 * This avoids recompiling the same query multiple times.
 */
const circuitCache = new Map<string, { circuit: CompiledCircuit; metadata: Record<string, unknown> }>();

/**
 * Simple hash function for cache keys (FNV-1a)
 */
function hashQuery(query: string): string {
  let hash = 2166136261;
  for (let i = 0; i < query.length; i++) {
    hash ^= query.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Clear the circuit cache (useful for testing or memory management)
 */
export function clearCircuitCache(): void {
  circuitCache.clear();
}

/**
 * Get the current circuit cache size
 */
export function getCircuitCacheSize(): number {
  return circuitCache.size;
}

// --- Path utilities (no filesystem access, just string manipulation) ---

function normalizePath(p: string): string {
  // Handle empty path
  if (!p) return '.';
  
  // Split path and filter out empty segments and '.'
  const parts = p.split(/[\\/]+/).filter(part => part && part !== '.');
  const result: string[] = [];
  
  for (const part of parts) {
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') {
        result.pop();
      } else if (!p.startsWith('/')) {
        result.push('..');
      }
    } else {
      result.push(part);
    }
  }
  
  const normalized = result.join('/');
  return p.startsWith('/') ? '/' + normalized : (normalized || '.');
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

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

// --- In-Memory FileManager for noir_wasm compilation ---

/**
 * In-memory filesystem for noir_wasm compilation.
 * Implements the FileManager interface without any disk I/O.
 */
class InMemoryFileManager {
  private files: Map<string, Uint8Array> = new Map();
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  getDataDir(): string {
    return this.dataDir;
  }

  private getPath(name: string): string {
    if (isAbsolutePath(name)) {
      return normalizePath(name);
    }
    return normalizePath(joinPath(this.dataDir, name));
  }

  existsSync(path: string): boolean {
    const normalizedPath = this.getPath(path);
    // Check for exact file match
    if (this.files.has(normalizedPath)) return true;
    // Check if path is a directory (any file starts with this path + /)
    const dirPrefix = normalizedPath.endsWith('/') ? normalizedPath : normalizedPath + '/';
    for (const key of this.files.keys()) {
      if (key.startsWith(dirPrefix) || key === normalizedPath) return true;
    }
    return false;
  }

  // Alias for existsSync - required by noir_wasm FileManager interface
  hasFileSync(path: string): boolean {
    return this.existsSync(path);
  }

  async writeFile(name: string, streamOrContent: ReadableStream<Uint8Array> | Uint8Array | string): Promise<void> {
    // Allow absolute paths within the dataDir for dependency caching
    const path = this.getPath(name);
    
    let content: Uint8Array;
    if (streamOrContent instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = streamOrContent.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      content = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
      }
    } else if (typeof streamOrContent === 'string') {
      content = new TextEncoder().encode(streamOrContent);
    } else {
      content = streamOrContent;
    }
    
    this.files.set(path, content);
  }

  async readFile(name: string, encoding?: 'utf-8'): Promise<Uint8Array | string> {
    const path = this.getPath(name);
    const content = this.files.get(path);
    if (!content) {
      throw new Error(`File not found: ${path}`);
    }
    if (encoding === 'utf-8') {
      return new TextDecoder().decode(content);
    }
    return content;
  }

  async mkdir(_dir: string, _opts?: { recursive?: boolean }): Promise<void> {
    // No-op for in-memory filesystem - directories are implicit
  }

  async rename(oldName: string, newName: string): Promise<void> {
    const oldPath = this.getPath(oldName);
    const newPath = this.getPath(newName);
    
    // Check if it's a single file
    const content = this.files.get(oldPath);
    if (content) {
      this.files.delete(oldPath);
      this.files.set(newPath, content);
      return;
    }
    
    // Check if it's a directory (any files start with oldPath/)
    const oldPrefix = oldPath.endsWith('/') ? oldPath : oldPath + '/';
    const newPrefix = newPath.endsWith('/') ? newPath : newPath + '/';
    const filesToMove: [string, Uint8Array][] = [];
    
    for (const [filePath, fileContent] of this.files.entries()) {
      if (filePath.startsWith(oldPrefix)) {
        filesToMove.push([filePath, fileContent]);
      }
    }
    
    if (filesToMove.length === 0) {
      throw new Error(`File not found: ${oldPath}`);
    }
    
    // Move all files in the directory
    for (const [filePath, fileContent] of filesToMove) {
      this.files.delete(filePath);
      const newFilePath = newPrefix + filePath.slice(oldPrefix.length);
      this.files.set(newFilePath, fileContent);
    }
  }

  // Alias for rename - required by noir_wasm FileManager interface
  async moveFile(oldName: string, newName: string): Promise<void> {
    return this.rename(oldName, newName);
  }

  async readdir(dir: string, options?: { recursive?: boolean }): Promise<string[]> {
    const dirPath = this.getPath(dir);
    const dirPrefix = dirPath.endsWith('/') ? dirPath : dirPath + '/';
    const results: string[] = [];
    
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(dirPrefix)) {
        const relativePath = filePath.slice(dirPrefix.length);
        if (options?.recursive) {
          results.push(joinPath(dir, relativePath));
        } else {
          // Only return immediate children
          const firstSlash = relativePath.indexOf('/');
          const entry = firstSlash === -1 ? relativePath : relativePath.slice(0, firstSlash);
          if (entry && !results.includes(entry)) {
            results.push(entry);
          }
        }
      }
    }
    
    return results;
  }
}

/**
 * Creates an in-memory FileManager populated with circuit files
 */
function createInMemoryFileManager(
  dataDir: string,
  files: Record<string, string>
): InMemoryFileManager {
  const fm = new InMemoryFileManager(dataDir);
  
  // Pre-populate files synchronously by converting to Uint8Array
  for (const [path, content] of Object.entries(files)) {
    const fullPath = isAbsolutePath(path) ? path : joinPath(dataDir, path);
    fm['files'].set(normalizePath(fullPath), new TextEncoder().encode(content));
  }
  
  return fm;
}

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
 */
export async function prove(
  query: string,
  signedDatasets: SignedData | SignedData[],
  config?: Partial<Config>
): Promise<ProveResult> {
  // Merge config with defaults
  const effectiveConfig = { ...defaultConfig, ...config };
  
  // Handle single dataset or array
  const datasets = Array.isArray(signedDatasets) ? signedDatasets : [signedDatasets];
  const signedData = datasets.length === 1 ? datasets[0]! : null;
  
  // TODO: Handle multiple datasets properly
  if (datasets.length > 1) {
    throw new Error('Multiple datasets not yet supported in API');
  }
  
  if (!signedData) {
    throw new Error('signedData is required');
  }
  
  // Check circuit cache first
  const cacheKey = hashQuery(query);
  let cached = circuitCache.get(cacheKey);
  
  if (!cached) {
    // Transform SPARQL query to Noir circuit code (in-memory)
    let wasmModule: any;
    try {
      const { default: loadModule } = await import('module');
      const { fileURLToPath } = await import('url');
      const modulePath = fileURLToPath(new URL('../transform/pkg/transform.cjs', import.meta.url));
      const moduleRequire = loadModule.createRequire(import.meta.url);
      wasmModule = moduleRequire(modulePath);
    } catch (error) {
      throw new Error('WASM transform module not found. Please build it first with: npm run build:wasm');
    }
    
    // Call transform (returns JSON string with sparql_nr, main_nr, nargo_toml, metadata)
    const transformResultJson = wasmModule.transform(query);
    const transformResult = JSON.parse(transformResultJson);
    
    if (transformResult.error) {
      throw new Error(`Circuit generation failed: ${transformResult.error}`);
    }
    
    // Get bundled noir/lib files for in-memory compilation
    const noirLibFiles = getNoirLibFiles();
    
    // Prepare all files for the in-memory filesystem
    const circuitFiles: Record<string, string> = {
      'Nargo.toml': transformResult.nargo_toml,
      'src/main.nr': transformResult.main_nr,
      'src/sparql.nr': transformResult.sparql_nr,
    };
    
    // Add all noir/lib files with correct paths (they're referenced as "../noir/lib/..." in Nargo.toml)
    for (const [relativePath, content] of Object.entries(noirLibFiles)) {
      circuitFiles[`../noir/lib/${relativePath}`] = content;
    }
    
    // Create in-memory FileManager with all circuit and library files
    const fm = createInMemoryFileManager('/circuit', circuitFiles);
    
    // Compile circuit using noir_wasm (completely in-memory)
    let compiledCircuit: CompiledCircuit;
    try {
      const compiledArtifacts = await compile_program(fm as any);
      compiledCircuit = (compiledArtifacts.program || compiledArtifacts) as CompiledCircuit;
      if (!compiledCircuit || !compiledCircuit.bytecode) {
        throw new Error('Compilation produced no bytecode');
      }
    } catch (error) {
      throw new Error(`Circuit compilation failed: ${(error as Error).message}`);
    }
    
    // Cache the compiled circuit
    cached = { circuit: compiledCircuit, metadata: transformResult.metadata };
    circuitCache.set(cacheKey, cached);
  }
  
  // Generate proof using cached circuit
  const result = await generateProofsInMemory({
    compiledCircuit: cached.circuit,
    metadata: cached.metadata,
    signedData,
  });
  
  // Attach compiled circuit to each proof for verification
  if (result.proofs) {
    for (const proof of result.proofs) {
      (proof as ProofOutputWithCircuit).compiledCircuit = cached.circuit;
    }
  }
  
  return result;
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
