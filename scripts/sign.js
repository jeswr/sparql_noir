// A script to prepare an RDF Dataset for a Merkle tree proof
import crypto from 'crypto';
import fs from "fs";
import path from "path";
import N3 from "n3";
import dereferenceToStore from "rdf-dereference-store";
import { RDFC10 } from "rdfjs-c14n";
import secp256k1 from 'secp256k1';
import * as babyjubjub from 'babyjubjub-ecdsa';
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

// Generate key pair and sign based on the configured signature type
let privKey, pubKey, signature;

if (defaultConfig.signature === 'secp256k1') {
  // Generate secp256k1 private key
  do {
    privKey = crypto.randomBytes(32)
  } while (!secp256k1.privateKeyVerify(privKey))

  // get the public key in a compressed format
  pubKey = secp256k1.publicKeyCreate(privKey)

  // sign the message 
  const messageBytes = Buffer.from(jsonRes.root_u8);
  const sigObj = secp256k1.ecdsaSign(messageBytes, privKey)
  signature = Buffer.from(sigObj.signature).toString('hex');
  jsonRes.pubKey = Buffer.from(pubKey).toString('hex');
  // Store the message that was signed for verification
  jsonRes.messageHex = messageBytes.toString('hex');
} else if (defaultConfig.signature === 'babyjubjub') {
  // Generate BabyJubJub key pair
  const keyPair = babyjubjub.generateSignatureKeyPair();
  privKey = keyPair.signingKey;
  pubKey = keyPair.verifyingKey;
  
  // Convert root to hex for babyjubjub signing
  const messageHex = Buffer.from(jsonRes.root_u8).toString('hex');
  signature = babyjubjub.sign(privKey, messageHex);
  // Export r||s for circuit consumption
  // If library returns DER, convert by parsing r and s
  function derToRS(derHex) {
    const der = Buffer.from(derHex, 'hex');
    if (der[0] !== 0x30) return Buffer.from(derHex, 'hex');
    let offset = 2;
    if (der[offset] !== 0x02) return Buffer.from(derHex, 'hex');
    offset += 1;
    const rLen = der[offset];
    offset += 1;
    let r = der.slice(offset, offset + rLen);
    offset += rLen;
    if (der[offset] !== 0x02) return Buffer.from(derHex, 'hex');
    offset += 1;
    const sLen = der[offset];
    offset += 1;
    let s = der.slice(offset, offset + sLen);
    if (r.length > 32 && r[0] === 0x00) r = r.slice(1);
    if (s.length > 32 && s[0] === 0x00) s = s.slice(1);
    const rPadded = Buffer.concat([Buffer.alloc(32 - r.length, 0), r]);
    const sPadded = Buffer.concat([Buffer.alloc(32 - s.length, 0), s]);
    return Buffer.concat([rPadded, sPadded]);
  }
  const sig64 = derToRS(signature);
  jsonRes.pubKey = pubKey;
  // Store the message that was signed for verification
  jsonRes.messageHex = messageHex;
  jsonRes.signatureRS = sig64.toString('hex');
} else {
  throw new Error(`Unsupported signature type: ${defaultConfig.signature}`);
}

delete jsonRes.root_u8;
jsonRes.signature = signature;

// Write the output file
fs.writeFileSync(options.output, JSON.stringify(jsonRes, null, 2));

console.log(`Successfully processed RDF dataset and generated signature.`);
console.log(`Input: ${options.input}`);
console.log(`Output: ${options.output}`);
console.log(`Public Key: ${jsonRes.pubKey}`);
console.log(`Signature: ${jsonRes.signature}`);
