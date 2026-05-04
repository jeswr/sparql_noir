/**
 * Generate checkBinding circuit inputs from query, data, and expected bindings.
 * 
 * This module extracts the logic needed to prepare inputs for the Noir checkBinding
 * function, which is used to verify SPARQL query results in zero-knowledge.
 * 
 * The checkBinding function requires:
 * - BGP: Array of Triple objects (terms + merkle proof path + directions)
 * - Variables: Projected variable bindings as Field values
 * - Hidden: Optional hidden values for filter comparisons
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import N3 from 'n3';
import type { Term, Quad, Literal } from '@rdfjs/types';
import { stringQuadToQuad } from 'rdf-string-ttl';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Re-export useful types
export interface TermJson {
  termType: 'NamedNode' | 'BlankNode' | 'Literal' | 'Variable' | 'DefaultGraph';
  value?: string;
  language?: string;
  datatype?: { termType: 'NamedNode'; value: string };
}

export interface PatternJson {
  subject: TermJson;
  predicate: TermJson;
  object: TermJson;
  graph: TermJson;
}

export interface CircuitMetadata {
  variables: string[];
  inputPatterns: PatternJson[];
  optionalPatterns: PatternJson[];
  unionBranches: PatternJson[][];
  hiddenInputs: Record<string, string>;
}

export interface SignedDataTriple {
  terms: string[];      // [s, p, o, g] as hex field encodings
  path: string[];       // Merkle proof path
  directions: boolean[]; // Path directions (left/right)
}

export interface SignedData {
  triples: string[][];   // Per-triple term encodings
  paths: string[][];     // Per-triple merkle paths
  direction: boolean[][]; // Per-triple path directions
  root: string;          // Merkle root
  signature: number[] | object;
  pubKey: object;
  nquads: string[];      // Original n-quads as strings
}

/**
 * Round-1 default for the bounded byte-array witness bound. Mirrors
 * `noir/lib/consts::STRING_LEN_MAX` and `DEFAULT_STRING_LEN_MAX` in
 * `src/config.ts`. The TS pipeline currently emits zero-padded
 * placeholder witnesses (`bytes: [0, ...]`, `length: 0`); round-2 will
 * populate them with real lexical bytes from the source quad. See
 * `spec/encoding.md` sec.6 for the contract.
 */
export const STRING_LEN_MAX = 64;

/**
 * Per-term witness in the JSON form Noir's input loader expects. The
 * `hash` field carries the term's Enc_t result (the same hex-encoded
 * Field that previous versions stored as `terms[i]`); `bytes` /
 * `length` are the bounded byte-array witness defined in
 * `spec/encoding.md` sec.6.2.
 */
export interface TermWitness {
  hash: string;
  bytes: number[];
  length: number;
}

export interface BGPTriple {
  terms: TermWitness[];
  path: string[];
  directions: boolean[];
}

/**
 * Wrap a bare term-hash hex string as a round-1 placeholder
 * `TermWitness` (zero-padded bytes, `length: 0`). Use this whenever
 * legacy code only carries the hash; the byte witness is unconstrained
 * at the Triple level (see `spec/encoding.md` sec.6.3) so a zero
 * placeholder is sound until a string operator binds it locally.
 */
export function termHashToWitness(hash: string, stringLenMax: number = STRING_LEN_MAX): TermWitness {
  return {
    hash,
    bytes: new Array(stringLenMax).fill(0),
    length: 0,
  };
}

export interface CheckBindingInputs {
  bgp: BGPTriple[];
  variables: Record<string, string>;
  hidden?: Record<string, string>;
}

const DF = N3.DataFactory;

/**
 * Convert a TermJson to an RDF.js Term
 */
export function termJsonToRdfTerm(tj: TermJson): Term {
  switch (tj.termType) {
    case 'NamedNode':
      return DF.namedNode(tj.value!);
    case 'BlankNode':
      return DF.blankNode(tj.value!);
    case 'Literal':
      return DF.literal(tj.value!, tj.datatype ? DF.namedNode(tj.datatype.value) : undefined);
    case 'Variable':
      return DF.variable(tj.value!);
    case 'DefaultGraph':
      return DF.defaultGraph();
    default:
      throw new Error(`Unknown term type: ${tj.termType}`);
  }
}

/**
 * Convert a binding value string (like "<http://ex.org>" or "\"value\"") to an RDF.js Term
 */
