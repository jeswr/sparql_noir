import json from '../temp/main.json' with { type: 'json' };
import verifyCircuit from '../noir/bin/signature/target/signature.json' with { type: 'json' };
import secp256k1 from 'secp256k1';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';
const { publicKeyConvert } = secp256k1;

const pubKey = Buffer.from(json.pubKey, 'hex');
const publicKey = publicKeyConvert(pubKey, false);

const noir = new Noir(verifyCircuit);
const backend = new UltraHonkBackend(verifyCircuit.bytecode);

const { witness } = await noir.execute({
  public_key: {
    x: Array.from(publicKey.slice(1, 33)),
    y: Array.from(publicKey.slice(33, 65)),
  },
  root: {
    value: json.root,
    signature: Array.from(Buffer.from(json.signature, 'hex')),
  },
});

// Generate and verify the proof using UltraHonkBackend
const proof = await backend.generateProof(witness);
const isValid = await backend.verifyProof(proof);
console.log('Is valid:', isValid);

backend.destroy();

