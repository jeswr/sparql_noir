/**
 * prove.ts - Generate ZK proofs for SPARQL query results
 * 
 * This script:
 * 1. Loads a compiled Noir circuit and signed RDF data
 * 2. Resolves SPARQL query variable bindings against the data
 * 3. Generates witness inputs for the circuit
 * 4. Creates a ZK proof using UltraHonkBackend
 * 5. Outputs the proof for later verification
 */
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';
import { Store, DataFactory as DF } from 'n3';
import { stringQuadToQuad as rdfStringToQuad, termToString } from 'rdf-string-ttl';
import type { Term, Quad, Literal } from '@rdfjs/types';
import type { SignedData } from './sign.js';

// --- Custom stringQuadToQuad that properly handles escape sequences ---

/**
 * Unescape a string value from N-Quads format.
 * Handles \n, \r, \t, \\, etc.
 */
function unescapeNQuadsString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"');
}

/**
 * Parse a string quad object from rdf-string-ttl format, with proper escape handling.
 */
function stringQuadToQuad(sq: { subject: string; predicate: string; object: string; graph: string }): Quad {
  // First parse with the standard function
  const quad = rdfStringToQuad(sq);
  
  // Then fix the object value if it's a literal (might have escape sequences)
  if (quad.object.termType === 'Literal') {
    const lit = quad.object as Literal;
    const unescapedValue = unescapeNQuadsString(lit.value);
    if (unescapedValue !== lit.value) {
      // Create a new quad with the unescaped literal
      const newLit = lit.language
        ? DF.literal(unescapedValue, lit.language)
        : DF.literal(unescapedValue, lit.datatype);
      return DF.quad(quad.subject, quad.predicate, newLit, quad.graph) as Quad;
    }
  }
  
  return quad;
}

// --- Exported Types ---

export interface ProveOptions {
  circuitDir: string;
  signedData: SignedData | null;
  metadataPath?: string | undefined;
  threads?: number;
  /** If true, only generate witness without creating the actual ZK proof (faster for testing) */
  witnessOnly?: boolean | undefined;
  /** If true, skip signature verification (use simplified circuit) */
  skipSigning?: boolean | undefined;
  /** Maximum number of bindings to process (undefined = all bindings) */
  maxBindings?: number | undefined;
  /** If true, suppress console output (errors collected in result) */
  quiet?: boolean | undefined;
}

export interface ProofOutput {
  proof: number[];
  publicInputs: unknown;
  circuit: string;
  timestamp: string;
  timingMs: number;
}

export interface WitnessOutput {
  witness: number[];
  circuit: string;
  timestamp: string;
  timingMs: number;
}

export interface ProveResult {
  proofs: ProofOutput[];
  witnesses?: WitnessOutput[] | undefined;
  metadata: {
    totalBindings: number;
    successfulProofs: number;
    circuit: string;
    witnessOnly?: boolean | undefined;
  };
  /** Errors collected during proof/witness generation (when quiet mode is enabled) */
  errors?: string[] | undefined;
}

// --- Internal Type Definitions ---

interface TermJson {
  termType: string;
  value?: string;
  language?: string;
  datatype?: { value: string };
}

interface PatternJson {
  subject: TermJson;
  predicate: TermJson;
  object: TermJson;
  graph: TermJson;
}

interface CircuitMetadata {
  input_patterns: PatternJson[];
  inputPatterns?: PatternJson[];
  optional_patterns?: PatternJson[];
  optionalPatterns?: PatternJson[];
  union_branches?: PatternJson[][];
  unionBranches?: PatternJson[][];
  hiddenInputs?: HiddenInput[];
  hidden_inputs?: HiddenInput[];
  variables: string[];
}

interface HiddenInput {
  type: 'input' | 'static' | 'customComputed' | 'variable';
  value?: [number, number] | TermJson;
  input?: { type: string; value: unknown };
  computedType?: string;
}

// Helper function to parse datetime values in various formats
function parseDatetimeValue(value: string): number | null {
  // Try standard Date.parse first
  let ms = Date.parse(value);
  if (!Number.isNaN(ms)) {
    return ms;
  }
  
  // Handle xsd:date format: YYYY-MM-DD with optional timezone
  // Examples: "2006-08-23", "2006-08-23+00:00", "2006-08-23Z"
  const dateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/);
  if (dateMatch) {
    const [, year, month, day, tz] = dateMatch;
    // Parse as ISO date string
    let isoString = `${year}-${month}-${day}`;
    if (tz) {
      isoString += tz === 'Z' ? 'T00:00:00Z' : `T00:00:00${tz}`;
    }
    ms = Date.parse(isoString);
    if (!Number.isNaN(ms)) {
      return ms;
    }
    // Fallback: parse as UTC
    ms = Date.UTC(parseInt(year!, 10), parseInt(month!, 10) - 1, parseInt(day!, 10));
    if (!Number.isNaN(ms)) {
      return ms;
    }
  }
  
  return null;
}