export function bindingValueToTerm(value: string): Term {
  if (value.startsWith('<') && value.endsWith('>')) {
    return DF.namedNode(value.slice(1, -1));
  }
  if (value.startsWith('_:')) {
    return DF.blankNode(value.slice(2));
  }
  if (value.startsWith('"')) {
    // Parse literal with optional language tag or datatype
    const langMatch = value.match(/^"(.+)"@(\w+)$/);
    if (langMatch) {
      return DF.literal(langMatch[1], langMatch[2]);
    }
    const dtMatch = value.match(/^"(.+)"\^\^<(.+)>$/);
    if (dtMatch) {
      return DF.literal(dtMatch[1], DF.namedNode(dtMatch[2]));
    }
    // Simple literal
    return DF.literal(value.slice(1, -1));
  }
  // Fallback: treat as literal value
  return DF.literal(value);
}

/**
 * Check if two terms are equal (ignoring blank node labels)
 */
function equalTermIgnoreBlankLabel(a: Term, b: Term): boolean {
  if (a.termType !== b.termType) return false;
  switch (a.termType) {
    case 'NamedNode':
      return a.value === (b as typeof a).value;
    case 'BlankNode':
      return true; // Treat any blank node as equal
    case 'Literal': {
      const al = a as Literal;
      const bl = b as Literal;
      return al.value === bl.value &&
        (al.language || '') === (bl.language || '') &&
        ((al.datatype?.value) || '') === ((bl.datatype?.value) || '');
    }
    case 'DefaultGraph':
      return true;
    case 'Variable':
      return a.value === (b as typeof a).value;
    default:
      return false;
  }
}

/**
 * Check if two quads are equal (ignoring blank node labels)
 */
function equalQuadIgnoreBlankLabel(q1: Quad, q2: Quad): boolean {
  return equalTermIgnoreBlankLabel(q1.subject, q2.subject) &&
    equalTermIgnoreBlankLabel(q1.predicate, q2.predicate) &&
    equalTermIgnoreBlankLabel(q1.object, q2.object) &&
    equalTermIgnoreBlankLabel(q1.graph, q2.graph);
}

/**
 * Check if a quad matches a pattern with the given binding
 */
function quadMatchesPattern(
  quad: Quad,
  pattern: PatternJson,
  binding: Record<string, Term>
): boolean {
  const positions = ['subject', 'predicate', 'object', 'graph'] as const;
  
  for (const pos of positions) {
    const patternTerm = pattern[pos];
    const quadTerm = quad[pos];
    
    if (patternTerm.termType === 'Variable') {
      // Variable - check if it's bound
      const boundTerm = binding[patternTerm.value!];
      if (boundTerm) {
        if (!equalTermIgnoreBlankLabel(boundTerm, quadTerm)) {
          return false;
        }
      }
    } else if (patternTerm.termType === 'DefaultGraph') {
      // DefaultGraph matches any graph
      continue;
    } else {
      // Concrete term - must match
      const rdfTerm = termJsonToRdfTerm(patternTerm);
      if (!equalTermIgnoreBlankLabel(rdfTerm, quadTerm)) {
        return false;
      }
    }
  }
  
  return true;
}

/**
 * Convert a binding (map of variable names to string values) to RDF.js terms
 */
export function parseBinding(binding: Record<string, string>): Map<string, Term> {
  const result = new Map<string, Term>();
  for (const [varName, value] of Object.entries(binding)) {
    result.set(varName, bindingValueToTerm(value));
  }
  return result;
}

/**
 * Generate checkBinding inputs from query, signed data, and a binding
 * This uses backtracking to find a consistent set of triples that satisfy all patterns
 * while respecting shared variable constraints.
 */
