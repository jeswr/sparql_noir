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
import { stringQuadToQuad, termToString } from 'rdf-string-ttl';
import type { Term, Quad, Literal } from '@rdfjs/types';
import type { SignedData } from './sign.js';

// --- Exported Types ---

export interface ProveOptions {
  circuitDir: string;
  signedData: SignedData;
  metadataPath?: string | undefined;
  threads?: number;
  /** If true, only generate witness without creating the actual ZK proof (faster for testing) */
  witnessOnly?: boolean | undefined;
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
  const { circuitDir, signedData, metadataPath: metaPathOpt, threads = 6, witnessOnly = false } = options;

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
  console.log(`Loading circuit: ${circuitJsonPath}`);

  // Load circuit
  const circuit = JSON.parse(fs.readFileSync(circuitJsonPath, 'utf8')) as CompiledCircuit;
  
  // Load metadata
  const metadataPath = metaPathOpt || path.join(circuitDir, 'metadata.json');
  let metadata: CircuitMetadata | undefined;
  if (fs.existsSync(metadataPath)) {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as CircuitMetadata;
    console.log(`Loaded metadata: ${metadataPath}`);
  } else {
    console.warn(`Warning: No metadata file found at '${metadataPath}'. Using minimal defaults.`);
  }

  // Build RDF store from signed quads
  const quadArr = signedData.nquads.map(nq => stringQuadToQuad(nq));
  const stringArr = quadArr.map(q => termToString(q));
  const stringIndexMap = new Map(stringArr.map((s, i) => [s, i]));
  const store = new Store(quadArr);

