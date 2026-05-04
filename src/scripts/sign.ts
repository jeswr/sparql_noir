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
  /** Round-3 leaf-hash sorted Merkle root (`root_4`). */
  root: string;
  root_u8?: number[];
  /** Round-3 low / high sentinel inclusion paths against `root`. */
  lowSentinelPath?: string[];
  lowSentinelDirections?: boolean[];
  highSentinelPath?: string[];
  highSentinelDirections?: boolean[];
  /**
   * Round-6 two-root signer ABI. The prefix-3 sorted Merkle root,
   * committed alongside `root` by the signer. Set to `"0x0"` for
   * deployments that don't build the prefix tree.
   */
  rootPrefix3?: string;
  /**
   * Round-6 prefix-3 sorted Merkle commitment data. Optional --
   * absent for round-3-only deployments.
   */
  prefix3?: PrefixTree3Data;
  /**
   * Signature over `root` (round 3). When the signer builds the
   * prefix-3 tree, the round-3 root is signed separately from
   * `signaturePrefix3` -- generated `main.nr` calls
   * `verify_signature(public_key, roots[i])` once per root.
   */
  signature: unknown;
  /**
   * Round-6 signature over `rootPrefix3`. Present iff `prefix3` is
   * present. The two-signature design (vs hash-of-concatenation)
   * keeps the existing `Root.signature`-per-root ABI in `main.nr`
   * unchanged, so each prefix variant added in subsequent rounds
   * just appends a `(rootK, signatureK)` pair without rotating any
   * verifier code. See `spec/prefix-tree-commitment.md` Sec.8.6.
   */
  signaturePrefix3?: unknown;
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
 * Internal -- materialise a fresh signing key for `signatureScheme`.
 * Returns the private key bytes plus the public-key payload that the
 * generated `main.nr` expects. Shared by `generateSignature` so all
 * roots committed by the signer use the **same** key (the verifier
 * accepts `public_key: [PubKey; 1]`, so all `roots[i].signature`
 * must be issued by `public_key[0]`).
 */
function generateKeyPair(signatureScheme: string): { privKey: Buffer; pubKey: unknown; schnorrPrivKey?: unknown } {
  let privKey = crypto.randomBytes(32);

  if (signatureScheme === 'secp256k1' || signatureScheme === 'secp256r1') {
    const pkg = signatureScheme === 'secp256k1' ? secp256k1 : secp256r1;
    while (!pkg.privateKeyVerify(privKey))
      privKey = crypto.randomBytes(32);

    const pubKey = pkg.publicKeyCreate(privKey, false);
    return {
      privKey,
      pubKey: {
        x: Array.from(pubKey.slice(1, 33)),
        y: Array.from(pubKey.slice(33, 65)),
      },
    };
  } else if (signatureScheme === 'babyjubjubOpt') {
    const ed = new EdDSAPoseidon(privKey);
    const k8 = mulPointEscalar(ed.publicKey, 8n);
    return {
      privKey,
      pubKey: {
        value: {
          x: '0x' + ed.publicKey[0].toString(16),
          y: '0x' + ed.publicKey[1].toString(16),
        },
        k8: {
          x: '0x' + k8[0].toString(16),
          y: '0x' + k8[1].toString(16),
        },
      },
    };
  } else if (signatureScheme === 'schnorr') {
    const schnorrPrivKey = Fq.random();
    return { privKey, pubKey: undefined, schnorrPrivKey };
  } else {
    throw new Error(`Unsupported signature type: ${signatureScheme}`);
  }
}

/**
 * Internal -- sign a single Merkle root under the given key. Returns
 * the signature payload in the shape `main.nr`'s `Root.signature`
 * field expects (per `noir/lib/signatures/<scheme>/src/lib.nr`).
 *
 * `rootHex` is the Field-element root as a `0x`-prefixed string (used
 * by Poseidon-style schemes that hash the field directly).
 * `rootBytes` is the same value as a 32-byte little-endian array
 * (used by ECDSA / Schnorr schemes that operate on byte messages).
 */
async function signRoot(
  signatureScheme: string,
  rootHex: string,
  rootBytes: number[],
  keyPair: { privKey: Buffer; pubKey: unknown; schnorrPrivKey?: unknown },
): Promise<{ signature: unknown; pubKey: unknown }> {
  if (signatureScheme === 'secp256k1' || signatureScheme === 'secp256r1') {
    const pkg = signatureScheme === 'secp256k1' ? secp256k1 : secp256r1;
    const sigObj = (pkg.ecdsaSign || pkg.sign)(Buffer.from(rootBytes), keyPair.privKey);
    return { signature: Array.from(sigObj.signature), pubKey: keyPair.pubKey };
  } else if (signatureScheme === 'babyjubjubOpt') {
    const ed = new EdDSAPoseidon(keyPair.privKey);
    const signature = ed.signMessage(rootHex);
    const left = mulPointEscalar(Base8, signature.S);
    return {
      signature: {
        r: {
          x: '0x' + signature.R8[0].toString(16),
          y: '0x' + signature.R8[1].toString(16),
        },
        left: {
          x: '0x' + left[0].toString(16),
          y: '0x' + left[1].toString(16),
        },
        s: '0x' + signature.S.toString(16),
      },
      pubKey: keyPair.pubKey,
    };
  } else if (signatureScheme === 'schnorr') {
    const schnorr = new Schnorr();
    const messageBuf = Buffer.from(rootBytes);
    const schnorrPrivKey = keyPair.schnorrPrivKey as InstanceType<typeof Fq>;
    const signature = await schnorr.constructSignature(messageBuf, schnorrPrivKey);
    const publicKey = await schnorr.computePublicKey(schnorrPrivKey);
    return {
      signature: Array.from(signature.toBuffer()),
      pubKey: {
        x: publicKey.x.toJSON(),
        y: publicKey.y.toJSON(),
        is_infinite: false,
      },
    };
  }
  throw new Error(`Unsupported signature type: ${signatureScheme}`);
}

