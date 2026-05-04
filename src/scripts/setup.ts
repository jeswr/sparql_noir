/**
 * Setup script for configuring noir/lib/consts based on selected hash, signature, and merkle depth.
 *
 * Usage:
 *   npx ts-node src/scripts/setup.ts                                    # Use defaults
 *   npx ts-node src/scripts/setup.ts --hash pedersen --sig schnorr      # Custom config
 *   npx ts-node src/scripts/setup.ts --hash poseidon2 --depth 13        # Custom config
 *   npx ts-node src/scripts/setup.ts --string-len-max 128               # Wider byte witness
 *
 * Options:
 *   --hash             Field hash function: pedersen, poseidon, poseidon2, mimc
 *   --string-hash      String hash function: blake2s, blake3, sha256, keccak256
 *   --sig              Signature scheme: secp256k1, secp256r1, babyjubjubOpt, schnorr
 *   --depth            Merkle tree depth: 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31
 *   --string-len-max   Per-term bounded byte-array bound (default 64; see spec/encoding.md sec.6.5)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mappings from '../mappings.js';
import { defaultConfig, fieldHashes, stringHashes, signatures, merkleDepths, DEFAULT_STRING_LEN_MAX } from '../config.js';
const { noir, rename } = mappings;

// Parse command line arguments
function parseArgs(): typeof defaultConfig {
  const args = process.argv.slice(2);
  const config = { ...defaultConfig };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];

    if (arg === '--hash' && value) {
      if ((fieldHashes as readonly string[]).includes(value)) {
        config.fieldHash = value as typeof config.fieldHash;
      } else {
        console.error(`Invalid hash: ${value}. Valid options: ${fieldHashes.join(', ')}`);
        process.exit(1);
      }
      i++;
    } else if (arg === '--string-hash' && value) {
      if ((stringHashes as readonly string[]).includes(value)) {
        config.stringHash = value as typeof config.stringHash;
      } else {
        console.error(`Invalid string hash: ${value}. Valid options: ${stringHashes.join(', ')}`);
        process.exit(1);
      }
      i++;
    } else if (arg === '--sig' && value) {
      if ((signatures as readonly string[]).includes(value)) {
        config.signature = value as typeof config.signature;
      } else {
        console.error(`Invalid signature: ${value}. Valid options: ${signatures.join(', ')}`);
        process.exit(1);
      }
      i++;
    } else if (arg === '--depth' && value) {
      const depth = parseInt(value, 10);
      if ((merkleDepths as readonly number[]).includes(depth)) {
        config.merkleDepth = depth as typeof config.merkleDepth;
      } else {
        console.error(`Invalid depth: ${value}. Valid options: ${merkleDepths.join(', ')}`);
        process.exit(1);
      }
      i++;
    } else if (arg === '--string-len-max' && value) {
      const n = parseInt(value, 10);
      if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
        config.stringLenMax = n;
      } else {
        console.error(`Invalid --string-len-max: ${value}. Must be a positive integer.`);
        process.exit(1);
      }
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Setup script for configuring noir/lib/consts

Usage: npx ts-node src/scripts/setup.ts [options]

Options:
  --hash <hash>         Field hash function (default: ${defaultConfig.fieldHash})
                        Options: ${fieldHashes.join(', ')}
  --string-hash <hash>  String hash function (default: ${defaultConfig.stringHash})
                        Options: ${stringHashes.join(', ')}
  --sig <signature>     Signature scheme (default: ${defaultConfig.signature})
                        Options: ${signatures.join(', ')}
  --depth <depth>       Merkle tree depth (default: ${defaultConfig.merkleDepth})
                        Options: ${merkleDepths.join(', ')}
  --string-len-max <n>  Bounded byte-array witness per term (default: ${DEFAULT_STRING_LEN_MAX})
                        Any positive integer; trade-off documented in
                        spec/encoding.md sec.6.4
  --help, -h            Show this help message
`);
      process.exit(0);
    }
  }

  return config;
}

const config = parseArgs();
const noirDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'noir');

console.log('Configuring noir/lib/consts with:');
console.log(`  Field hash:    ${config.fieldHash}`);
console.log(`  String hash:   ${config.stringHash}`);
console.log(`  Signature:     ${config.signature}`);
console.log(`  Merkle depth:  ${config.merkleDepth}`);
console.log(`  STRING_LEN_MAX: ${config.stringLenMax}`);

// Round-2 byte-binding (`encode_string_bounded` / `bind_term_bytes`)
// requires a variable-length string-hash primitive; today only sha256
// is plumbed through. Other configured hashes assert at proving time
// for circuits exercising round-2 -- surface that limitation here so
// callers don't only find out at proving time.
if (config.stringHash !== 'sha256') {
  console.warn(
    `\n  WARNING: round-2 byte-binding (STRLEN/STRSTARTS/CONTAINS, encode_string_bounded)\n` +
    `           is sha256-only today. Selected stringHash=${config.stringHash} -- circuits\n` +
    `           that exercise byte binding will assert at proving time. Round-3 scope\n` +
    `           (see spec/encoding.md sec.6.5).\n`,
  );
}

for (const file of fs.readdirSync(noirDir, { recursive: true })) {
  if (typeof file === 'string' && file.endsWith('.template')) {
    let libTemplate = fs.readFileSync(path.join(noirDir, file), 'utf8');

    for (const [key, value] of Object.entries(noir)) {
      // @ts-expect-error
      libTemplate = libTemplate.replaceAll(`{{${key}}}`, value[config[rename[key] ?? key]] ?? config[rename[key] ?? key]);
    }

    if (!libTemplate.includes('{{'))
      fs.writeFileSync(path.join(noirDir, file.replace('.template', '')), libTemplate);
  }
}

console.log('Setup complete! noir/lib/consts has been configured.');
