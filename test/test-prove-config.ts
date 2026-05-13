/**
 * Regression tests for `prove()` config handling -- issue
 * `jeswr/sparql_noir#44`.
 *
 * Soundness flag: `prove()` accepts a `Partial<Config>` argument but
 * only threads `config.signature` into the circuit dispatch
 * (`getNoirLibFilesEncoded` / `createInMemoryFileManager`). The
 * remaining fields (stringHash, fieldHash, merkleDepth, stringLenMax,
 * stringHashOutputSize) are baked into the pre-bundled
 * `consts/Nargo.toml`. Before this fix, supplying a non-default value
 * for one of those fields silently produced a circuit that mismatched
 * the verifier's expected commitment shape. After the fix, `prove()`
 * loudly rejects any non-default value for a field it cannot honour
 * via the bundle.
 *
 * These tests do NOT exercise the full proving pipeline -- they only
 * pin the API-boundary validation (the cheap, deterministic part).
 * The full prove pipeline is exercised elsewhere
 * (`test/run-prefix3-e2e.ts`, conformance suite).
 *
 * Run via: `npx tsx test/test-prove-config.ts`.
 */

import { prove, defaultConfig } from '../src/index.js';
import type { SignedData } from '../src/index.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error(`  FAIL: ${msg}`);
  }
}

function group(name: string, fn: () => void | Promise<void>): Promise<void> {
  console.log(`\n# ${name}`);
  return Promise.resolve(fn());
}

/**
 * Minimal `SignedData`-shaped placeholder. The body of `prove()` will
 * try to consume this if the config guard *fails to fire* -- the
 * tests rely on the guard short-circuiting before any of these fields
 * are actually read. Including just enough to keep TypeScript happy.
 */
const dummySignedData = {
  triples: [],
  paths: [],
  direction: [],
  root: '0x0',
  signature: null,
  pubKey: null,
  nquads: [],
} as unknown as SignedData;

const QUERY = 'SELECT ?o WHERE { ?s <http://example.org/p> ?o }';

async function expectRejection(
  label: string,
  configOverride: Record<string, unknown>,
  expectedMessageFragment: string,
): Promise<void> {
  let caught: unknown;
  try {
    await prove(QUERY, dummySignedData, configOverride as Parameters<typeof prove>[2]);
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Error, `${label}: prove() rejected`);
  if (caught instanceof Error) {
    assert(
      caught.message.includes(expectedMessageFragment),
      `${label}: error message references "${expectedMessageFragment}" (got: ${caught.message})`,
    );
    assert(
      caught.message.includes('issue #44'),
      `${label}: error message references issue #44 (got: ${caught.message})`,
    );
  }
}

await group('prove() rejects non-default `merkleDepth` (issue #44)', async () => {
  await expectRejection(
    'merkleDepth: 13',
    { merkleDepth: 13 },
    'merkleDepth',
  );
});

await group('prove() rejects non-default `stringHash` (issue #44)', async () => {
  await expectRejection(
    'stringHash: blake3',
    { stringHash: 'blake3' },
    'stringHash',
  );
});

await group('prove() rejects non-default `fieldHash` (issue #44)', async () => {
  await expectRejection(
    'fieldHash: poseidon',
    { fieldHash: 'poseidon' },
    'fieldHash',
  );
});

await group('prove() rejects non-default `stringHashOutputSize` (issue #44)', async () => {
  await expectRejection(
    'stringHashOutputSize: 48',
    { stringHashOutputSize: 48 },
    'stringHashOutputSize',
  );
});

await group('prove() rejects non-default `stringLenMax` (issue #44)', async () => {
  // stringLenMax sits on the internal config shape; the API guard
  // catches it dynamically.
  await expectRejection(
    'stringLenMax: 128',
    { stringLenMax: 128 },
    'stringLenMax',
  );
});

await group('prove() accepts a non-default `signature` (threaded through bundle)', async () => {
  // `signature` IS honoured at circuit dispatch (see
  // `getNoirLibFilesEncoded({ signature })`); the guard must NOT
  // reject it. We can't run the full prove pipeline here without a
  // signed dataset, so we assert that the guard short-circuits past
  // this field by pinning a different downstream error than the
  // config-mismatch one.
  let caught: unknown;
  try {
    await prove(QUERY, dummySignedData, { signature: 'schnorr' });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Error, 'prove() with non-default signature did throw (downstream, not at config guard)');
  if (caught instanceof Error) {
    assert(
      !caught.message.includes('issue #44'),
      `prove() with non-default signature did NOT trip the config guard (got: ${caught.message})`,
    );
  }
});

await group('prove() accepts the default config', async () => {
  // Passing the explicit default should also bypass the guard.
  let caught: unknown;
  try {
    await prove(QUERY, dummySignedData, {
      stringHash: defaultConfig.stringHash,
      fieldHash: defaultConfig.fieldHash,
      merkleDepth: defaultConfig.merkleDepth,
      stringHashOutputSize: defaultConfig.stringHashOutputSize,
    });
  } catch (err) {
    caught = err;
  }
  // Must NOT trip the config guard. May trip a downstream error
  // (dummySignedData has no quads).
  if (caught instanceof Error) {
    assert(
      !caught.message.includes('issue #44'),
      `prove() with explicit default config did NOT trip the config guard (got: ${caught.message})`,
    );
  } else {
    assert(true, 'prove() with explicit default config did not throw at the config guard');
  }
});

await group('prove() with no config argument is unchanged', async () => {
  // Backward-compat: omitting config must continue to work.
  let caught: unknown;
  try {
    await prove(QUERY, dummySignedData);
  } catch (err) {
    caught = err;
  }
  if (caught instanceof Error) {
    assert(
      !caught.message.includes('issue #44'),
      `prove() with no config did NOT trip the config guard (got: ${caught.message})`,
    );
  } else {
    assert(true, 'prove() with no config did not throw at the config guard');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