/**
 * Generate cryptographic signature(s) for the dataset's Merkle root(s).
 * Shared by `sign.ts` and `index.ts`.
 *
 * Round-6 two-root signer ABI (`spec/prefix-tree-commitment.md`
 * Sec.8.6): when `jsonRes.rootPrefix3` is present (a non-`"0x0"`
 * prefix-3 sorted root), the signer issues a **second signature**
 * under the same key on the prefix-3 root, stored in
 * `jsonRes.signaturePrefix3`. Generated `main.nr` calls
 * `verify_signature(public_key[0], roots[i])` once per root, so the
 * verifier sees both signatures pinned to the same `pubKey` --
 * binding both commitments to one signer without changing the
 * verifier's `Root` ABI.
 *
 * Two separate signatures (vs a single signature on
 * `hash2([root_4, root_3sp_g])`) was chosen to minimise verifier-side
 * churn: the existing `for i in 0..K { verify_signature(...) }` loop
 * in `main.nr` already accepts an arbitrary number of signed roots.
 * Adding a hash-of-roots scheme would require teaching `main.nr` to
 * recompute that hash inside the circuit on every prove, which is
 * cheaper to amortise across queries but harder to extend when
 * future prefix variants land. With per-root signatures, each new
 * prefix tree just appends one more `Root` slot and one more
 * `signRoot` call -- no `verify_signature` change. See
 * `spec/prefix-tree-commitment.md` Sec.8.6 for the trade-off.
 */
export async function generateSignature(jsonRes: any, signatureScheme: string = defaultConfig.signature): Promise<void> {
  const keyPair = generateKeyPair(signatureScheme);

  // Round 3 / round 4 leaf-hash sorted root.
  const root4Bytes: number[] = jsonRes.root_u8 ?? [];
  const round3 = await signRoot(signatureScheme, jsonRes.root, root4Bytes, keyPair);
  jsonRes.signature = round3.signature;
  jsonRes.pubKey = round3.pubKey;

  // Round 6 prefix-3 sorted root. Sign separately under the same
  // key when the prefix-3 commitment was built; both signatures
  // bind to one signer via the shared `public_key`.
  const prefix3RootHex: string | undefined = jsonRes.rootPrefix3;
  const prefix3RootBytes: number[] | undefined = jsonRes.rootPrefix3_u8;
  const prefix3IsRealRoot = prefix3RootHex && prefix3RootHex !== '0x0' && prefix3RootHex !== '0x00';
  if (prefix3IsRealRoot && prefix3RootBytes) {
    const round6 = await signRoot(signatureScheme, prefix3RootHex!, prefix3RootBytes, keyPair);
    jsonRes.signaturePrefix3 = round6.signature;
  }

  delete jsonRes.root_u8;
  delete jsonRes.rootPrefix3_u8;
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

  // Generate the two Merkle trees in **separate** Noir executions.
  // Noir's `print([...])` insists every array element has the same
  // type, but `merkle::<...>` returns `MerkleInfo<M, N>` while
  // `merkle_prefix3::<...>` returns `MerklePrefix3Info<M, N3>` --
  // different generic struct types -- so we batch them into one
  // outer array only when they happen to be the same shape.
  // Two single-element calls are cheap enough at sign time and keep
  // the result extraction trivial.
  const jsonRes: any = runJson(`[${noirInput}]`)[0];

  // Surface round-3 sentinel inclusion paths to the prover. The
  // generated `main.nr` calls `verify_low_sentinel_inclusion` /
  // `verify_high_sentinel_inclusion` against `roots[0]`, so the
  // prover needs the sentinel paths in `signedData`. Emitted by
  // `merkle()` alongside the per-leaf paths -- just preserve them.
  jsonRes.lowSentinelPath = jsonRes.low_sentinel_path;
  jsonRes.lowSentinelDirections = jsonRes.low_sentinel_directions;
  jsonRes.highSentinelPath = jsonRes.high_sentinel_path;
  jsonRes.highSentinelDirections = jsonRes.high_sentinel_directions;
  delete jsonRes.low_sentinel_path;
  delete jsonRes.low_sentinel_directions;
  delete jsonRes.high_sentinel_path;
  delete jsonRes.high_sentinel_directions;

  if (prefix3Spec) {
    const prefix3Res: any = runJson(`[${prefix3Spec.noirInput}]`)[0];
    jsonRes.rootPrefix3 = prefix3Res.root;
    // Stash the prefix-3 root bytes for `generateSignature` to sign
    // under the same key; deleted before returning.
    jsonRes.rootPrefix3_u8 = prefix3Res.root_u8;
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

  // Round-6 two-root signer (`spec/prefix-tree-commitment.md`
  // Sec.8.6): `generateSignature` issues separate signatures for
  // `root` and `rootPrefix3` under the same key. The generated
  // `main.nr` runs `verify_signature(public_key[0], roots[i])` for
  // every committed root, so this closes the prefix-3 signature
  // gap (roborev #545 high 2).
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
  delete jsonRes.rootPrefix3_u8;

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
