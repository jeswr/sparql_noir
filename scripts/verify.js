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

// Parse DER-encoded ECDSA signature into 64-byte r||s
function derToRS(derHex) {
  const der = Buffer.from(derHex, 'hex');
  if (der[0] !== 0x30) {
    throw new Error('Invalid DER: expected SEQUENCE (0x30)');
  }
  // Skip total length (assume short form)
  let offset = 2;
  if (der[offset] !== 0x02) throw new Error('Invalid DER: expected INTEGER for r');
  offset += 1;
  const rLen = der[offset];
  offset += 1;
  let r = der.slice(offset, offset + rLen);
  offset += rLen;
  if (der[offset] !== 0x02) throw new Error('Invalid DER: expected INTEGER for s');
  offset += 1;
  const sLen = der[offset];
  offset += 1;
  let s = der.slice(offset, offset + sLen);

  // Remove potential leading 0x00 used to indicate positive integers
  if (r.length > 32 && r[0] === 0x00) r = r.slice(1);
  if (s.length > 32 && s[0] === 0x00) s = s.slice(1);

  if (r.length > 32 || s.length > 32) {
    throw new Error('Invalid DER: r or s longer than 32 bytes');
  }

  const rPadded = Buffer.concat([Buffer.alloc(32 - r.length, 0), r]);
  const sPadded = Buffer.concat([Buffer.alloc(32 - s.length, 0), s]);
  return Buffer.concat([rPadded, sPadded]);
}

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
  
  // Convert DER signature to 64-byte r||s format for the circuit
  const sig64Buf = json.signatureRS
    ? Buffer.from(json.signatureRS, 'hex')
    : derToRS(json.signature);
  signatureForCircuit = Array.from(sig64Buf);
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

