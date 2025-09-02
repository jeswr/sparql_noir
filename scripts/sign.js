// A script to prepare an RDF Dataset for a Merkle tree proof
import crypto from 'crypto';
import fs from "fs";
import N3 from "n3";
import dereferenceToStore from "rdf-dereference-store";
import { RDFC10 } from "rdfjs-c14n";
import secp256k1 from 'secp256k1';
import { getTermEncodingString, runJson } from '../dist/encode.js';
import { quadToStringQuad } from 'rdf-string-ttl';

// Dereference, parse and canonicalize the RDF dataset
const { store } = await dereferenceToStore.default('./inputs/data.ttl', { localFiles: true });
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

// generate privKey
let privKey
do {
  privKey = crypto.randomBytes(32)
} while (!secp256k1.privateKeyVerify(privKey))

// get the public key in a compressed format
const pubKey = secp256k1.publicKeyCreate(privKey)

// sign the message 
const sigObj = secp256k1.ecdsaSign(Buffer.from(jsonRes.root_u8), privKey)
delete jsonRes.root_u8;

jsonRes.pubKey = Buffer.from(pubKey).toString('hex');
jsonRes.signaure = Buffer.from(sigObj.signature).toString('hex');

if (!fs.existsSync('./temp'))
  fs.mkdirSync('./temp', { recursive: true });

fs.writeFileSync('./temp/main.json', JSON.stringify(jsonRes, null, 2));
