// A script to prepare an RDF Dataset for a Merkle tree proof
import crypto from 'crypto';
import fs from "fs";
import path from "path";
import N3 from "n3";
import dereferenceToStore from "rdf-dereference-store";
import { RDFC10 } from "rdfjs-c14n";
import secp256k1 from 'secp256k1';
// @ts-expect-error
import secp256r1 from 'secp256r1';
import { Command } from 'commander';
import { getTermEncodingString, runJson } from '../encode.js';
import { quadToStringQuad } from 'rdf-string-ttl';
import { defaultConfig } from '../config.js';
import { EdDSAPoseidon } from "@zk-kit/eddsa-poseidon";
import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub";
// @ts-expect-error
import * as bipSchnorr from 'bip-schnorr';

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
const embeddedCurveGenerator = runJson(`std::embedded_curve_ops::EmbeddedCurvePoint::generator()`);

// Add quotes around anything that looks like a hex encoding and then parse to json
jsonRes.nquads = quads.map(quad => quadToStringQuad(quad));

let privKey = crypto.randomBytes(32);

if (defaultConfig.signature === 'secp256k1' || defaultConfig.signature === 'secp256r1') {
  const pkg = defaultConfig.signature === 'secp256k1' ? secp256k1 : secp256r1;
  while (!pkg.privateKeyVerify(privKey))
    privKey = crypto.randomBytes(32)

  const pubKey = pkg.publicKeyCreate(privKey, false)
  const sigObj = (pkg.ecdsaSign || pkg.sign)(Buffer.from(jsonRes.root_u8), privKey)
  jsonRes.signature = Array.from(sigObj.signature);
  jsonRes.pubKey = {
    x: Array.from(pubKey.slice(1, 33)),
    y: Array.from(pubKey.slice(33, 65)),
  };
} 
// else if (defaultConfig.signature === 'babyjubjub') {
//   const ed = new EdDSAPoseidon(privKey)
//   const signature = ed.signMessage(jsonRes.root)
//   jsonRes.signature = {
//     r: {
//       x: '0x' + signature.R8[0].toString(16),
//       y: '0x' + signature.R8[1].toString(16),
//     },
//     s: '0x' + signature.S.toString(16),
//   }
//   jsonRes.pubKey = {
//     x: '0x' + ed.publicKey[0].toString(16),
//     y: '0x' + ed.publicKey[1].toString(16),
//   }
// } 
else if (defaultConfig.signature === 'babyjubjubOpt') {
  const ed = new EdDSAPoseidon(privKey)
  const signature = ed.signMessage(jsonRes.root)

  const left = mulPointEscalar(Base8, signature.S)

  // In a production setting the verifier needs to check this is correct
  const k8 = mulPointEscalar(ed.publicKey, 8n)
  
  jsonRes.signature = {
    r: {
      x: '0x' + signature.R8[0].toString(16),
      y: '0x' + signature.R8[1].toString(16),
    },
    left: {
      x: '0x' + left[0].toString(16),
      y: '0x' + left[1].toString(16),
    },
    s: '0x' + signature.S.toString(16),
  }
  jsonRes.pubKey = {
    value: {
      x: '0x' + ed.publicKey[0].toString(16),
      y: '0x' + ed.publicKey[1].toString(16),
    },
    k8: {
      x: '0x' + k8[0].toString(16),
      y: '0x' + k8[1].toString(16),
    },
  }
} else if (defaultConfig.signature === 'schnorr') {
  // while (!secp256k1.privateKeyVerify(privKey))
  //   privKey = crypto.randomBytes(32)
  // Use secp256k1 to get public key
  // const schnorrPubKey = secp256k1.publicKeyCreate(privKey, false); // uncompressed
  // bip-schnorr expects privKey as hex string
  // const schnorrPrivKeyHex = privKey.toString('hex');
  const ed = new EdDSAPoseidon(privKey);
  // ed.privateKey.valueOf();
  // Message must be Buffer
  const messageBuf = Buffer.from(jsonRes.root_u8);
  // console.log('schnorrPrivKeyHex:', ed.secretScalar, schnorrPrivKeyHex);
  const schnorrPrivKey = Buffer.from(ed.secretScalar.toString(16).padStart(64, '0'), 'hex').toString('hex');
  console.log('schnorrPrivKey:', schnorrPrivKey);
  
  const schnorrSig = bipSchnorr.default.sign(schnorrPrivKey, messageBuf);
  // bip-schnorr returns a Buffer (64 bytes: first 32 bytes = s, last 32 bytes = e)
  // const s = schnorrSig.slice(0, 32);
  // const e = schnorrSig.slice(32, 64);
  jsonRes.signature = Array.from(schnorrSig);
  console.log('schnorrSig:', schnorrSig, jsonRes.signature, jsonRes.signature.length);
  // const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  // const pubKeyX = BigInt('0x' + Buffer.from(schnorrPubKey.slice(1, 33)).toString('hex')) % FIELD_MODULUS;
  // const pubKeyY = BigInt('0x' + Buffer.from(schnorrPubKey.slice(33, 65)).toString('hex')) % FIELD_MODULUS;
  console.log('[ED publicKey]', ed.publicKey, ed.publicKey[0].toString(16))
  
  jsonRes.pubKey = {
    x: '0x' + ed.publicKey[0].toString(16),
    y: '0x' + ed.publicKey[1].toString(16),
    is_infinite: false,
  };
} else {
  throw new Error(`Unsupported signature type: ${defaultConfig.signature}`);
}

delete jsonRes.root_u8;

// Write the output file
fs.writeFileSync(options.output, JSON.stringify(jsonRes, null, 2));

console.log(`Successfully processed RDF dataset and generated signature.`);
console.log(`Input: ${options.input}`);
console.log(`Output: ${options.output}`);