  console.log(`Loaded ${quadArr.length} quads from signed data`);

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
    return {
      terms: signedData.triples[id],
      path: signedData.paths[id],
      directions: signedData.direction[id],
    };
  }

  // Get input patterns from metadata
  const inputPatterns = metadata?.input_patterns || metadata?.inputPatterns || [];
  
  if (inputPatterns.length === 0) {
    throw new Error('No input patterns found in metadata.');
  }

  console.log(`Query has ${inputPatterns.length} BGP pattern(s)`);

  // Simple binding resolution: find quads that match patterns
  const bindings: Map<string, Term>[] = [];
  
  // Convert patterns to RDF terms
  const patternQuads = inputPatterns.map(p => ({
    subject: termJsonToRdfTerm(p.subject),
    predicate: termJsonToRdfTerm(p.predicate),
    object: termJsonToRdfTerm(p.object),
    graph: termJsonToRdfTerm(p.graph),
  }));

  // Find matching quads for first pattern
  const firstPattern = patternQuads[0]!;
  const matchingQuads = store.getQuads(
    firstPattern.subject.termType === 'Variable' ? null : firstPattern.subject,
    firstPattern.predicate.termType === 'Variable' ? null : firstPattern.predicate,
    firstPattern.object.termType === 'Variable' ? null : firstPattern.object,
    firstPattern.graph.termType === 'Variable' || firstPattern.graph.termType === 'DefaultGraph' ? null : firstPattern.graph
  );

  console.log(`Found ${matchingQuads.length} matching quad(s) for first pattern`);

  // For each matching quad, build a binding
  for (const quad of matchingQuads) {
    const binding = new Map<string, Term>();
    
    // Extract bindings from first pattern
    if (firstPattern.subject.termType === 'Variable') {
      binding.set(firstPattern.subject.value, quad.subject);
    }
    if (firstPattern.predicate.termType === 'Variable') {
      binding.set(firstPattern.predicate.value, quad.predicate);
    }
    if (firstPattern.object.termType === 'Variable') {
      binding.set(firstPattern.object.value, quad.object);
    }
    if (firstPattern.graph.termType === 'Variable') {
      binding.set(firstPattern.graph.value, quad.graph);
    }
    
    bindings.push(binding);
  }

  if (bindings.length === 0) {
    throw new Error('No bindings found for the query.');
  }

  console.log(`Processing ${bindings.length} binding(s)`);

  // Initialize Noir and backend (backend only needed if generating proofs)
  const noir = new Noir(circuit);
  const backend = witnessOnly ? null : new UltraHonkBackend(circuit.bytecode, { threads });

  const proofs: ProofOutput[] = [];
  const witnesses: WitnessOutput[] = [];
  let successCount = 0;

  for (let bindingIdx = 0; bindingIdx < bindings.length; bindingIdx++) {
    const binding = bindings[bindingIdx]!;
    console.log(`\nProcessing binding ${bindingIdx + 1}/${bindings.length}`);
    
    // Find triple indices for each pattern
    const tripleIndices: number[] = [];
    
    // For the first pattern, find matching triple
    const firstPatternQuad = matchingQuads[bindingIdx];
    if (!firstPatternQuad) {
      console.warn(`  Skipping: no matching quad at index ${bindingIdx}`);
      continue;
    }
    const idx = findTripleIndex(firstPatternQuad);
    if (idx < 0) {
      console.warn(`  Skipping: could not find triple index for binding`);
      continue;
    }
    tripleIndices.push(idx);

    // Pad to expected pattern count
    while (tripleIndices.length < inputPatterns.length) {
      tripleIndices.push(tripleIndices[0]!);
    }

    // Build variables object for circuit
    const variables: Record<string, string> = {};
    const selectVars = metadata?.variables || [];
    for (const varName of selectVars) {
      const term = binding.get(varName);
      if (term) {
        const patternIdx = 0; // First pattern for now
        
        // Find which position in the pattern this variable is
        const positions: (keyof PatternJson)[] = ['subject', 'predicate', 'object', 'graph'];
        for (let pi = 0; pi < positions.length; pi++) {
          const pos = positions[pi]!;
          const pattern = inputPatterns[patternIdx];
          if (!pattern) continue;
          const patternTerm = pattern[pos] as TermJson | undefined;
          if (patternTerm && patternTerm.termType === 'Variable' && patternTerm.value === varName) {
            const tripleIdx = tripleIndices[patternIdx];
            const triple = tripleIdx !== undefined ? signedData.triples[tripleIdx] : undefined;
            if (triple) {
              variables[varName] = triple[pi]!;
            }
            break;
          }
        }
      }
    }

    // Build circuit input
    const circuitInput = {
      public_key: [signedData.pubKey],
      roots: [{
        value: signedData.root,
        signature: signedData.signature,
        keyIndex: 0,
      }],
      bgp: tripleIndices.map(i => getTripleObject(i)),
      variables,
    };

    const startTime = Date.now();

    try {
      // Generate witness
      console.log(`  Generating witness...`);
      // @ts-expect-error - circuit input types are complex and vary by circuit
      const { witness } = await noir.execute(circuitInput);

      if (witnessOnly) {
        // Witness-only mode: skip proof generation
        const endTime = Date.now();
        const timingMs = endTime - startTime;
        console.log(`  Witness generated in ${(timingMs / 1000).toFixed(2)}s (skipping proof)`);

        witnesses.push({
          witness: serializeProof(witness) as number[],
          circuit: path.basename(circuitDir),
          timestamp: new Date().toISOString(),
          timingMs,
        });
        successCount++;
      } else {
        // Full proof generation
        console.log(`  Generating proof...`);
        const proof = await backend!.generateProof(witness);

        const endTime = Date.now();
        const timingMs = endTime - startTime;

        console.log(`  Proof generated in ${(timingMs / 1000).toFixed(2)}s`);

        proofs.push({
          proof: serializeProof(proof.proof) as number[],
          publicInputs: proof.publicInputs,
          circuit: path.basename(circuitDir),
          timestamp: new Date().toISOString(),
          timingMs,
        });

        successCount++;
      }
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      if (msg.includes('Cannot satisfy constraint') || msg.includes('Cannot satisfy')) {
        console.warn(`  Skipping binding due to unsatisfiable constraints`);
        continue;
      }
      console.error(`  Error: ${msg}`);
    }
  }

  // Cleanup
  if (backend) {
    try {
      if (typeof (backend as unknown as { destroy: () => void }).destroy === 'function') {
        await (backend as unknown as { destroy: () => Promise<void> }).destroy();
      }
    } catch { /* ignore cleanup errors */ }
  }

  if (witnessOnly) {
    if (witnesses.length === 0) {
      throw new Error('No witnesses could be generated.');
    }
    console.log(`\nSuccessfully generated ${witnesses.length} witness(es)`);
  } else {
    if (proofs.length === 0) {
      throw new Error('No proofs could be generated.');
    }
    console.log(`\nSuccessfully generated ${proofs.length} proof(s)`);
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
