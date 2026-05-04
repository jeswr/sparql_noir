// A script to prepare an RDF Dataset for a Merkle tree proof
import crypto from 'crypto';
import fs from "fs";
import path from "path";
import N3 from "n3";
import type { Quad } from "@rdfjs/types";
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

// --- Exported Types ---

/**
 * Round-5 prefix-3 sorted Merkle commitment scaffolding (`spec/prefix-tree-commitment.md`).
 *
 * The signer publishes **two roots** in the signed payload:
 *
 *   - `root` (alias `root_4`) — leaf-hash sorted commitment over `hash4(s, p, o, g)` (round 3).
 *   - `rootPrefix3` (alias `root_3sp_g`) — prefix-3 sorted commitment over `hash3_sp_g(s, p, g)` (round 4).
 *
 * Both roots authenticate the same dataset; the verifier checks the
 * signature once over the concatenated `(root_4, root_3sp_g)` payload
 * (or two signatures over each root, depending on the chosen scheme).
 *
 * `prefixes3` carries the deduplicated `(s, p, g)` prefix multiset and
 * its Merkle paths so the prover can construct `bgp_prefix3` slot
 * witnesses for prefix-3 NOT EXISTS / OPTIONAL collapse circuits.
 *
 * Deployments that don't need the prefix tree can omit `prefixes3` and
 * set `rootPrefix3 = "0x0"`; any prover attempting a prefix-3
 * non-membership proof will fail because the genuine tree-build hash
 * won't equal zero. See `spec/prefix-tree-commitment.md` Sec.6.3.
 */
export interface PrefixTree3Data {
  /** Deduplicated `(s, p, g)` prefixes -- `[encoded_s, encoded_p, encoded_g]`. */
  prefixes: string[][];
  /** Per-prefix Merkle paths against `rootPrefix3`. */
  paths: string[][];
  /** Per-prefix direction bits. */
  direction: boolean[][];
  /** Low-sentinel inclusion path (sorted index 0). */
  lowSentinelPath: string[];
  lowSentinelDirections: boolean[];
  /** High-sentinel inclusion path (sorted index N + 1). */
  highSentinelPath: string[];
  highSentinelDirections: boolean[];
}

export interface SignedData {
  triples: string[][];
  paths: string[][];
  direction: boolean[][];
  root: string;
  root_u8?: number[];
  /**
   * Round-5 two-root signer ABI. The prefix-3 sorted Merkle root,
   * committed alongside `root` by the signer. Set to `"0x0"` for
   * deployments that don't build the prefix tree.
   */
  rootPrefix3?: string;
  /**
   * Round-5 prefix-3 sorted Merkle commitment data. Optional --
   * absent for round-3-only deployments.
   */
  prefix3?: PrefixTree3Data;
  signature: unknown;
  pubKey: unknown;
  nquads: Array<{
    subject: string;
    predicate: string;
    object: string;
    graph: string;
  }>;
}

export interface SignOptions {
  input: string;
  output?: string;
}

// --- Core Signing Logic ---

/**
 * Process RDF quads and generate a Merkle tree structure (leaf-hash
 * sorted, round 3).
 */
export async function processQuadsForMerkle(quads: Quad[]): Promise<{
  triples: string[];
  noirInput: string;
}> {
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
    triples,
    noirInput: `utils::merkle::<consts::MERKLE_DEPTH, ${triples.length}>([${triples.join(',')}])`,
  };
}

/**
 * Process RDF quads and generate the round-5 prefix-3 sorted Merkle
 * tree structure (`spec/prefix-tree-commitment.md` Sec.2). Leaves are
 * keyed by `hash3_sp_g(s, p, g)` -- drop the `o` position -- and
 * **deduplicated** at the input layer so adjacent equal-hash leaves
 * don't ambiguate the bracket non-membership proofs.
 *
 * Returns a string-encoded `[s, p, g]` prefix multiset and the Noir
 * call that builds the prefix-3 tree, or `null` if the dataset is
 * empty.
 */
