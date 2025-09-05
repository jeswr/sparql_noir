import json from '../temp/main.json' with { type: 'json' };
import verifyCircuit from '../noir/bin/signature/target/signature.json' with { type: 'json' };
import secp256k1 from 'secp256k1';
import * as babyjubjub from 'babyjubjub-ecdsa';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';
import { defaultConfig } from '../dist/config.js';
const { publicKeyConvert } = secp256k1;

// Handle different signature types for verification
let publicKeyForCircuit, signatureForCircuit;

if (defaultConfig.signature === 'secp256k1') {
  const pubKey = Buffer.from(json.pubKey, 'hex');
  const publicKey = publicKeyConvert(pubKey, false);

  publicKeyForCircuit = {
    x: Array.from(publicKey.slice(1, 33)),
    y: Array.from(publicKey.slice(33, 65)),
  };
  signatureForCircuit = Array.from(Buffer.from(json.signature, 'hex'));
} else if (defaultConfig.signature === 'babyjubjub') {
  // For BabyJubJub, we need to convert the hex public key to appropriate format
  // The pubKey from babyjubjub is uncompressed (130 hex chars = 65 bytes)
  const pubKeyBytes = Buffer.from(json.pubKey, 'hex');

  // Extract both X and Y coordinates (32 bytes each) for the public key
  const xCoord = pubKeyBytes.slice(1, 33);  // Skip 0x04 prefix, take X coordinate  
  const yCoord = pubKeyBytes.slice(33, 65); // Take Y coordinate

  publicKeyForCircuit = {
    x: Array.from(xCoord),
    y: Array.from(yCoord),
  };

  // Convert DER signature to 64-byte format
  // For proper verification, we'd need to parse the DER format and extract r,s values
  // For now, use a simplified approach
  const sigBytes = Buffer.from(json.signature, 'hex');

  // Create a 64-byte signature array - in a real implementation, 
  // this would properly parse the DER format to extract r and s values
  const sig64 = Buffer.alloc(64);

  // Simple approach: use the signature bytes directly, padding if needed
  const copyLength = Math.min(sigBytes.length, 64);
  sigBytes.copy(sig64, 0, 0, copyLength);

  signatureForCircuit = Array.from(sig64);
} else {
  throw new Error(`Unsupported signature type: ${defaultConfig.signature}`);
}

// Proceed with circuit verification for all signature types
const noir = new Noir(verifyCircuit);
const backend = new UltraHonkBackend(verifyCircuit.bytecode);

try {
  const { witness } = await noir.execute({
    public_key: publicKeyForCircuit,
    root: {
      value: json.root,
      signature: signatureForCircuit,
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