export function generateCheckBindingInputs(
  metadata: CircuitMetadata,
  signedData: SignedData,
  binding: Record<string, string>
): CheckBindingInputs | null {
  // Parse quads from signed data
  const quadArr = signedData.nquads.map(nq => stringQuadToQuad(nq));
  
  // Parse binding to RDF terms
  const bindingMap = parseBinding(binding);
  
  // Convert patterns to RDF terms
  const patterns = metadata.inputPatterns || metadata.inputPatterns;
  
  // Use backtracking to find consistent variable bindings across all patterns
  // variableBindings maps variable name -> encoded Field value
  type VariableBindings = Map<string, string>;
  
  /**
   * Try to find a consistent set of matched triples using backtracking
   */
  function findConsistentMatches(
    patternIdx: number,
    matchedIndices: number[],
    varBindings: VariableBindings
  ): number[] | null {
    if (patternIdx >= patterns.length) {
      // Successfully matched all patterns
      return matchedIndices;
    }
    
    const pattern = patterns[patternIdx];
    const positions = ['subject', 'predicate', 'object', 'graph'] as const;
    
    // Try each quad
    for (let quadIdx = 0; quadIdx < quadArr.length; quadIdx++) {
      const quad = quadArr[quadIdx];
      
      // Check if this quad matches the pattern with current variable bindings
      let matches = true;
      const newVarBindings = new Map(varBindings);
      
      for (let posIdx = 0; posIdx < positions.length; posIdx++) {
        const pos = positions[posIdx];
        const patternTerm = pattern[pos];
        const quadTerm = quad[pos];
        const encodedValue = signedData.triples[quadIdx][posIdx];
        
        if (patternTerm.termType === 'Variable') {
          const varName = patternTerm.value!;
          
          // Check if this variable is in the binding (projected variable)
          const boundTerm = bindingMap.get(varName);
          if (boundTerm && !equalTermIgnoreBlankLabel(boundTerm, quadTerm)) {
            matches = false;
            break;
          }
          
          // Check if this variable was already bound in a previous pattern
          const existingEncoded = newVarBindings.get(varName);
          if (existingEncoded !== undefined) {
            // Variable already bound - must match
            if (existingEncoded !== encodedValue) {
              matches = false;
              break;
            }
          } else {
            // Bind this variable
            newVarBindings.set(varName, encodedValue);
          }
        } else if (patternTerm.termType === 'DefaultGraph') {
          // DefaultGraph matches any graph
          continue;
        } else {
          // Concrete term - must match
          const rdfTerm = termJsonToRdfTerm(patternTerm);
          if (!equalTermIgnoreBlankLabel(rdfTerm, quadTerm)) {
            matches = false;
            break;
          }
        }
      }
      
      if (matches) {
        // Try to match remaining patterns with this binding
        const result = findConsistentMatches(
          patternIdx + 1,
          [...matchedIndices, quadIdx],
          newVarBindings
        );
        if (result) {
          return result;
        }
      }
    }
    
    // No consistent match found for this pattern
    return null;
  }
  
  const matchedIndices = findConsistentMatches(0, [], new Map());
  
  if (!matchedIndices) {
    // No consistent set of matches found
    return null;
  }
  
  // Build BGP triples from matched indices. Round-1: each term hash
  // is wrapped in a placeholder `TermWitness` with zero-padded bytes
  // (advisory at the Triple level; see `spec/encoding.md` sec.6.3).
  const bgpTriples: BGPTriple[] = matchedIndices.map(idx => ({
    terms: signedData.triples[idx].map(h => termHashToWitness(h)),
    path: signedData.paths[idx],
    directions: signedData.direction[idx],
  }));
  
  // Build variables object - only include projected variables
  const variables: Record<string, string> = {};
  
  for (const varName of metadata.variables) {
    // Find which pattern position this variable appears in
    for (let patternIdx = 0; patternIdx < patterns.length; patternIdx++) {
      const pattern = patterns[patternIdx];
      const positions = ['subject', 'predicate', 'object', 'graph'] as const;
      
      for (let posIdx = 0; posIdx < positions.length; posIdx++) {
        const pos = positions[posIdx];
        const patternTerm = pattern[pos];
        
        if (patternTerm.termType === 'Variable' && patternTerm.value === varName) {
          // Get the encoded value from the matched triple
          const triple = bgpTriples[patternIdx];
          if (triple && triple.terms[posIdx]) {
            variables[varName] = triple.terms[posIdx].hash;
          }
          break;
        }
      }
      
      if (variables[varName]) break;
    }
  }
  
  // Build hidden values from metadata
  const hidden: Record<string, string> | undefined = 
    Object.keys(metadata.hiddenInputs || {}).length > 0 
      ? metadata.hiddenInputs 
      : undefined;
  
  return {
    bgp: bgpTriples,
    variables,
    hidden,
  };
}

/**
 * Sign RDF data and return encoded triples with merkle proofs.
 *
 * The `format` parameter is currently accepted for forward compatibility but
 * not propagated to the sign script (which auto-detects via the file
 * extension we hand it).
 */