// Helper function to parse numeric values (integer, decimal, double)
function parseNumericValue(value: string): number | null {
  // Remove leading/trailing whitespace
  const trimmed = value.trim();
  
  // Try parsing as number
  const num = Number(trimmed);
  if (!Number.isNaN(num) && Number.isFinite(num)) {
    // For circuit comparisons, convert to integer (e.g., by truncating or rounding)
    // Most comparisons will be on integers, but we can handle decimals
    if (Number.isInteger(num)) {
      return num;
    }
    // For non-integers, multiply by a scale factor or just use the integer part
    // For now, just return the integer part
    return Math.floor(num);
  }
  
  return null;
}

// Helper function to get RDF term type code for circuit type checking
// NamedNode → 0, BlankNode → 1, Literal → 2, Variable → 3, DefaultGraph → 4
function getTermTypeCode(term: Term): number {
  switch (term.termType) {
    case 'NamedNode':
      return 0;
    case 'BlankNode':
      return 1;
    case 'Literal':
      return 2;
    case 'Variable':
      return 3;
    case 'DefaultGraph':
      return 4;
    default:
      return -1;
  }
}

// Helper function to get term type code from JSON representation
function getTermTypeCodeFromJson(termJson: TermJson): number {
  switch (termJson.termType) {
    case 'NamedNode':
      return 0;
    case 'BlankNode':
      return 1;
    case 'Literal':
      return 2;
    case 'Variable':
      return 3;
    case 'DefaultGraph':
      return 4;
    default:
      return -1;
  }
}

