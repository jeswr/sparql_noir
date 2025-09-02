import { UltraHonkBackend, Barretenberg, RawBuffer } from "@aztec/bb.js";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { Algebra } from "sparqlalgebrajs";
import { generateTestWitness, type RealTriple } from "./witness_generator.js";
// proof bundle interface
interface SavedProof {
  vk: string[]; // fields as decimal strings
  proof: string; // hex string
  publicInputs: string[];
}

// Helper: persist proof bundle next to circuit
function saveProofBundle(circuitDir: string, bundle: SavedProof) {
  const out = resolve(circuitDir, "proof.json");
  writeFileSync(out, JSON.stringify(bundle, null, 2));
}

// Helper: load compiled ACIR json produced by generate_circuits
function loadCompiled(circuitDir: string, circuitName: string): CompiledCircuit {
  const jsonPath = resolve(circuitDir, "target", `${circuitName}.json`);
  if (!existsSync(jsonPath)) throw new Error(`Missing compiled json for ${circuitName}`);
  return JSON.parse(readFileSync(jsonPath, "utf-8"));
}

// Determine if circuit expects recursive params by counting ABI params
function circuitIsLeaf(c: CompiledCircuit): boolean {
  const params = c.abi?.parameters ?? [];
  // leaf signature: (triple, s, o) => [Field;2]
  return params.length === 3;
}

interface ProofResult {
  circuitName: string;
  proof: Uint8Array;
  publicInputs: string[];
  verificationKey: Uint8Array;
  isValid: boolean;
}

interface RecursiveProofData {
  path: string;
  circuits: string[];
  proofs: ProofResult[];
  finalProof: ProofResult | null;
}

async function loadCompiledCircuit(circuitPath: string): Promise<CompiledCircuit> {
  try {
    const circuitJson = readFileSync(circuitPath, 'utf-8');
    return JSON.parse(circuitJson) as CompiledCircuit;
  } catch (error) {
    throw new Error(`Failed to load circuit from ${circuitPath}: ${error}`);
  }
}

async function generateProofForCircuit(
  circuit: CompiledCircuit,
  witness: any,
  bb: Barretenberg
): Promise<LegacyProofResult> {
  const noir = new Noir(circuit);
  
  // Execute the circuit to get the witness
  const { witness: executedWitness } = await noir.execute(witness);
  
  // Create backend and generate proof
  const backend = new UltraHonkBackend(circuit.bytecode, undefined, { recursive: true });
  const vk = await backend.getVerificationKey();
  const { proof, publicInputs } = await backend.generateProof(executedWitness);
  
  // Verify the proof
  const isValid = await backend.verifyProof({ proof, publicInputs });
  
  // Convert verification key to fields for recursive verification
  const vkFields = (await bb.acirVkAsFieldsUltraHonk(new RawBuffer(vk))).map((f) => f.toString());
  
  return {
    circuitName: 'unknown', // CompiledCircuit doesn't have a name property
    proof,
    publicInputs: vkFields,
    verificationKey: vk,
    isValid
  };
}

// Legacy function removed - use provePathDirectory instead

// -----------------------------------------------------------------------------
// Generic bottom-up proof generator for a compiled path directory
// -----------------------------------------------------------------------------

function buildWitness(
  c: CompiledCircuit,
  triple: any,
  s: string,
  o: string,
  childBundles: Record<string, SavedProof>
): Record<string, any> {
  const w: Record<string, any> = {};
  for (const p of c.abi!.parameters!) {
    switch (p.name) {
      case "triple":
        w.triple = triple;
        break;
      case "s":
        w.s = s;
        break;
      case "o":
        w.o = o;
        break;
      default: {
        // matches child_vk, child_proof, child_public_inputs
        const m = p.name!.match(/child_(vk|proof|public_inputs)(_\d*)?/);
        if (!m) throw new Error(`Unhandled param ${p.name}`);
        const suffix = m[2] || "";
        // Find the actual child directory name
        let childDir = "";
        if (suffix === "") {
          // Single child case - look for one_or_more_inner_* or similar
          childDir = Object.keys(childBundles).find(key => 
            key.includes("one_or_more_inner_") || key.includes("zero_or_more_inner_")
          ) || "";
        } else {
          // Indexed child case - look for seq_segment_* or alt_option_*
          const index = suffix.replace("_", "");
          childDir = Object.keys(childBundles).find(key => 
            key.includes(`_${index}`) || key.includes(`segment_${index}`) || key.includes(`option_${index}`)
          ) || "";
        }
        
        // If not found by pattern, try direct lookup
        if (!childDir) {
          childDir = Object.keys(childBundles)[0] || "";
        }
        
        const bundle = childBundles[childDir];
        if (!bundle) {
          console.log(`Available bundles: ${Object.keys(childBundles).join(", ")}`);
          throw new Error(`Missing bundle for ${p.name} (looked for child dir: ${childDir})`);
        }
        if (m[1] === "vk") w[p.name!] = bundle.vk;
        else if (m[1] === "proof")
          w[p.name!] = Array.from(Buffer.from(bundle.proof, "hex"));
        else w[p.name!] = bundle.publicInputs;
      }
    }
  }
  return w;
}