export async function signDataInMemory(dataContent: string, format: string = 'text/turtle'): Promise<SignedData> {
  void format;
  const tempInput = path.join('/tmp', `data-${Date.now()}.ttl`);
  const tempOutput = path.join('/tmp', `signed-${Date.now()}.json`);

  try {
    fs.writeFileSync(tempInput, dataContent);

    execSync(`npx tsx src/scripts/sign.ts -i "${tempInput}" -o "${tempOutput}"`, {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'pipe',
    });

    return JSON.parse(fs.readFileSync(tempOutput, 'utf-8')) as SignedData;
  } finally {
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
  }
}

/**
 * Transform a SPARQL query string and return its circuit metadata.
 */
export async function transformQueryInMemory(queryContent: string): Promise<CircuitMetadata> {
  const projectRoot = path.resolve(__dirname, '../..');
  const transformPath = path.join(projectRoot, 'transform', 'target', 'release', 'transform');
  const tempQuery = path.join('/tmp', `query-${Date.now()}.rq`);

  try {
    fs.writeFileSync(tempQuery, queryContent);

    if (!fs.existsSync(transformPath)) {
      execSync('cargo build --release', {
        cwd: path.join(projectRoot, 'transform'),
        stdio: 'pipe',
      });
    }

    const result = spawnSync(transformPath, ['-q', tempQuery], {
      encoding: 'utf-8',
      cwd: projectRoot,
    });

    if (result.status !== 0) {
      throw new Error(`Transform failed: ${result.stderr || result.stdout}`);
    }

    const metadataPath = path.join(projectRoot, 'noir_prove', 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
      throw new Error('Transform did not produce metadata.json');
    }

    return JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as CircuitMetadata;
  } finally {
    if (fs.existsSync(tempQuery)) fs.unlinkSync(tempQuery);
  }
}

/**
 * Types of negative tests that can be generated
 */
export type NegativeTestType = 
  | 'wrong_variable_value'      // Variable has incorrect encoded value
  | 'wrong_predicate'           // Predicate doesn't match pattern
  | 'wrong_object'              // Object doesn't match pattern  
  | 'mismatched_subject'        // Subjects don't match across patterns sharing a variable
  | 'invalid_merkle_path'       // Merkle proof path is invalid
  | 'wrong_root'                // Triple doesn't belong to the claimed root
  | 'swapped_triples';          // BGP triples in wrong order

/**
 * Information about a negative test case
 */
export interface NegativeTestCase {
  type: NegativeTestType;
  description: string;
  expectedError: string;
  inputs: {
    public_key: object[];
    roots: object[];
    bgp: BGPTriple[];
    variables: Record<string, string>;
  };
}

/**
 * Mutate a hex string by changing a single character
 */
function mutateHexString(hex: string): string {
  // Find the first non-zero hex digit after 0x and increment/change it
  const prefix = hex.startsWith('0x') ? '0x' : '';
  const digits = hex.slice(prefix.length);
  
  // Find a position to mutate (preferably not leading zeros)
  let pos = 0;
  for (let i = 0; i < digits.length; i++) {
    if (digits[i] !== '0') {
      pos = i;
      break;
    }
  }
  
  // Change the digit
  const oldChar = digits[pos];
  let newChar: string;
  if (oldChar === 'f') {
    newChar = 'e';
  } else if (oldChar >= '0' && oldChar <= '9') {
    newChar = String.fromCharCode(oldChar.charCodeAt(0) + 1);
  } else {
    newChar = String.fromCharCode(oldChar.charCodeAt(0) + 1);
  }
  
  return prefix + digits.slice(0, pos) + newChar + digits.slice(pos + 1);
}

/**
 * Generate negative test cases from a valid input
 */
