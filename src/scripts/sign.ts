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
import { Schnorr } from '@aztec/foundation/crypto';
import { Fq } from '@aztec/foundation/fields';

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

const mappings: { input: string; output: string }[] = fs.lstatSync(options.input).isFile()
  ? [{ input: options.input, output: options.output }]
  : fs.readdirSync(options.input).map(file => ({
    input: path.join(options.input, file),
    output: path.join(options.output, `${path.parse(file).name}.json`)
  }));

const dereferencedMappings = await Promise.all(mappings.map(async ({ input, output }) => {
  // Dereference, parse and canonicalize the RDF dataset
  const { store } = await dereferenceToStore.default(input, { localFiles: true });
  const quads = (new N3.Parser()).parse(await new RDFC10().canonicalize(store));
  const triples = quads.map(quad => '[' +
    [
      getTermEncodingString(quad.subject),
      getTermEncodingString(quad.predicate),
      getTermEncodingString(quad.object),
      getTermEncodingString(quad.graph)
    ].join(',')
    +
    ']');
  return {
    input,
    quads,
    output,
    triples,
    noirInput: `utils::merkle::<consts::MERKLE_DEPTH, ${triples.length}>([${triples.join(',')}])`,
  };
}));

const allTriples = dereferencedMappings.map(({ noirInput }) => noirInput);

const jsonResList = runJson(`[${allTriples.join(', ')}]`);

for (let i = 0; i < dereferencedMappings.length; i++) {
  const { output, quads, input } = dereferencedMappings[i]!;
  const jsonRes = jsonResList[i];

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
    const schnorr = new Schnorr();
    const schnorrPrivKey = Fq.random();

    const messageBuf = Buffer.from(jsonRes.root_u8);
    const signature = await schnorr.constructSignature(messageBuf, schnorrPrivKey);
    const publicKey = await schnorr.computePublicKey(schnorrPrivKey);

    jsonRes.signature = Array.from(signature.toBuffer());
    jsonRes.pubKey = {
      x: publicKey.x.toJSON(),
      y: publicKey.y.toJSON(),
      is_infinite: false,
    };
  } else {
    throw new Error(`Unsupported signature type: ${defaultConfig.signature}`);
  }

  delete jsonRes.root_u8;

  // Write the output file
  fs.writeFileSync(output, JSON.stringify(jsonRes, null, 2));

  console.log(`Successfully processed RDF dataset and generated signature.`);
  console.log(`Input: ${input}`);
  console.log(`Output: ${output}`);
}
