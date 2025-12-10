/**
 * verify.ts - Verify ZK proofs for SPARQL query results
 * 
 * This script can verify:
 * 1. Standalone signature proofs (from sign.ts)
 * 2. SPARQL query proofs (from prove.ts)
 */
import { UltraHonkBackend } from '@aztec/bb.js';
import { type CompiledCircuit, type InputMap, Noir } from '@noir-lang/noir_js';
import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import type { ProveResult } from './prove.js';

// --- Exported Types ---

export interface VerifyOptions {
  circuitDir: string;
  proofData: ProveResult;
  threads?: number;
}

export interface VerifyResult {
  verified: number;
  failed: number;
  total: number;
  success: boolean;
}

// --- Exported Verify Functions ---

/**
 * Verify SPARQL query proofs
 */
export async function verifyProofs(options: VerifyOptions): Promise<VerifyResult> {
  const { circuitDir, proofData, threads = 6 } = options;

  const targetDir = join(circuitDir, 'target');

  if (!existsSync(targetDir)) {
    throw new Error(`Circuit target directory '${targetDir}' does not exist.`);
  }

  const circuitFiles = (await import('fs')).readdirSync(targetDir).filter((f: string) => f.endsWith('.json'));
  if (circuitFiles.length === 0) {
    throw new Error(`No compiled circuit JSON found in '${targetDir}'.`);
  }

  const circuitJsonPath = join(targetDir, circuitFiles[0]!);
  console.log(`Loading circuit: ${circuitJsonPath}`);

  const circuit = JSON.parse(readFileSync(circuitJsonPath, 'utf8')) as CompiledCircuit;
  const backend = new UltraHonkBackend(circuit.bytecode, { threads });

  const proofs = proofData.proofs || [];
  let verifiedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < proofs.length; i++) {
    const proofItem = proofs[i]!;
    console.log(`\nVerifying proof ${i + 1}/${proofs.length}...`);

    try {
      // Reconstruct proof object
      const proof = {
        proof: proofItem.proof instanceof Uint8Array
          ? proofItem.proof
          : new Uint8Array(proofItem.proof),
        publicInputs: proofItem.publicInputs as string[],
      };

      console.time(`  Verification`);
      const isValid = await backend.verifyProof(proof);
      console.timeEnd(`  Verification`);

      if (isValid) {
        console.log(`  ✓ Proof ${i + 1} verified`);
        verifiedCount++;
      } else {
        console.log(`  ✗ Proof ${i + 1} invalid`);
        failedCount++;
      }
    } catch (error) {
      console.error(`  ✗ Proof ${i + 1} error:`, (error as Error).message);
      failedCount++;
    }
  }

  backend.destroy();

  console.log(`\n========================================`);
  console.log(`Total proofs: ${proofs.length}`);
  console.log(`Verified: ${verifiedCount}`);
  console.log(`Failed: ${failedCount}`);

  return {
    verified: verifiedCount,
    failed: failedCount,
    total: proofs.length,
    success: failedCount === 0,
  };
}

// --- CLI Support Functions ---

async function verifySignatureProofCli(json: unknown, threads: number) {
  // Signature-only verification (original behavior)
  const circuitPath = join(process.cwd(), 'noir', 'bin', 'signature', 'target', 'signature.json');
  
  if (!existsSync(circuitPath)) {
    console.error(`Error: Signature circuit not found at '${circuitPath}'.`);
    console.error('Run: cd noir/bin/signature && nargo compile');
    process.exit(1);
  }

  const verifyCircuit = JSON.parse(readFileSync(circuitPath, 'utf8'));
  const noir = new Noir(verifyCircuit as unknown as CompiledCircuit);
  const backend = new UltraHonkBackend(verifyCircuit.bytecode, { threads });

  try {
    const jsonData = json as { pubKey: unknown; root: string; signature: unknown };
    console.time('Witness generation');
    const circuitInput = {
      public_key: jsonData.pubKey,
      root: {
        value: jsonData.root,
        signature: jsonData.signature,
      },
    };
    const { witness } = await noir.execute(circuitInput as InputMap);
    console.timeEnd('Witness generation');

    console.time('Proof generation');
    const proof = await backend.generateProof(witness);
    console.timeEnd('Proof generation');

    console.time('Proof verification');
    const isValid = await backend.verifyProof(proof);
    console.timeEnd('Proof verification');

    if (!isValid) {
      throw new Error('Signature verification failed');
    }

    console.log('\n✓ Signature proof verified successfully');
  } catch (error) {
    console.error('\n✗ Signature verification failed:', (error as Error).message);
    process.exit(1);
  } finally {
    backend.destroy();
  }
}

async function verifySparqlProofCli(json: ProveResult, circuitPath: string, threads: number) {
  const circuitDir = resolve(process.cwd(), circuitPath);

  try {
    const result = await verifyProofs({
      circuitDir,
      proofData: json,
      threads,
    });

    if (!result.success) {
      process.exit(1);
    }

    console.log('\n✓ All proofs verified successfully');
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}

// --- CLI Entry Point ---

// Only run CLI if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const program = new Command();

  program
    .name('verify')
    .description('Verify ZK proofs generated by sign.ts or prove.ts')
    .requiredOption('-i, --input <path>', 'Path to proof JSON (from prove.ts) or signed JSON (from sign.ts)')
    .option('-c, --circuit <path>', 'Path to compiled circuit directory (required for SPARQL proofs)')
    .option('--signature-only', 'Verify signature proof only (uses built-in signature circuit)')
    .option('--threads <n>', 'Number of threads for verification', '6')
    .addHelpText('after', `
Examples:
  # Verify a SPARQL query proof
  $ npm run verify -- -i proof.json -c output

  # Verify a signature-only proof
  $ npm run verify -- -i signed.json --signature-only
`)
    .parse();

  const opts = program.opts<{
    input: string;
    circuit?: string;
    signatureOnly?: boolean;
    threads: string;
  }>();

  const jsonPath = resolve(process.cwd(), opts.input);

  if (!existsSync(jsonPath)) {
    console.error(`Error: Input file '${jsonPath}' does not exist.`);
    process.exit(1);
  }

  const json = JSON.parse(readFileSync(jsonPath, 'utf8'));

  // Determine proof type
  const isProveOutput = json.proofs && Array.isArray(json.proofs);
  const isSignatureMode = opts.signatureOnly || (!isProveOutput && !opts.circuit);

  if (isSignatureMode) {
    console.log('Verifying signature proof...\n');
    verifySignatureProofCli(json, parseInt(opts.threads));
  } else {
    if (!opts.circuit) {
      console.error('Error: --circuit path required for SPARQL proof verification.');
      process.exit(1);
    }
    console.log('Verifying SPARQL query proof(s)...\n');
    verifySparqlProofCli(json as ProveResult, opts.circuit, parseInt(opts.threads));
  }
}