// Helper function to compute hidden input values based on metadata
function computeHiddenInputs(
  hiddenInputs: HiddenInput[],
  binding: Map<string, Term>
): string[] | null {
  if (!hiddenInputs || hiddenInputs.length === 0) {
    return [];
  }

  const hiddenValues: string[] = [];

  for (const hidden of hiddenInputs) {
    if (hidden.type === 'customComputed' && hidden.computedType === 'datetime_value') {
      // Handle datetime comparison hidden inputs
      const input = hidden.input as { type: string; value: unknown } | undefined;
      if (!input) {
        console.warn('Hidden input missing input field');
        return null;
      }

      if (input.type === 'variable') {
        // Get the bound value for this variable
        const varName = input.value as string;
        const boundTerm = binding.get(varName);
        if (!boundTerm) {
          console.warn(`Variable ${varName} not found in binding for hidden input`);
          return null;
        }
        if (boundTerm.termType !== 'Literal') {
          console.warn(`Variable ${varName} is not a literal for datetime comparison`);
          return null;
        }
        // Parse datetime and convert to epoch milliseconds
        const ms = parseDatetimeValue(boundTerm.value);
        if (ms === null) {
          console.warn(`Could not parse datetime: ${boundTerm.value}`);
          return null;
        }
        hiddenValues.push(ms.toString());
      } else if (input.type === 'static') {
        // Static value from metadata
        const termJson = input.value as TermJson;
        if (!termJson || termJson.termType !== 'Literal') {
          console.warn('Static hidden input is not a literal');
          return null;
        }
        const ms = parseDatetimeValue(termJson.value || '');
        if (ms === null) {
          console.warn(`Could not parse static datetime: ${termJson.value}`);
          return null;
        }
        hiddenValues.push(ms.toString());
      } else {
        console.warn(`Unknown hidden input type: ${input.type}`);
        return null;
      }
    } else if (hidden.type === 'customComputed' && hidden.computedType === 'literal_value') {
      // Handle numeric literal comparison hidden inputs
      const input = hidden.input as { type: string; value: unknown } | undefined;
      if (!input) {
        console.warn('Hidden input missing input field for literal_value');
        return null;
      }

      if (input.type === 'variable') {
        // Get the bound value for this variable
        const varName = input.value as string;
        const boundTerm = binding.get(varName);
        if (!boundTerm) {
          console.warn(`Variable ${varName} not found in binding for hidden literal_value input`);
          return null;
        }
        if (boundTerm.termType !== 'Literal') {
          console.warn(`Variable ${varName} is not a literal for numeric comparison`);
          return null;
        }
        // Parse numeric value
        const numValue = parseNumericValue(boundTerm.value);
        if (numValue === null) {
          console.warn(`Could not parse numeric value: ${boundTerm.value}`);
          return null;
        }
        hiddenValues.push(numValue.toString());
      } else if (input.type === 'static') {
        // Static value from metadata
        const termJson = input.value as TermJson;
        if (!termJson || termJson.termType !== 'Literal') {
          console.warn('Static hidden input is not a literal for literal_value');
          return null;
        }
        const numValue = parseNumericValue(termJson.value || '');
        if (numValue === null) {
          console.warn(`Could not parse static numeric value: ${termJson.value}`);
          return null;
        }
        hiddenValues.push(numValue.toString());
      } else {
        console.warn(`Unknown hidden input type for literal_value: ${input.type}`);
        return null;
      }
    } else if (hidden.type === 'customComputed' && hidden.computedType === 'term_to_field') {
      // Handle term type checking hidden inputs (isIRI, isBlank, isLiteral)
      const input = hidden.input as { type: string; value: unknown } | undefined;
      if (!input) {
        console.warn('Hidden input missing input field for term_to_field');
        return null;
      }

      if (input.type === 'variable') {
        // Get the bound value for this variable
        const varName = input.value as string;
        const boundTerm = binding.get(varName);
        if (!boundTerm) {
          console.warn(`Variable ${varName} not found in binding for hidden term_to_field input`);
          return null;
        }
        // Return the term type code
        const typeCode = getTermTypeCode(boundTerm);
        hiddenValues.push(typeCode.toString());
      } else if (input.type === 'static') {
        // Static value from metadata
        const termJson = input.value as TermJson;
        if (!termJson || !termJson.termType) {
          console.warn('Static hidden input is missing termType for term_to_field');
          return null;
        }
        const typeCode = getTermTypeCodeFromJson(termJson);
        hiddenValues.push(typeCode.toString());
      } else if (input.type === 'input') {
        // Reference to a BGP input - need to get from binding context
        console.warn('Input type for term_to_field not yet supported');
        return null;
      } else {
        console.warn(`Unknown hidden input type for term_to_field: ${input.type}`);
        return null;
      }
    } else if (hidden.type === 'customComputed' && hidden.computedType === 'lang') {
      // Handle LANG() function - extract language tag from literal
      const input = hidden.input as { type: string; value: unknown } | undefined;
      if (!input) {
        console.warn('Hidden input missing input field for lang');
        return null;
      }

      if (input.type === 'variable') {
        const varName = input.value as string;
        const boundTerm = binding.get(varName);
        if (!boundTerm) {
          console.warn(`Variable ${varName} not found in binding for hidden lang input`);
          return null;
        }
        // Get the language tag (empty string if none)
        const langTag = boundTerm.termType === 'Literal' ? ((boundTerm as Literal).language || '') : '';
        hiddenValues.push(langTag);
      } else if (input.type === 'static') {
        const termJson = input.value as TermJson;
        const langTag = termJson?.language || '';
        hiddenValues.push(langTag);
      } else {
        console.warn(`Unknown hidden input type for lang: ${input.type}`);
        return null;
      }
    } else if (hidden.type === 'customComputed' && hidden.computedType === 'str') {
      // Handle STR() function - extract lexical form
      const input = hidden.input as { type: string; value: unknown } | undefined;
      if (!input) {
        console.warn('Hidden input missing input field for str');
        return null;
      }

      if (input.type === 'variable') {
        const varName = input.value as string;
        const boundTerm = binding.get(varName);
        if (!boundTerm) {
          console.warn(`Variable ${varName} not found in binding for hidden str input`);
          return null;
        }
        // STR returns the lexical form for literals, the IRI for named nodes
        const strValue = boundTerm.value;
        hiddenValues.push(strValue);
      } else if (input.type === 'static') {
        const termJson = input.value as TermJson;
        hiddenValues.push(termJson?.value || '');
      } else {
        console.warn(`Unknown hidden input type for str: ${input.type}`);
        return null;
      }
    } else if (hidden.type === 'customComputed' && hidden.computedType === 'datatype') {
      // Handle DATATYPE() function - extract datatype IRI from literal
      const input = hidden.input as { type: string; value: unknown } | undefined;
      if (!input) {
        console.warn('Hidden input missing input field for datatype');
        return null;
      }

      if (input.type === 'variable') {
        const varName = input.value as string;
        const boundTerm = binding.get(varName);
        if (!boundTerm) {
          console.warn(`Variable ${varName} not found in binding for hidden datatype input`);
          return null;
        }
        if (boundTerm.termType !== 'Literal') {
          console.warn(`Variable ${varName} is not a literal for DATATYPE`);
          return null;
        }
        // Get the datatype IRI
        const lit = boundTerm as Literal;
        const datatypeIri = lit.datatype?.value || 'http://www.w3.org/2001/XMLSchema#string';
        hiddenValues.push(datatypeIri);
      } else if (input.type === 'static') {
        const termJson = input.value as TermJson;
        const datatypeIri = termJson?.datatype?.value || 'http://www.w3.org/2001/XMLSchema#string';
        hiddenValues.push(datatypeIri);
      } else {
        console.warn(`Unknown hidden input type for datatype: ${input.type}`);
        return null;
      }
    } else if (hidden.type === 'variable') {
      // Direct variable reference
      const varName = (hidden.value as unknown) as string;
      const boundTerm = binding.get(varName);
      if (!boundTerm) {
        console.warn(`Variable ${varName} not found in binding for hidden input`);
        return null;
      }
      // For now, treat as string and encode
      hiddenValues.push(boundTerm.value);
    } else if (hidden.type === 'static') {
      // Static value
      const termJson = hidden.value as TermJson;
      if (termJson && typeof termJson === 'object' && termJson.value) {
        hiddenValues.push(termJson.value);
      } else {
        console.warn('Invalid static hidden input');
        return null;
      }
    } else {
      console.warn(`Unhandled hidden input type: ${hidden.type}`);
      return null;
    }
  }

  return hiddenValues;
}

