import json from '../temp/main.json' with { type: 'json' };
import verifyCircuit from '../noir/bin/signature/target/signature.json' with { type: 'json' };
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';

// Proceed with circuit verification for all signature types
const noir = new Noir(verifyCircuit);
const backend = new UltraHonkBackend(verifyCircuit.bytecode);

try {
  const { witness } = await noir.execute({
    public_key: json.pubKey,
    root: {
      value: json.root,
      signature: json.signature,
    },
  });

  // Generate and verify the proof using UltraHonkBackend
  const proof = await backend.generateProof(witness);
  const isValid = await backend.verifyProof(proof);
  console.log('Circuit verification valid:', isValid);
} catch (error) {
  console.log('Circuit verification failed:', error.message);
}

backend.destroy();
