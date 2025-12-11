/**
 * Proof of concept: Using @noir-lang/noir_wasm to compile circuits
 * without invoking `nargo compile` as a child process.
 * 
 * This script demonstrates how to use the WASM-based Noir compiler
 * directly from Node.js, eliminating the need for child_process calls.
 */

import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import * as fs from 'fs';
import * as path from 'path';

const __dirname = new URL('.', import.meta.url).pathname;

async function compileCircuit(circuitDir) {
  console.log(`Compiling circuit at: ${circuitDir}`);
  
  // Create a file manager for the circuit directory
  const fm = createFileManager(circuitDir);
  
  try {
    console.log('Starting compilation...');
    const startTime = Date.now();
    
    // Compile the program using WASM
    const compiledArtifacts = await compile_program(fm);
    
    const endTime = Date.now();
    console.log(`Compilation completed in ${endTime - startTime}ms`);
    
    // The compiled artifacts contain the circuit bytecode and ABI
    console.log('Compiled artifact keys:', Object.keys(compiledArtifacts));
    
    if (compiledArtifacts.program) {
      console.log('Program artifact keys:', Object.keys(compiledArtifacts.program));
    }
    
    // Save the compiled artifacts (same format as nargo compile output)
    const targetDir = path.join(circuitDir, 'target');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    // Write the program artifact
    const outputPath = path.join(targetDir, 'sparql_proof.json');
    fs.writeFileSync(outputPath, JSON.stringify(compiledArtifacts.program || compiledArtifacts, null, 2));
    console.log(`Saved compiled artifact to: ${outputPath}`);
    
    return compiledArtifacts;
  } catch (err) {
    console.error('Compilation failed:', err.message);
    throw err;
  }
}

// Run the test
const circuitDir = path.join(__dirname, 'noir_prove');
compileCircuit(circuitDir)
  .then(() => {
    console.log('\n✅ Successfully compiled circuit using noir_wasm!');
    console.log('This proves we can eliminate the `nargo compile` child process call.');
  })
  .catch((err) => {
    console.error('\n❌ Failed:', err);
    process.exit(1);
  });