// --- Utility Functions ---

function termJsonToRdfTerm(tj: TermJson): Term {
  switch (tj.termType) {
    case 'NamedNode':
      return DF.namedNode(tj.value!);
    case 'BlankNode':
      return DF.blankNode(tj.value);
    case 'Literal':
      if (tj.language) return DF.literal(tj.value!, tj.language);
      return DF.literal(tj.value!, tj.datatype ? DF.namedNode(tj.datatype.value) : undefined);
    case 'Variable':
      return DF.variable(tj.value!);
    case 'DefaultGraph':
      return DF.defaultGraph();
    default:
      throw new Error(`Unknown term type: ${tj.termType}`);
  }
}

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

function equalQuadIgnoreBlankLabel(q1: Quad, q2: Quad): boolean {
  return equalTermIgnoreBlankLabel(q1.subject, q2.subject) &&
    equalTermIgnoreBlankLabel(q1.predicate, q2.predicate) &&
    equalTermIgnoreBlankLabel(q1.object, q2.object) &&
    equalTermIgnoreBlankLabel(q1.graph, q2.graph);
}

export function serializeProof(obj: unknown): unknown {
  if (obj instanceof Uint8Array) return Array.from(obj);
  if (Buffer.isBuffer(obj)) return Array.from(obj);
  if (obj && typeof obj === 'object') {
    const clone: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      const v = (obj as Record<string, unknown>)[k];
      if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
        clone[k] = Array.from(v);
      } else {
        clone[k] = v;
      }
    }
    return clone;
  }
  return obj;
}

// --- Exported Prove Function ---

/**
 * Generate ZK proofs for SPARQL query results
 */
