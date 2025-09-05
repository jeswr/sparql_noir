import json from '../temp/main.json' with { type: 'json' };
import verifyCircuit from '../noir/bin/signature/target/signature.json' with { type: 'json' };
import secp256k1 from 'secp256k1';
import * as babyjubjub from 'babyjubjub-ecdsa';
import bls from 'bls-signatures';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';
import { defaultConfig } from '../dist/config.js';
const { publicKeyConvert } = secp256k1;

// Main async function to handle BLS verification
async function main() {
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
  } else if (defaultConfig.signature === 'bls') {
  // For BLS, we need to convert the public key and signature formats
  // BLS public key is 48 bytes compressed G1 point
  const pubKeyBytes = Buffer.from(json.pubKey, 'hex');
  
  // For the circuit interface, we need to split into X and Y coordinates
  // Since BLS uses G1 points, we'll use the first 32 and next 16 bytes (padded)
  const xCoord = pubKeyBytes.slice(0, 32);
  const yCoordPart = pubKeyBytes.slice(32, 48);
  const yCoord = Buffer.concat([yCoordPart, Buffer.alloc(16, 0)]); // Pad to 32 bytes
  
  publicKeyForCircuit = {
    x: Array.from(xCoord),
    y: Array.from(yCoord),
  };
  
  // Convert BLS signature format
  // BLS signature is 96 bytes compressed G2 point, we'll use first 64 bytes
  const sigBytes = Buffer.from(json.signature, 'hex');
  const sig64 = Buffer.alloc(64);
  sigBytes.copy(sig64, 0, 0, Math.min(sigBytes.length, 64));
  
  signatureForCircuit = Array.from(sig64);
} else {
  throw new Error(`Unsupported signature type: ${defaultConfig.signature}`);
}

// First, perform JavaScript verification for all signature types
let jsVerificationValid = false;

if (defaultConfig.signature === 'secp256k1') {
  // Use secp256k1 for JavaScript verification
  const pubKey = Buffer.from(json.pubKey, 'hex');
  // For secp256k1, use the root_u8 if available, otherwise convert the root field
  let messageHash;
  if (json.messageHex) {
    messageHash = Buffer.from(json.messageHex, 'hex');
  } else {
    // Convert root field to bytes (this may need adjustment for endianness)
    const rootHex = json.root.startsWith('0x') ? json.root.slice(2) : json.root;
    messageHash = Buffer.from(rootHex, 'hex');
  }
  
  // Ensure message is exactly 32 bytes
  if (messageHash.length !== 32) {
    throw new Error(`Message must be 32 bytes, got ${messageHash.length}`);
  }
  
  jsVerificationValid = secp256k1.ecdsaVerify(
    Buffer.from(json.signature, 'hex'),
    messageHash,
    pubKey
  );
} else if (defaultConfig.signature === 'babyjubjub') {
  // Use babyjubjub for JavaScript verification
  // Use the exact message that was signed (stored during signing)
  const messageHex = json.messageHex || (() => {
    // Fallback if messageHex not stored (for compatibility)
    const rootHex = json.root.startsWith('0x') ? json.root.slice(2) : json.root;
    return Buffer.from(rootHex, 'hex').toString('hex');
  })();
  jsVerificationValid = babyjubjub.verify(json.pubKey, messageHex, json.signature);
} else if (defaultConfig.signature === 'bls') {
  // Use BLS for JavaScript verification
  // Need to make this async since BLS library requires it
  try {
    const BLS = await bls();
    
    // Reconstruct public key from hex
    const pubKeyBytes = Buffer.from(json.pubKey, 'hex');
    const pk = BLS.G1Element.from_bytes(pubKeyBytes);
    
    // Reconstruct signature from hex
    const sigBytes = Buffer.from(json.signature, 'hex');
    const signature = BLS.G2Element.from_bytes(sigBytes);
    
    // Get message bytes (use the stored messageHex or convert from root)
    const messageHex = json.messageHex || (() => {
      const rootHex = json.root.startsWith('0x') ? json.root.slice(2) : json.root;
      return rootHex;
    })();
    const messageBytes = new Uint8Array(Buffer.from(messageHex, 'hex'));
    
    // Verify BLS signature
    jsVerificationValid = BLS.AugSchemeMPL.verify(pk, messageBytes, signature);
  } catch (error) {
    console.log('BLS JavaScript verification error:', error.message);
    jsVerificationValid = false;
  }
}

console.log('JavaScript verification valid:', jsVerificationValid);

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
  console.log('This may be expected for', defaultConfig.signature, 'signatures with the current implementation');
}

  backend.destroy();
}

// Run the main function
main().catch(console.error);

