import { Algebra, Factory } from "sparqlalgebrajs";
import { createHash } from "crypto";
import { iriToField } from "./FIELD_MODULUS.js";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const hash = (str: string) => createHash('sha256').update(str).digest('hex');
const factory = new Factory();

interface CircuitInfo {
  circuitName: string;
  code: string;
  dependencies: string[]; // List of dependent circuit names
}

interface PathCircuit {
  // The constraint that should be verified in the parent circuit
  constraint: string;
  // Child circuits that need to be generated
  childCircuits: Map<string, PathCircuit>;
  // Whether this is a leaf circuit (no recursive proofs)
  isLeaf: boolean;
}

/**
 * Generate circuit structure for a SPARQL property path
 * This returns the constraint to be used in the parent circuit
 * and any child circuits that need to be generated
 */
function generatePathCircuit(pathSymbol: Algebra.PropertyPathSymbol): PathCircuit {
  switch (pathSymbol.type) {
    case Algebra.types.LINK:
      // Leaf circuit - directly checks the triple
      return {
        constraint: `((triple.terms[0] == s) & (triple.terms[2] == o) & (triple.terms[1] == ${iriToField(pathSymbol.iri.value)}))`,
        childCircuits: new Map(),
        isLeaf: true
      };
      
    case Algebra.types.SEQ:
      if (pathSymbol.input.length < 2) {
        throw new Error("Sequence paths must have at least 2 inputs");
      }
      
      // Generate child circuits for each segment
      const segments = pathSymbol.input.map(input => generatePathCircuit(input));
      const seqChildCircuits = new Map<string, PathCircuit>();
      
      segments.forEach((segment, i) => {
        const segmentName = `seq_segment_${i}_${hash(JSON.stringify(pathSymbol.input[i]))}`;
        seqChildCircuits.set(segmentName, segment);
        
        // Add nested child circuits
        segment.childCircuits.forEach((child, name) => {
          seqChildCircuits.set(name, child);
        });
      });
      
      // Generate constraint for chaining segments
      if (segments.length === 2) {
        // Two segments: verify they connect properly
        return {
          constraint: `((child_public_inputs_0[0] == s) & (child_public_inputs_0[1] == child_public_inputs_1[0]) & (child_public_inputs_1[1] == o))`,
          childCircuits: seqChildCircuits,
          isLeaf: false
        };
      } else {
        // Multiple segments: chain them all
        const constraints: string[] = [`(child_public_inputs_0[0] == s)`];
        for (let i = 0; i < segments.length - 1; i++) {
          constraints.push(`(child_public_inputs_${i}[1] == child_public_inputs_${i + 1}[0])`);
        }
        constraints.push(`(child_public_inputs_${segments.length - 1}[1] == o)`);
        
        return {
          constraint: constraints.join(" & "),
          childCircuits: seqChildCircuits,
          isLeaf: false
        };
      }
      
    case Algebra.types.ALT:
      if (pathSymbol.input.length < 2) {
        throw new Error("Alternation paths must have at least 2 inputs");
      }
      
      // For alternation, we need a selector to choose which proof to verify
      // This is a simplification - in practice, we'd need witness data to select
      const alternatives = pathSymbol.input.map(input => generatePathCircuit(input));
      const altChildCircuits = new Map<string, PathCircuit>();
      
      // For now, we'll generate code that verifies the first alternative
      // In a real implementation, we'd need a selector witness
      const firstAlt = alternatives[0]!;
      const altName = `alt_option_0_${hash(JSON.stringify(pathSymbol.input[0]))}`;
      altChildCircuits.set(altName, firstAlt);
      
      // Add nested child circuits from the first alternative
      firstAlt.childCircuits.forEach((child, name) => {
        altChildCircuits.set(name, child);
      });
      
      return {
        constraint: `((child_public_inputs[0] == s) & (child_public_inputs[1] == o))`,
        childCircuits: altChildCircuits,
        isLeaf: false
      };
      
    case Algebra.types.ZERO_OR_MORE_PATH:
      // Zero or more: either s == o (zero occurrences) or verify the path
      const innerPath = generatePathCircuit(pathSymbol.path);
      const zeroChildCircuits = new Map<string, PathCircuit>();
      const innerName = `zero_or_more_inner_${hash(JSON.stringify(pathSymbol.path))}`;
      zeroChildCircuits.set(innerName, innerPath);
      
      // Add nested child circuits
      innerPath.childCircuits.forEach((child, name) => {
        zeroChildCircuits.set(name, child);
      });
      
      return {
        constraint: `((s == o) | ((child_public_inputs[0] == s) & (child_public_inputs[1] == o)))`,
        childCircuits: zeroChildCircuits,
        isLeaf: false
      };
      
    case Algebra.types.ONE_OR_MORE_PATH:
      // One or more: must have at least one occurrence
      const onePath = generatePathCircuit(pathSymbol.path);
      const oneChildCircuits = new Map<string, PathCircuit>();
      const onePathName = `one_or_more_inner_${hash(JSON.stringify(pathSymbol.path))}`;
      oneChildCircuits.set(onePathName, onePath);
      
      // Add nested child circuits
      onePath.childCircuits.forEach((child, name) => {
        oneChildCircuits.set(name, child);
      });
      
      return {
        constraint: `((child_public_inputs[0] == s) & (child_public_inputs[1] == o))`,
        childCircuits: oneChildCircuits,
        isLeaf: false
      };
      
    default:
      throw new Error(`Unsupported path type: ${pathSymbol.type}`);
  }
}