export async function generateProofs(options: ProveOptions): Promise<ProveResult> {
  const { circuitDir, signedData, metadataPath: metaPathOpt, threads = 6, witnessOnly = false, skipSigning = false, quiet = false } = options;

  // Collected errors (used in quiet mode)
  const collectedErrors: string[] = [];

  // Helper functions for logging (respects quiet mode)
  const log = (msg: string) => { if (!quiet) console.log(msg); };
  const warn = (msg: string) => { 
    if (quiet) {
      collectedErrors.push(msg);
    } else {
      console.warn(msg);
    }
  };

  // Find compiled circuit JSON
  const targetDir = path.join(circuitDir, 'target');
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Circuit target directory '${targetDir}' does not exist. Run 'nargo compile' first.`);
  }
  
  const circuitFiles = fs.readdirSync(targetDir).filter(f => f.endsWith('.json'));
  if (circuitFiles.length === 0) {
    throw new Error(`No compiled circuit JSON found in '${targetDir}'.`);
  }
  
  const circuitJsonPath = path.join(targetDir, circuitFiles[0]!);
  log(`Loading circuit: ${circuitJsonPath}`);

  // Load circuit
  const circuit = JSON.parse(fs.readFileSync(circuitJsonPath, 'utf8')) as CompiledCircuit;
  
  // Load metadata
  const metadataPath = metaPathOpt || path.join(circuitDir, 'metadata.json');
  let metadata: CircuitMetadata | undefined;
  if (fs.existsSync(metadataPath)) {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as CircuitMetadata;
    log(`Loaded metadata: ${metadataPath}`);
  } else {
    warn(`Warning: No metadata file found at '${metadataPath}'. Using minimal defaults.`);
  }

  // For skip-signing mode, we need minimal data structure
  if (skipSigning && !signedData) {
    throw new Error('signedData is required even in skipSigning mode for triples/nquads');
  }

  // Build RDF store from signed quads
  const quadArr = signedData!.nquads.map(nq => stringQuadToQuad(nq));
  const stringArr = quadArr.map(q => termToString(q));
  const stringIndexMap = new Map(stringArr.map((s, i) => [s, i]));
  const store = new Store(quadArr);

  log(`Loaded ${quadArr.length} quads from signed data`);

  // Function to find triple index
  function findTripleIndex(q: Quad): number {
    const s = termToString(q);
    const idx = stringIndexMap.get(s);
    if (idx !== undefined) return idx;
    // Fallback: structural match ignoring blank node labels
    for (let i = 0; i < quadArr.length; i++) {
      const quad = quadArr[i];
      if (quad && equalQuadIgnoreBlankLabel(quad, q)) return i;
    }
    return -1;
  }

  // Build triple object for circuit input
  function getTripleObject(id: number) {
    if (skipSigning) {
      // Simplified: only terms, no Merkle proof data
      return {
        terms: signedData!.triples[id],
      };
    }
    return {
      terms: signedData!.triples[id],
      path: signedData!.paths[id],
      directions: signedData!.direction[id],
    };
  }

  // Get input patterns from metadata
  const inputPatterns = metadata?.input_patterns || metadata?.inputPatterns || [];
  
  if (inputPatterns.length === 0) {
    throw new Error('No input patterns found in metadata.');
  }

  log(`Query has ${inputPatterns.length} BGP pattern(s)`);
  log(`Metadata patterns raw: input_patterns=${metadata?.input_patterns?.length || 0}, inputPatterns=${metadata?.inputPatterns?.length || 0}`);

  // Simple binding resolution: find quads that match patterns
  const bindings: Map<string, Term>[] = [];
  
  // Convert patterns to RDF terms
  const patternQuads = inputPatterns.map(p => ({
    subject: termJsonToRdfTerm(p.subject),
    predicate: termJsonToRdfTerm(p.predicate),
    object: termJsonToRdfTerm(p.object),
    graph: termJsonToRdfTerm(p.graph),
  }));

  // Helper: Check if a term acts as a variable in SPARQL pattern matching
  // Per SPARQL 1.1 spec section 4.1.4: "Blank nodes in graph patterns act as variables"
  function isPatternVariable(term: Term): boolean {
    return term.termType === 'Variable' || term.termType === 'BlankNode';
  }

  // Helper: Get the binding key for a pattern term (variable name or blank node label)
  function getPatternKey(term: Term): string {
    if (term.termType === 'Variable') return term.value;
    if (term.termType === 'BlankNode') return `__blank_${term.value}`;
    throw new Error(`Cannot get pattern key for term type: ${term.termType}`);
  }

  // Find matching quads for first pattern
  const firstPattern = patternQuads[0]!;
  const matchingQuads = store.getQuads(
    isPatternVariable(firstPattern.subject) ? null : firstPattern.subject,
    isPatternVariable(firstPattern.predicate) ? null : firstPattern.predicate,
    isPatternVariable(firstPattern.object) ? null : firstPattern.object,
    isPatternVariable(firstPattern.graph) || firstPattern.graph.termType === 'DefaultGraph' ? null : firstPattern.graph
  );

  log(`Found ${matchingQuads.length} matching quad(s) for first pattern`);
  log(`First pattern: s=${firstPattern.subject.termType}, p=${firstPattern.predicate.termType}, o=${firstPattern.object.termType}`);
  if (firstPattern.object.termType === 'Literal') {
    log(`  Object value: ${JSON.stringify((firstPattern.object as Literal).value)}`);
    log(`  Object datatype: ${(firstPattern.object as Literal).datatype?.value}`);
  }
  if (patternQuads.length > 1) {
    const secondPattern = patternQuads[1];
    log(`Second pattern: s=${secondPattern?.subject.termType}, p=${secondPattern?.predicate.termType}, o=${secondPattern?.object.termType}`);
  }

  // Helper function to extract binding from a quad given a pattern
  // Handles both Variables and BlankNodes (which act as variables per SPARQL 1.1)
  function extractBinding(quad: Quad, pattern: typeof firstPattern): Map<string, Term> {
    const binding = new Map<string, Term>();
    if (isPatternVariable(pattern.subject)) {
      binding.set(getPatternKey(pattern.subject), quad.subject);
    }
    if (isPatternVariable(pattern.predicate)) {
      binding.set(getPatternKey(pattern.predicate), quad.predicate);
    }
    if (isPatternVariable(pattern.object)) {
      binding.set(getPatternKey(pattern.object), quad.object);
    }
    if (isPatternVariable(pattern.graph)) {
      binding.set(getPatternKey(pattern.graph), quad.graph);
    }
    return binding;
  }

  // Helper function to check if two bindings are compatible (no conflicting values for same variable)
  function bindingsCompatible(b1: Map<string, Term>, b2: Map<string, Term>): boolean {
    for (const [varName, term1] of b1) {
      const term2 = b2.get(varName);
      if (term2 && !equalTermIgnoreBlankLabel(term1, term2)) {
        return false;
      }
    }
    return true;
  }

  // Helper function to merge two bindings
  function mergeBindings(b1: Map<string, Term>, b2: Map<string, Term>): Map<string, Term> {
    const merged = new Map(b1);
    for (const [varName, term] of b2) {
      if (!merged.has(varName)) {
        merged.set(varName, term);
      }
    }
    return merged;
  }

  // Track bindings along with their corresponding quads for each pattern
  interface BindingWithQuads {
    binding: Map<string, Term>;
    quads: Quad[];
  }

  let bindingsWithQuads: BindingWithQuads[];

  // For single-pattern queries, just use the matching quads directly
  if (patternQuads.length === 1) {
    bindingsWithQuads = matchingQuads.map(quad => ({
      binding: extractBinding(quad, firstPattern),
      quads: [quad]
    }));
  } else {
    // Multi-pattern queries: compute full join of all patterns
    // Start with bindings from first pattern
    let currentBindings: BindingWithQuads[] = 
      matchingQuads.map(q => ({ binding: extractBinding(q, firstPattern), quads: [q] }));

    // Join with each subsequent pattern
    for (let patternIdx = 1; patternIdx < patternQuads.length; patternIdx++) {
      const pattern = patternQuads[patternIdx]!;
      const newBindings: BindingWithQuads[] = [];

      for (const { binding, quads } of currentBindings) {
        // Find matching quads for this pattern, substituting bound variables/blank nodes
        const subjectMatch = isPatternVariable(pattern.subject)
          ? binding.get(getPatternKey(pattern.subject)) || null 
          : pattern.subject;
        const predicateMatch = isPatternVariable(pattern.predicate)
          ? binding.get(getPatternKey(pattern.predicate)) || null
          : pattern.predicate;
        const objectMatch = isPatternVariable(pattern.object)
          ? binding.get(getPatternKey(pattern.object)) || null
          : pattern.object;
        const graphMatch = isPatternVariable(pattern.graph)
          ? binding.get(getPatternKey(pattern.graph)) || null
          : (pattern.graph.termType === 'DefaultGraph' ? null : pattern.graph);

        const matchingForPattern = store.getQuads(subjectMatch, predicateMatch, objectMatch, graphMatch);

        // For each matching quad, create a new combined binding
        for (const matchedQuad of matchingForPattern) {
          const newBinding = extractBinding(matchedQuad, pattern);
          if (bindingsCompatible(binding, newBinding)) {
            const merged = mergeBindings(binding, newBinding);
            newBindings.push({ binding: merged, quads: [...quads, matchedQuad] });
          }
        }
      }

      currentBindings = newBindings;
    }

    bindingsWithQuads = currentBindings;
    log(`After join: ${bindingsWithQuads.length} bindings from ${matchingQuads.length} first pattern matches`);
  }

  // Extract just the bindings for the main loop
  for (const { binding } of bindingsWithQuads) {
    bindings.push(binding);
  }

  if (bindings.length === 0) {
    throw new Error('No bindings found for the query.');
  }

  log(`Processing ${bindings.length} binding(s)`);

  // Initialize Noir and backend (backend only needed if generating proofs)
  const noir = new Noir(circuit);
  const backend = witnessOnly ? null : new UltraHonkBackend(circuit.bytecode, { threads });

  const proofs: ProofOutput[] = [];
  const witnesses: WitnessOutput[] = [];

  // Prepare all binding inputs first
  interface BindingInput {
    bindingIdx: number;
    circuitInput: Record<string, unknown>;
  }

  const bindingInputs: BindingInput[] = [];

  for (let bindingIdx = 0; bindingIdx < bindings.length; bindingIdx++) {
    const binding = bindings[bindingIdx]!;
    const { quads } = bindingsWithQuads[bindingIdx]!;
    
    // Find triple indices for each pattern using the pre-computed quads
    const tripleIndices: number[] = [];
    
    for (let patternIdx = 0; patternIdx < inputPatterns.length; patternIdx++) {
      const quad = quads[patternIdx];
      if (!quad) {
        // Should not happen if binding resolution is correct
        continue;
      }
      const idx = findTripleIndex(quad);
      if (idx < 0) {
        // Skip this binding if we can't find the triple
        break;
      }
      tripleIndices.push(idx);
    }
    
    // Skip if we couldn't find all pattern triples
    if (tripleIndices.length !== inputPatterns.length) {
      continue;
    }

    // Build variables object for circuit - search all patterns for variable values
    const variables: Record<string, string> = {};
    const selectVars = metadata?.variables || [];
    for (const varName of selectVars) {
      // Search all patterns for this variable
      for (let patternIdx = 0; patternIdx < inputPatterns.length; patternIdx++) {
        const positions: (keyof PatternJson)[] = ['subject', 'predicate', 'object', 'graph'];
        let found = false;
        for (let pi = 0; pi < positions.length; pi++) {
          const pos = positions[pi]!;
          const pattern = inputPatterns[patternIdx];
          if (!pattern) continue;
          const patternTerm = pattern[pos] as TermJson | undefined;
          if (patternTerm && patternTerm.termType === 'Variable' && patternTerm.value === varName) {
            const tripleIdx = tripleIndices[patternIdx];
            const triple = tripleIdx !== undefined ? signedData!.triples[tripleIdx] : undefined;
            if (triple) {
              variables[varName] = triple[pi]!;
              found = true;
              break;
            }
          }
        }
        if (found) break;
      }
    }

    // Compute hidden inputs if needed
    const hiddenInputs = metadata?.hiddenInputs || metadata?.hidden_inputs || [];
    const hiddenValues = computeHiddenInputs(hiddenInputs, binding);
    if (hiddenValues === null) {
      // Skip this binding if hidden input computation failed
      continue;
    }

    // Build circuit input
    const baseInput = skipSigning ? {
      // Simplified circuit: only BGP and variables
      bgp: tripleIndices.map(i => getTripleObject(i)),
      variables,
    } : {
      // Full circuit: includes signature verification
      public_key: [signedData!.pubKey],
      roots: [{
        value: signedData!.root,
        signature: signedData!.signature,
        keyIndex: 0,
      }],
      bgp: tripleIndices.map(i => getTripleObject(i)),
      variables,
    };

    // Add hidden inputs if present
    const circuitInput = hiddenValues.length > 0 
      ? { ...baseInput, hidden: hiddenValues }
      : baseInput;

    bindingInputs.push({ bindingIdx, circuitInput });
  }

  if (bindingInputs.length === 0) {
    throw new Error('No valid binding inputs could be prepared.');
  }

  // Apply maxBindings limit if specified
  const maxBindings = options.maxBindings;
  let bindingsToProcess = bindingInputs;
  if (maxBindings !== undefined && maxBindings > 0 && bindingInputs.length > maxBindings) {
    bindingsToProcess = bindingInputs.slice(0, maxBindings);
    log(`Limiting to ${maxBindings} binding(s) (${bindingInputs.length} available)`);
  }

  log(`\nGenerating witnesses for ${bindingsToProcess.length} binding(s) in parallel...`);

  // Generate all witnesses in parallel
  const witnessStartTime = Date.now();
  const witnessResults = await Promise.allSettled(
    bindingsToProcess.map(async ({ bindingIdx, circuitInput }) => {
      const startTime = Date.now();
      // @ts-expect-error - circuit input types are complex and vary by circuit
      const { witness } = await noir.execute(circuitInput);
      const timingMs = Date.now() - startTime;
      return { bindingIdx, witness, timingMs };
    })
  );
  const witnessEndTime = Date.now();
  log(`  All witnesses generated in ${((witnessEndTime - witnessStartTime) / 1000).toFixed(2)}s`);

  // Process witness results
  const successfulWitnesses: { bindingIdx: number; witness: Uint8Array; timingMs: number }[] = [];
  for (const result of witnessResults) {
    if (result.status === 'fulfilled') {
      successfulWitnesses.push(result.value);
      if (witnessOnly) {
        witnesses.push({
          witness: serializeProof(result.value.witness) as number[],
          circuit: path.basename(circuitDir),
          timestamp: new Date().toISOString(),
          timingMs: result.value.timingMs,
        });
      }
    } else {
      const msg = String(result.reason?.message || result.reason);
      if (!msg.includes('Cannot satisfy constraint') && !msg.includes('Cannot satisfy')) {
        warn(`  Warning: witness generation failed: ${msg}`);
      }
    }
  }

  log(`  Successfully generated ${successfulWitnesses.length}/${bindingsToProcess.length} witnesses`);

  if (successfulWitnesses.length === 0) {
    throw new Error('No witnesses could be generated.');
  }

  // If not witness-only mode, generate proofs in parallel
  if (!witnessOnly && backend) {
    log(`\nGenerating proofs for ${successfulWitnesses.length} witness(es) in parallel...`);
    
    const proofStartTime = Date.now();
    const proofResults = await Promise.allSettled(
      successfulWitnesses.map(async ({ bindingIdx, witness }) => {
        const startTime = Date.now();
        const proof = await backend.generateProof(witness);
        const timingMs = Date.now() - startTime;
        return { bindingIdx, proof, timingMs };
      })
    );
    const proofEndTime = Date.now();
    log(`  All proofs generated in ${((proofEndTime - proofStartTime) / 1000).toFixed(2)}s`);

    // Process proof results
    for (const result of proofResults) {
      if (result.status === 'fulfilled') {
        proofs.push({
          proof: serializeProof(result.value.proof.proof) as number[],
          publicInputs: result.value.proof.publicInputs,
          circuit: path.basename(circuitDir),
          timestamp: new Date().toISOString(),
          timingMs: result.value.timingMs,
        });
      } else {
        warn(`  Warning: proof generation failed: ${result.reason?.message || result.reason}`);
      }
    }

    log(`  Successfully generated ${proofs.length}/${successfulWitnesses.length} proofs`);
  }

  // Cleanup - properly destroy the backend to release worker threads
  if (backend) {
    await backend.destroy();
  }

  const successCount = witnessOnly ? witnesses.length : proofs.length;

  if (witnessOnly) {
    if (witnesses.length === 0) {
      throw new Error('No witnesses could be generated.');
    }
    log(`\nSuccessfully generated ${witnesses.length} witness(es)`);
  } else {
    if (proofs.length === 0) {
      throw new Error('No proofs could be generated.');
    }
    log(`\nSuccessfully generated ${proofs.length} proof(s)`);
  }

  return {
    proofs,
    witnesses: witnessOnly ? witnesses : undefined,
    metadata: {
      totalBindings: bindings.length,
      successfulProofs: successCount,
      circuit: path.basename(circuitDir),
      witnessOnly: witnessOnly || undefined,
    },
    errors: collectedErrors.length > 0 ? collectedErrors : undefined,
  };
}

// --- CLI Entry Point ---

// Only run CLI if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const program = new Command();

  program
    .name('prove')
    .description('Generate a ZK proof for SPARQL query results')
    .requiredOption('-c, --circuit <path>', 'Path to compiled circuit directory (contains target/*.json)')
    .requiredOption('-s, --signed <path>', 'Path to signed RDF data JSON (output from sign.ts)')
    .option('-o, --output <path>', 'Output path for proof JSON', 'proof.json')
    .option('-m, --metadata <path>', 'Path to circuit metadata JSON (defaults to circuit/metadata.json)')
    .option('--threads <n>', 'Number of threads for proof generation', '6')
    .option('-w, --witness-only', 'Only generate witness, skip proof generation (faster for testing)')
    .addHelpText('after', `
Examples:
  $ npm run prove -- -c output -s signed.json -o proof.json
  $ npm run prove -- -c output -s signed.json -w  # witness only (faster)

The script will:
  1. Load the compiled Noir circuit
  2. Load signed RDF data and metadata
  3. Resolve variable bindings from SPARQL patterns
  4. Generate ZK proof with UltraHonk backend (or just witness if -w)
  5. Save proof/witness to output file
`)
    .parse();

  const opts = program.opts<{
    circuit: string;
    signed: string;
    output: string;
    metadata?: string;
    threads: string;
    witnessOnly?: boolean;
  }>();

  async function main() {
    const circuitDir = path.resolve(process.cwd(), opts.circuit);
    const signedPath = path.resolve(process.cwd(), opts.signed);
    const outputPath = path.resolve(process.cwd(), opts.output);

    // Validate paths
    if (!fs.existsSync(circuitDir)) {
      console.error(`Error: Circuit directory '${circuitDir}' does not exist.`);
      process.exit(1);
    }
    if (!fs.existsSync(signedPath)) {
      console.error(`Error: Signed data file '${signedPath}' does not exist.`);
      process.exit(1);
    }

    // Load signed data
    const signedData = JSON.parse(fs.readFileSync(signedPath, 'utf8')) as SignedData;

    try {
      const result = await generateProofs({
        circuitDir,
        signedData,
        metadataPath: opts.metadata ? path.resolve(process.cwd(), opts.metadata) : undefined,
        threads: parseInt(opts.threads),
        witnessOnly: opts.witnessOnly,
      });

      // Write output
      const output = {
        ...result,
        metadata: {
          ...result.metadata,
          signedData: path.basename(signedPath),
        },
      };

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

      console.log(`Output saved to: ${outputPath}`);
      // Explicitly exit to ensure worker threads from bb.js are terminated
      process.exit(0);
    } catch (err) {
      console.error('Error:', (err as Error).message);
      process.exit(1);
    }
  }

  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