export async function processQuadsForPrefix3(quads: Quad[]): Promise<{
  prefixes: string[];
  noirInput: string;
} | null> {
  if (quads.length === 0) {
    return null;
  }
  // Deduplicate by encoded (s, p, g) string -- two quads sharing the
  // same prefix collapse to a single tree leaf. See
  // `spec/prefix-tree-commitment.md` Sec.2.1.
  const seen = new Set<string>();
  const prefixes: string[] = [];
  for (const quad of quads) {
    const s = getTermEncodingString(quad.subject);
    const p = getTermEncodingString(quad.predicate);
    const g = getTermEncodingString(quad.graph);
    const key = `${s}|${p}|${g}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prefixes.push(`[${s},${p},${g}]`);
  }
  return {
    prefixes,
    noirInput: `utils::prefix3::merkle_prefix3::<consts::MERKLE_DEPTH, ${prefixes.length}>([${prefixes.join(',')}])`,
  };
}

/**
 * Generate cryptographic signature for a merkle root
 * This is the shared signing logic used by both sign.ts and index.ts
 */
export async function generateSignature(jsonRes: any, signatureScheme: string = defaultConfig.signature): Promise<void> {
  let privKey = crypto.randomBytes(32);

  if (signatureScheme === 'secp256k1' || signatureScheme === 'secp256r1') {
    const pkg = signatureScheme === 'secp256k1' ? secp256k1 : secp256r1;
    while (!pkg.privateKeyVerify(privKey))
      privKey = crypto.randomBytes(32);

    const pubKey = pkg.publicKeyCreate(privKey, false);
    const sigObj = (pkg.ecdsaSign || pkg.sign)(Buffer.from(jsonRes.root_u8), privKey);
    jsonRes.signature = Array.from(sigObj.signature);
    jsonRes.pubKey = {
      x: Array.from(pubKey.slice(1, 33)),
      y: Array.from(pubKey.slice(33, 65)),
    };
  } else if (signatureScheme === 'babyjubjubOpt') {
    const ed = new EdDSAPoseidon(privKey);
    const signature = ed.signMessage(jsonRes.root);

    const left = mulPointEscalar(Base8, signature.S);
    const k8 = mulPointEscalar(ed.publicKey, 8n);

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
    };
    jsonRes.pubKey = {
      value: {
        x: '0x' + ed.publicKey[0].toString(16),
        y: '0x' + ed.publicKey[1].toString(16),
      },
      k8: {
        x: '0x' + k8[0].toString(16),
        y: '0x' + k8[1].toString(16),
      },
    };
  } else if (signatureScheme === 'schnorr') {
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
    throw new Error(`Unsupported signature type: ${signatureScheme}`);
  }

  delete jsonRes.root_u8;
}

/**
 * Sign RDF data and return the signed data structure.
 *
 * Round-5 two-root signer ABI: builds **two** sorted Merkle trees in
 * parallel -- the leaf-hash sorted commitment over `(s, p, o, g)`
 * (round 3) and the prefix-3 sorted commitment over `(s, p, g)`
 * (round 4). Both roots are committed by the signer; circuits
 * dispatch to whichever tree the SPARQL operator's free-position
 * shape calls for. See `spec/prefix-tree-commitment.md` Sec.2.
 */
export async function signRdfData(inputPath: string): Promise<SignedData> {
  // Dereference, parse and canonicalize the RDF dataset
  const { store } = await dereferenceToStore.default(inputPath, { localFiles: true });
  const quads = (new N3.Parser()).parse(await new RDFC10().canonicalize(store));

  const { noirInput } = await processQuadsForMerkle(quads);
  const prefix3Spec = await processQuadsForPrefix3(quads);

  // Generate both Merkle trees via a single Noir execution. The
  // returned array carries one entry per top-level call, in order.
  const noirCalls = prefix3Spec
    ? `[${noirInput},${prefix3Spec.noirInput}]`
    : `[${noirInput}]`;
  const noirResults = runJson(noirCalls);
  const jsonRes: any = noirResults[0];

  if (prefix3Spec) {
    const prefix3Res: any = noirResults[1];
    jsonRes.rootPrefix3 = prefix3Res.root;
    jsonRes.prefix3 = {
      prefixes: prefix3Res.prefixes,
      paths: prefix3Res.paths,
      direction: prefix3Res.direction,
      lowSentinelPath: prefix3Res.low_sentinel_path,
      lowSentinelDirections: prefix3Res.low_sentinel_directions,
      highSentinelPath: prefix3Res.high_sentinel_path,
      highSentinelDirections: prefix3Res.high_sentinel_directions,
    };
  } else {
    // Empty dataset -- emit a sentinel zero root so the verifier ABI
    // shape stays consistent.
    jsonRes.rootPrefix3 = "0x0";
  }

  // Add quad string representations
  jsonRes.nquads = quads.map((quad: Quad) => quadToStringQuad(quad));

  // Generate cryptographic signature using shared logic.
  //
  // **Round-5 follow-up gap (roborev #545 high 2)**: the signature
  // currently covers only `root` (round-3 leaf-hash commitment);
  // generated prefix-3 circuits verify a signature on **both**
  // `roots[0]` and `roots[1]`, so a prefix-3 query proof will fail
  // verification until this is fixed. Tracked in
  // `spec/prefix-tree-commitment.md` Sec.8.6. The fix is to sign
  // a canonical concatenation (e.g. `hash2([root, rootPrefix3])`)
  // and update `noir/bin/signature/src/main.nr` accordingly.
  await generateSignature(jsonRes, defaultConfig.signature);

  return jsonRes as SignedData;
}

/**
 * Process RDF data without signing - minimal data for skip-signing mode.
 * Still computes encoded triples (needed for binding) but skips Merkle
 * tree / signature. Skip-signing rejects NOT EXISTS / OPTIONAL collapse
 * / prefix-tree non-membership upstream (in the transform layer), so
 * the prefix-3 tree is not built here either.
 */
export async function processRdfDataWithoutSigning(inputPath: string): Promise<SignedData> {
  // Dereference, parse and canonicalize the RDF dataset
  const { store } = await dereferenceToStore.default(inputPath, { localFiles: true });
  const quads = (new N3.Parser()).parse(await new RDFC10().canonicalize(store));

  const { triples: _triples, noirInput } = await processQuadsForMerkle(quads);

  // We still need to run the Noir execution to get the encoded triple values,
  // but we don't need the signature. The merkle function returns triples in encoded form.
  const jsonRes: any = runJson(`[${noirInput}]`)[0];

  // Add quad string representations
  jsonRes.nquads = quads.map((quad: Quad) => quadToStringQuad(quad));

  // Return with empty/placeholder signature data
  jsonRes.signature = [];
  jsonRes.pubKey = {};
  jsonRes.rootPrefix3 = "0x0";
  delete jsonRes.root_u8;

  return jsonRes as SignedData;
}

/**
 * Sign RDF data and write to output file
 */
export async function signAndWrite(options: SignOptions): Promise<SignedData> {
  const signedData = await signRdfData(options.input);
  
  if (options.output) {
    const outputDir = path.dirname(options.output);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(options.output, JSON.stringify(signedData, null, 2));
    console.log(`Successfully processed RDF dataset and generated signature.`);
    console.log(`Input: ${options.input}`);
    console.log(`Output: ${options.output}`);
  }
  
  return signedData;
}

// --- CLI Entry Point ---

// Only run CLI if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
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

  // Handle single file or directory
  const mappings: { input: string; output: string }[] = fs.lstatSync(options.input).isFile()
    ? [{ input: options.input, output: options.output }]
    : fs.readdirSync(options.input).map(file => ({
      input: path.join(options.input, file),
      output: path.join(options.output, `${path.parse(file).name}.json`)
    }));

  // Process each input file
  for (const mapping of mappings) {
    try {
      await signAndWrite(mapping);
    } catch (err) {
      console.error(`Error processing ${mapping.input}:`, (err as Error).message);
      process.exit(1);
    }
  }
}