interface CircuitProofResult {
  bundle?: SavedProof;
  error?: string;
  circuit: string;
}

// Legacy interface for compatibility
interface LegacyProofResult {
  circuitName: string;
  proof: Uint8Array;
  publicInputs: string[];
  verificationKey: Uint8Array;
  isValid: boolean;
}

async function provePathDirectory(pathDir: string, triple: any, s: string, o: string): Promise<{ bundle: SavedProof; errors: string[] }> {
  const bb = await Barretenberg.new();
  const bundleCache = new Map<string, SavedProof>();
  const errors: string[] = [];

  function getBundleForChild(name: string): SavedProof {
    if (!bundleCache.has(name))
      bundleCache.set(name,
        JSON.parse(readFileSync(resolve(pathDir, name, "proof.json"), "utf-8"))
      );
    return bundleCache.get(name)!;
  }

  // simple fix-point loop: each iteration try proving any circuit whose children already have proof.json
  let progress = true;
  const proven = new Set<string>();
  const childBundles: Record<string, SavedProof> = {};

  while (progress) {
    progress = false;
    const circuitDirs = readdirSync(pathDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    // Collect circuits ready to prove in this iteration
    const readyToProve: string[] = [];
    
    for (const dir of circuitDirs) {
      if (proven.has(dir)) continue;

      const full = resolve(pathDir, dir);
      const compiledName = dir; // compiled json matches dir name
      if (!existsSync(resolve(full, "target", `${compiledName}.json`))) continue; // not compiled yet

      // check if this circuit requires child proofs
      const compiled = loadCompiled(full, compiledName);
      const leaf = circuitIsLeaf(compiled);

      // if not leaf, ensure all expected child proof files exist
      if (!leaf) {
        const childProofMissing = compiled.abi?.parameters?.some(p => {
          if (!p.name?.startsWith("child_vk")) return false;
          // Extract child circuit name from parameter name
          const childName = p.name.replace(/child_vk_?/, "");
          const childDir = childName ? `alt_option_${childName}` : "one_or_more_inner_0084f1c9ab5e57c3c1cea0315d2c19d669096477e60ad5ab6e37a65474cf97a2";
          return !existsSync(resolve(pathDir, childDir, "proof.json"));
        });
        if (childProofMissing) continue; // wait until children proved
      }

      readyToProve.push(dir);
    }

    // Prove all ready circuits in parallel
    const proofPromises = readyToProve.map(async (dir): Promise<CircuitProofResult> => {
      const full = resolve(pathDir, dir);
      const compiledName = dir;
      const compiled = loadCompiled(full, compiledName);

      try {
        // build witness with real data
        const witness = buildWitness(compiled, triple, s, o, childBundles);

        const res = await generateProofForCircuit(compiled, witness, bb);
        const bundle = { vk: res.publicInputs, proof: Buffer.from(res.proof).toString("hex"), publicInputs: res.publicInputs };
        saveProofBundle(full, bundle);
        
        // cache for parent circuits - store with actual directory name
        childBundles[dir] = bundle;
        
        console.log(`✓ proof for ${dir}`);
        return { bundle, circuit: dir };
      } catch (err) {
        const error = `✗ proof failed for ${dir}: ${(err as Error).message}`;
        console.error(error);
        return { error, circuit: dir };
      }
    });

    const results = await Promise.all(proofPromises);
    
    // Process results
    for (const result of results) {
      if (result.error) {
        errors.push(result.error);
      } else {
        proven.add(result.circuit);
        progress = true;
      }
    }
  }

  await bb.destroy();

  // Return the root proof object
  const rootDir = readdirSync(pathDir).find(d => d.startsWith("circuit_"))!;
  const rootBundle: SavedProof = JSON.parse(
    readFileSync(resolve(pathDir, rootDir, "proof.json"), "utf-8")
  );
  
  return { bundle: rootBundle, errors };
}

// CLI usage: node dist/generate_proofs.js ../noir/generated/knows_plus [testCase]
if (import.meta.url === `file://${process.argv[1]}`) {
  const pathDir = process.argv[2];
  const testCase = process.argv[3] as keyof typeof import('./witness_generator.js').testData || 'knows';
  
  if (!pathDir) {
    console.error("Usage: node generate_proofs.js <pathDir> [testCase]");
    console.error("Available test cases: knows, worksAt, sequence");
    process.exit(1);
  }
  
  console.log(`🚀 Generating proofs with real data (test case: ${testCase})`);
  
  const witness = generateTestWitness(testCase);
  provePathDirectory(resolve(pathDir), witness.triple, witness.s, witness.o)
    .then(({ bundle, errors }) => {
      if (errors.length > 0) {
        console.error("❌ Errors:", errors);
        process.exit(1);
      }
      console.log("✅ Proof generation completed successfully!");
      console.log(`📊 Root proof: ${bundle.proof.length} bytes`);
      console.log(`🔑 VK fields: ${bundle.vk.length}`);
      console.log(`📝 Public inputs: ${bundle.publicInputs.length}`);
    })
    .catch(e => { console.error("💥 Fatal error:", e); process.exit(1); });
}

export { provePathDirectory };

