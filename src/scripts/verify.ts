import { UltraHonkBackend } from '@aztec/bb.js';
import { type CompiledCircuit, Noir } from '@noir-lang/noir_js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load JSON files dynamically
const jsonPath = join(process.cwd(), 'temp', 'main.json');
const circuitPath = join(process.cwd(), 'noir', 'bin', 'signature', 'target', 'signature.json');

const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
const verifyCircuit = JSON.parse(readFileSync(circuitPath, 'utf8'));

// Proceed with circuit verification for all signature types
const noir = new Noir(verifyCircuit as unknown as CompiledCircuit);
const backend = new UltraHonkBackend(verifyCircuit.bytecode, { threads: 6 });

try {
  console.time('Witness generation');
  const { witness } = await noir.execute({
    public_key: json.pubKey,
    root: {
      value: json.root,
      signature: json.signature,
    },
  });
  console.timeEnd('Witness generation');

  // Generate and verify the proof using UltraHonkBackend
  console.time('Proof generation');
  const proof = await backend.generateProof(witness);
  console.timeEnd('Proof generation');

  console.time('Proof verification');
  const isValid = await backend.verifyProof(proof);
  console.timeEnd('Proof verification');

  if (!isValid)
    throw new Error('Circuit verification failed');
} catch (error) {
  // @ts-expect-error
  console.log('Circuit verification failed:', error.message);
}

backend.destroy();
