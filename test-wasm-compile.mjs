/**
 * Proof of concept: Using @noir-lang/noir_wasm to compile circuits
 * without invoking `nargo compile` as a child process.
 * 
 * This script demonstrates how to use the WASM-based Noir compiler
 * directly from Node.js, eliminating the need for child_process calls.
 * 
 * KEY FINDINGS:
 * 1. @noir-lang/noir_wasm provides compile_program() and createFileManager()
 * 2. It automatically resolves Git dependencies via GithubCodeArchiveDependencyResolver
 * 3. The FileManager needs to be rooted at the project directory containing Nargo.toml
 * 4. This eliminates the need for `nargo compile` child process calls
 */

import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import * as fs from 'fs';
import * as path from 'path';

const __dirname = new URL('.', import.meta.url).pathname;

/**
 * Compile a Noir circuit using the WASM compiler.
 * This is equivalent to running `nargo compile` but without spawning a child process.
 * 
 * @param {string} circuitDir - Path to the Noir project directory (containing Nargo.toml)
 * @returns {Promise<object>} - The compiled program artifacts
 */
export async function compileCircuitWasm(circuitDir, workspaceRoot = null) {
  console.log(`Compiling circuit at: ${circuitDir}`);
  
  // The FileManager needs to be rooted at a directory that can access all dependencies
  // Since we have relative path dependencies like "../noir/lib/consts", we need to
  // create the FileManager at the workspace root (parent of noir_prove), not at the circuit dir
  const absoluteCircuitDir = path.resolve(circuitDir);
  
  // If no workspace root provided, assume we need to go up one level to access ../noir/lib/consts
  const root = workspaceRoot ? path.resolve(workspaceRoot) : path.dirname(absoluteCircuitDir);
  const fm = createFileManager(root);
  
  try {
    console.log(`Workspace root: ${root}`);
    console.log(`Circuit directory: ${absoluteCircuitDir}`);
    console.log('Starting compilation...');
    const startTime = Date.now();
    
    // Compile the program using WASM
    // This replaces: execSync('cd noir_prove && nargo compile')
    const compiledArtifacts = await compile_program(
      fm,
      absoluteCircuitDir,  // Must be an absolute path to the project with Nargo.toml
      (msg) => console.log(msg),  // logFn
      (msg) => {}                 // debugLogFn (silent)
    );
    
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

// Run the test if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const circuitDir = path.join(__dirname, 'noir_prove');
  compileCircuitWasm(circuitDir)
    .then(() => {
      console.log('\n✅ Successfully compiled circuit using noir_wasm!');
      console.log('This proves we can eliminate the `nargo compile` child process call.');
    })
    .catch((err) => {
      console.error('\n❌ Failed:', err);
      process.exit(1);
    });
}