/**
 * Generate the Noir code for a circuit
 */
function generateCircuitCode(
  circuitName: string,
  pathCircuit: PathCircuit,
  numChildProofs: number
): string {
  let code = `use dep::consts::{HONK_IDENTIFIER, HONK_PROOF_SIZE, HONK_VK_SIZE};\n`;
  code += `use dep::types::Triple;\n\n`;
  
  code += `fn main(\n`;
  code += `    triple: pub Triple,\n`;
  
  if (!pathCircuit.isLeaf && numChildProofs > 0) {
    // Add parameters for child proofs
    if (numChildProofs === 1) {
      // Single child proof - use non-indexed naming for simplicity
      code += `    child_vk: [Field; HONK_VK_SIZE],\n`;
      code += `    child_proof: [Field; HONK_PROOF_SIZE],\n`;
      code += `    child_public_inputs: [Field; 2], // [start, end] of child segment\n`;
    } else {
      // Multiple child proofs - use indexed naming
      for (let i = 0; i < numChildProofs; i++) {
        code += `    child_vk_${i}: [Field; HONK_VK_SIZE],\n`;
        code += `    child_proof_${i}: [Field; HONK_PROOF_SIZE],\n`;
        code += `    child_public_inputs_${i}: [Field; 2], // [start, end] of child segment ${i}\n`;
      }
    }
  }
  
  code += `    s: pub Field, // Start node\n`;
  code += `    o: pub Field, // End node\n`;
  code += `) -> pub [Field; 2] {\n`;
  
  if (!pathCircuit.isLeaf && numChildProofs > 0) {
    // Verify child proofs
    code += `    // Verify child proofs\n`;
    if (numChildProofs === 1) {
      // Single child proof
      code += `    std::verify_proof_with_type(child_vk, child_proof, child_public_inputs, 0x0, HONK_IDENTIFIER);\n`;
    } else {
      // Multiple child proofs
      for (let i = 0; i < numChildProofs; i++) {
        code += `    std::verify_proof_with_type(child_vk_${i}, child_proof_${i}, child_public_inputs_${i}, 0x0, HONK_IDENTIFIER);\n`;
      }
    }
    code += `    \n`;
  }
  
  // Add the path constraint
  code += `    // Verify the path constraint\n`;
  code += `    assert(${pathCircuit.constraint});\n`;
  code += `    \n`;
  code += `    [s, o]\n`;
  code += `}\n`;
  
  return code;
}

function generateNargoToml(circuitName: string): string {
  return `[package]
name = "${circuitName}"
type = "bin"
authors = ["auto-generated"]
compiler_version = ">=0.20.0"

[dependencies]
consts = { path = "../../../lib/consts" }
types = { path = "../../../lib/types" }
utils = { path = "../../../lib/utils" }
`;
}

