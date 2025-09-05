// A script to prepare an RDF Dataset for a Merkle tree proof
import crypto from 'crypto';
import fs from "fs";
import path from "path";
import N3 from "n3";
import dereferenceToStore from "rdf-dereference-store";
import { RDFC10 } from "rdfjs-c14n";
import secp256k1 from 'secp256k1';
import * as babyjubjub from 'babyjubjub-ecdsa';
import bls from 'bls-signatures';
import { Command } from 'commander';
import { getTermEncodingString, runJson } from '../dist/encode.js';
import { quadToStringQuad } from 'rdf-string-ttl';
import { defaultConfig } from '../dist/config.js';

// Set up CLI with Commander
const program = new Command();

program
  .name('sign')
  .description('Prepare an RDF Dataset for a Merkle tree proof and generate a signature')
  .version('1.0.0')
  .requiredOption('-i, --input <path>', 'Input RDF document path (e.g., data.ttl)')
  .requiredOption('-o, --output <path>', 'Output JSON file path')
  .addHelpText('after', `
Examples:
  $ node scripts/sign.js -i inputs/data.ttl -o output/signed.json

The script will:
  1. Parse and canonicalize the input RDF document
  2. Generate a Merkle tree from the RDF triples
  3. Create a cryptographic signature of the Merkle root
  4. Output a JSON file containing the signature, public key, and metadata
  `)
  .parse();

const options = program.opts();

// Validate input file exists
if (!fs.existsSync(options.input)) {
  console.error(`Error: Input file '${options.input}' does not exist.`);
  process.exit(1);
}

// Ensure output directory exists
const outputDir = path.dirname(options.output);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}


// Dereference, parse and canonicalize the RDF dataset
const { store } = await dereferenceToStore.default(options.input, { localFiles: true });
const quads = (new N3.Parser()).parse(await new RDFC10().canonicalize(store));

const triples = quads.map(quad => '[' +
  [
    getTermEncodingString(quad.subject),
    getTermEncodingString(quad.predicate),
    getTermEncodingString(quad.object),
    getTermEncodingString(quad.graph)].join(',')
  +
  ']');

const jsonRes = runJson(`utils::merkle::<consts::MERKLE_DEPTH, ${quads.length}>([${triples.join(',')}])`);

// Add quotes around anything that looks like a hex encoding and then parse to json
jsonRes.nquads = quads.map(quad => quadToStringQuad(quad));

if (defaultConfig.signature === 'secp256k1') {
  let privKey, pubKey;

  // Generate secp256k1 private key
  do {
    privKey = crypto.randomBytes(32)
  } while (!secp256k1.privateKeyVerify(privKey))

  // get the public key in a compressed format
  pubKey = secp256k1.publicKeyCreate(privKey, false)

  const sigObj = secp256k1.ecdsaSign(Buffer.from(jsonRes.root_u8), privKey)
  jsonRes.signature = Array.from(sigObj.signature);
  jsonRes.pubKey = {
    x: Array.from(pubKey.slice(1, 33)),
    y: Array.from(pubKey.slice(33, 65)),
  };
} else if (defaultConfig.signature === 'babyjubjub') {
  // Generate BabyJubJub key pair
  const keyPair = babyjubjub.generateSignatureKeyPair();
  const privKey = keyPair.signingKey;
  const pubKey = babyjubjub.privateKeyToPublicKey(privKey);

  // Convert root to hex for babyjubjub signing
  const messageHex = Buffer.from(jsonRes.root_u8).toString('hex');
  jsonRes.signature = babyjubjub.sign(privKey, messageHex);
  jsonRes.pubKey = {
    // Hex encoded beginning with 0x
    x: `0x${pubKey.x}`,
    y: `0x${pubKey.y}`,
  };
  // Store the message that was signed for verification
  jsonRes.messageHex = messageHex;


  // For BabyJubJub, we need to convert the hex public key to appropriate format
  // The pubKey from babyjubjub is uncompressed (130 hex chars = 65 bytes)
  // const pubKeyBytes = Buffer.from(json.pubKey, 'hex');

  // // Extract both X and Y coordinates (32 bytes each) for the public key
  // const xCoord = pubKeyBytes.slice(1, 33);  // Skip 0x04 prefix, take X coordinate  
  // const yCoord = pubKeyBytes.slice(33, 65); // Take Y coordinate

  // publicKeyForCircuit = {
  //   x: Array.from(xCoord),
  //   y: Array.from(yCoord),
  // };

  // // Convert DER signature to 64-byte format
  // // For proper verification, we'd need to parse the DER format and extract r,s values
  // // For now, use a simplified approach
  // const sigBytes = Buffer.from(json.signature, 'hex');

  // // Create a 64-byte signature array - in a real implementation, 
  // // this would properly parse the DER format to extract r and s values
  // const sig64 = Buffer.alloc(64);

  // // Simple approach: use the signature bytes directly, padding if needed
  // const copyLength = Math.min(sigBytes.length, 64);
  // sigBytes.copy(sig64, 0, 0, copyLength);

  // signatureForCircuit = Array.from(sig64);
} else {
  throw new Error(`Unsupported signature type: ${defaultConfig.signature}`);
}

delete jsonRes.root_u8;

// Write the output file
fs.writeFileSync(options.output, JSON.stringify(jsonRes, null, 2));

console.log(`Successfully processed RDF dataset and generated signature.`);
console.log(`Input: ${options.input}`);
console.log(`Output: ${options.output}`);