export function generateNegativeTestCases(
  validInputs: CheckBindingInputs,
  signedData: SignedData,
  metadata: CircuitMetadata
): NegativeTestCase[] {
  const negativeTests: NegativeTestCase[] = [];
  
  const baseInputs = {
    public_key: [signedData.pubKey],
    roots: [{
      value: signedData.root,
      signature: signedData.signature,
    }],
  };
  
  // 1. Wrong variable value - mutate a projected variable
  const varNames = Object.keys(validInputs.variables);
  if (varNames.length > 0) {
    const varName = varNames[0];
    const mutatedVariables = { ...validInputs.variables };
    mutatedVariables[varName] = mutateHexString(validInputs.variables[varName]);
    
    negativeTests.push({
      type: 'wrong_variable_value',
      description: `Variable ?${varName} has incorrect encoded value`,
      expectedError: `Failed constraint: variables.${varName} == bgp[*].terms[*].hash`,
      inputs: {
        ...baseInputs,
        bgp: validInputs.bgp,
        variables: mutatedVariables,
      },
    });
  }

  // 2. Wrong predicate - change the predicate term of a triple
  if (validInputs.bgp.length > 0) {
    const mutatedBgp = validInputs.bgp.map((t, i) => {
      if (i === 0) {
        return {
          ...t,
          terms: [
            t.terms[0],
            { ...t.terms[1], hash: mutateHexString(t.terms[1].hash) },
            t.terms[2],
            t.terms[3],
          ],
        };
      }
      return t;
    });

    negativeTests.push({
      type: 'wrong_predicate',
      description: 'Predicate of first triple has incorrect encoded value',
      expectedError: 'Failed constraint: consts::hash2([0, ...]) == bgp[0].terms[1].hash',
      inputs: {
        ...baseInputs,
        bgp: mutatedBgp,
        variables: validInputs.variables,
      },
    });
  }

  // 3. Wrong object - change the object term of a triple
  if (validInputs.bgp.length > 0) {
    const mutatedBgp = validInputs.bgp.map((t, i) => {
      if (i === 0) {
        return {
          ...t,
          terms: [
            t.terms[0],
            t.terms[1],
            { ...t.terms[2], hash: mutateHexString(t.terms[2].hash) },
            t.terms[3],
          ],
        };
      }
      return t;
    });

    negativeTests.push({
      type: 'wrong_object',
      description: 'Object of first triple has incorrect encoded value',
      expectedError: 'Failed constraint: ... == bgp[0].terms[2].hash',
      inputs: {
        ...baseInputs,
        bgp: mutatedBgp,
        variables: validInputs.variables,
      },
    });
  }

  // 4. Mismatched subjects - if there are multiple BGP patterns with shared variables
  if (validInputs.bgp.length >= 2) {
    const mutatedBgp = validInputs.bgp.map((t, i) => {
      if (i === 1) {
        return {
          ...t,
          terms: [
            { ...t.terms[0], hash: mutateHexString(t.terms[0].hash) },
            t.terms[1],
            t.terms[2],
            t.terms[3],
          ],
        };
      }
      return t;
    });

    negativeTests.push({
      type: 'mismatched_subject',
      description: 'Subject of second triple differs from first (shared variable mismatch)',
      expectedError: 'Failed constraint: bgp[0].terms[0].hash == bgp[1].terms[0].hash',
      inputs: {
        ...baseInputs,
        bgp: mutatedBgp,
        variables: validInputs.variables,
      },
    });
  }
  
  // 5. Invalid merkle path - corrupt the merkle proof path
  if (validInputs.bgp.length > 0 && validInputs.bgp[0].path.length > 0) {
    const mutatedBgp = validInputs.bgp.map((t, i) => {
      if (i === 0) {
        const mutatedPath = [...t.path];
        mutatedPath[0] = mutateHexString(mutatedPath[0]);
        return {
          ...t,
          path: mutatedPath,
        };
      }
      return t;
    });
    
    negativeTests.push({
      type: 'invalid_merkle_path',
      description: 'Merkle proof path for first triple is corrupted',
      expectedError: 'Failed constraint in verify_inclusion: merkle root mismatch',
      inputs: {
        ...baseInputs,
        bgp: mutatedBgp,
        variables: validInputs.variables,
      },
    });
  }
  
  // 6. Wrong root - use a different root value
  if (signedData.root) {
    negativeTests.push({
      type: 'wrong_root',
      description: 'Merkle root does not match the signed root',
      expectedError: 'Failed constraint in verify_inclusion or verify_signature',
      inputs: {
        public_key: [signedData.pubKey],
        roots: [{
          value: mutateHexString(signedData.root),
          signature: signedData.signature,
        }],
        bgp: validInputs.bgp,
        variables: validInputs.variables,
      },
    });
  }
  
  // 7. Swapped triples - swap BGP triple order (if applicable)
  if (validInputs.bgp.length >= 2) {
    const swappedBgp = [validInputs.bgp[1], validInputs.bgp[0], ...validInputs.bgp.slice(2)];
    
    negativeTests.push({
      type: 'swapped_triples',
      description: 'BGP triples are in wrong order',
      expectedError: 'Failed constraint: pattern-specific term does not match expected position',
      inputs: {
        ...baseInputs,
        bgp: swappedBgp,
        variables: validInputs.variables,
      },
    });
  }
  
  return negativeTests;
}