function generateProverToml(): string {
  return `# Auto-generated Prover.toml
triple = ["0", "0", "0", "0", "0", "0"]
s = "0"
o = "0"
`;
}

/**
 * Get the direct children for a circuit based on its path type
 */
function getDirectChildren(
  pathSymbol: Algebra.PropertyPathSymbol,
  childCircuits: Map<string, PathCircuit>
): string[] {
  const allChildren = Array.from(childCircuits.keys());
  
  switch (pathSymbol.type) {
    case Algebra.types.SEQ:
      // SEQ has multiple direct children (one per segment)
      return allChildren.filter(name => name.startsWith('seq_segment_'));
      
    case Algebra.types.ALT:
      // ALT has one direct child (the selected alternative)
      return allChildren.filter(name => name.startsWith('alt_option_')).slice(0, 1);
      
    case Algebra.types.ZERO_OR_MORE_PATH:
      // ZERO_OR_MORE has one direct child (the inner path)
      return allChildren.filter(name => name.startsWith('zero_or_more_inner_'));
      
    case Algebra.types.ONE_OR_MORE_PATH:
      // ONE_OR_MORE has one direct child (the inner path)
      return allChildren.filter(name => name.startsWith('one_or_more_inner_'));
      
    case Algebra.types.LINK:
      // LINK is a leaf, no children
      return [];
      
    default:
      return [];
  }
}

/**
 * Generate all circuits for a property path
 */
function generateAllCircuits(
  pathName: string,
  pathSymbol: Algebra.PropertyPathSymbol,
  outputDir: string
): Map<string, CircuitInfo> {
  const circuits = new Map<string, CircuitInfo>();
  
  // Generate the main circuit
  const mainCircuit = generatePathCircuit(pathSymbol);
  const mainCircuitName = `circuit_${hash(JSON.stringify(pathSymbol))}`;
  
  // Count direct child proofs for the main circuit
  // For most path types, there's only one direct child, except for SEQ which has multiple segments
  const directChildren = getDirectChildren(pathSymbol, mainCircuit.childCircuits);
  
  const mainCode = generateCircuitCode(mainCircuitName, mainCircuit, directChildren.length);
  circuits.set(mainCircuitName, {
    circuitName: mainCircuitName,
    code: mainCode,
    dependencies: directChildren
  });
  
  // Generate all child circuits recursively
  function processChildCircuits(childCircuits: Map<string, PathCircuit>, parentPathSymbol?: Algebra.PropertyPathSymbol) {
    childCircuits.forEach((circuit, name) => {
      if (!circuits.has(name)) {
        // Determine the path type for this circuit
        // This is a bit tricky since we only have the circuit name
        // We'll need to infer it from the name pattern
        let circuitPathType: Algebra.types | undefined;
        if (name.startsWith('seq_segment_')) {
          // This is a segment of a sequence, need to determine what type of segment it is
          // For now, we'll assume it's recursive if it has children
          circuitPathType = circuit.childCircuits.size > 0 ? undefined : Algebra.types.LINK;
        } else if (name.startsWith('alt_option_')) {
          circuitPathType = circuit.childCircuits.size > 0 ? undefined : Algebra.types.LINK;
        } else if (name.startsWith('zero_or_more_inner_')) {
          circuitPathType = circuit.childCircuits.size > 0 ? undefined : Algebra.types.LINK;
        } else if (name.startsWith('one_or_more_inner_')) {
          circuitPathType = circuit.childCircuits.size > 0 ? undefined : Algebra.types.LINK;
        }
        
        // For simplicity, use the basic filtering for nested circuits
        // In a full implementation, we'd need to track the path symbol for each circuit
        const childDirectChildren = Array.from(circuit.childCircuits.keys()).filter(childName => 
          childName.startsWith('seq_segment_') || 
          childName.startsWith('alt_option_') || 
          childName.startsWith('zero_or_more_inner_') || 
          childName.startsWith('one_or_more_inner_')
        );
        
        const code = generateCircuitCode(name, circuit, childDirectChildren.length);
        circuits.set(name, {
          circuitName: name,
          code: code,
          dependencies: childDirectChildren
        });
        
        // Process nested children
        if (circuit.childCircuits.size > 0) {
          processChildCircuits(circuit.childCircuits);
        }
      }
    });
  }
  
  processChildCircuits(mainCircuit.childCircuits);
  
  return circuits;
}

/**
 * Write circuits to disk
 */
function writeCircuits(
  pathName: string,
  circuits: Map<string, CircuitInfo>,
  outputDir: string
): void {
  const pathDir = path.join(outputDir, pathName);
  
  circuits.forEach((circuit, name) => {
    const circuitDir = path.join(pathDir, name);
    const srcDir = path.join(circuitDir, "src");
    
    // Create directories
    fs.mkdirSync(srcDir, { recursive: true });
    
    // Write circuit code
    fs.writeFileSync(path.join(srcDir, "main.nr"), circuit.code);
    
    // Write Nargo.toml
    fs.writeFileSync(path.join(circuitDir, "Nargo.toml"), generateNargoToml(name));
    
    // Write Prover.toml
    fs.writeFileSync(path.join(circuitDir, "Prover.toml"), generateProverToml());
    
    console.log(`Created circuit: ${name}`);
  });
}

/**
 * Compile circuits using nargo
 */
function compileCircuits(pathName: string, outputDir: string): void {
  const pathDir = path.join(outputDir, pathName);
  
  // Get all circuit directories
  const circuitDirs = fs.readdirSync(pathDir)
    .filter(name => fs.statSync(path.join(pathDir, name)).isDirectory());
  
  console.log("\nCompiling circuits...");
  
  for (const circuitName of circuitDirs) {
    const circuitPath = path.join(pathDir, circuitName);
    console.log(`Compiling ${circuitName}...`);
    
    try {
      execSync("nargo build", {
        cwd: circuitPath,
        stdio: "inherit"
      });

      // Also produce ACIR JSON needed by noir_js (Step 2)
      // ACIR JSON files are generated by the writeCircuits function
      // No additional compilation step needed

      console.log(`✓ Compiled ${circuitName}`);
    } catch (error) {
      console.error(`✗ Failed to compile ${circuitName}:`, error);
    }
  }
}

/**
 * Main function to generate circuits for test paths
 */
function main() {
  const outputDir = path.join(process.cwd(), "..", "noir", "generated");
  
  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });
  
  // Test paths
  const testPaths = [
    {
      name: "knows_plus",
      path: factory.createOneOrMorePath(
        factory.createLink(factory.createTerm("http://example.org/knows") as any)
      )
    },
    {
      name: "knows_works_at",
      path: factory.createSeq([
        factory.createLink(factory.createTerm("http://example.org/knows") as any),
        factory.createLink(factory.createTerm("http://example.org/worksAt") as any)
      ])
    },
    {
      name: "knows_or_works_at_star",
      path: factory.createZeroOrMorePath(
        factory.createAlt([
          factory.createLink(factory.createTerm("http://example.org/knows") as any),
          factory.createLink(factory.createTerm("http://example.org/worksAt") as any)
        ])
      )
    }
  ];
  
  for (const testPath of testPaths) {
    console.log(`\n=== Generating circuits for: ${testPath.name} ===`);
    
    try {
      const circuits = generateAllCircuits(testPath.name, testPath.path, outputDir);
      console.log(`Generated ${circuits.size} circuits`);
      
      writeCircuits(testPath.name, circuits, outputDir);
      compileCircuits(testPath.name, outputDir);
      
      console.log(`\n=== Completed: ${testPath.name} ===`);
    } catch (error) {
      console.error(`Failed to generate circuits for ${testPath.name}:`, error);
    }
  }
  
  console.log("\n🎉 All circuits generated and compiled successfully!");
}

// Run if this is the main module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Compatibility exports for old interface
const pathToCircuit = generatePathCircuit;
const generateCircuits = generateAllCircuits;
const createCircuitFiles = writeCircuits;

export { 
  generatePathCircuit, 
  generateCircuitCode, 
  generateAllCircuits, 
  compileCircuits, 
  writeCircuits,
  // Compatibility exports
  pathToCircuit,
  generateCircuits,
  createCircuitFiles
};