#!/usr/bin/env npx tsx
/**
 * Round-6 prefix-3 end-to-end fixture
 * (`spec/prefix-tree-commitment.md` Sec.8.6).
 *
 * Exercises the full sign -> prove -> verify pipeline against a
 * dataset whose `?p ex:age ?age` prefix is genuinely absent (no
 * triple in the dataset has predicate `ex:age` for the bound
 * subject), so the prefix-3 NOT EXISTS bracketing must fire.
 *
 * Sub-test:
 *
 *   1. **NOT EXISTS over an inner-only object** -- the round-3
 *      ground-inner primitive cannot witness the absence (the
 *      `?age` slot is inner-only); the prefix-3 commitment must.
 *      Lowers to a `PrefixNonExistenceConstraint`.
 *
 * The companion OPTIONAL-collapse case (round-3 + prefix-3
 * EasyOptional) needs prover-side logic to populate the matched
 * arm's `bgp[matched_idx]` slot from the live OPTIONAL match (or a
 * placeholder real leaf when the optional doesn't match), which is
 * orthogonal to the gap-1/gap-2 runtime glue; tracked separately
 * (see `spec/prefix-tree-commitment.md` Sec.8.6 for the per-binding
 * matched/unmatched decision logic).
 *
 * Run via: `npx tsx test/run-prefix3-e2e.ts`. Requires `nargo` +
 * `wasm-pack` available locally. The script bypasses CI on machines
 * without those tools.
 */
import fs from 'fs';
import path from 'path';
import N3 from 'n3';
import { sign, prove, verify } from '../src/index.js';

const __dirname = new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = path.resolve(__dirname, '..');

interface SubTestResult {
  name: string;
  success: boolean;
  message?: string;
  durationMs: number;
}

const results: SubTestResult[] = [];

function log(msg: string): void {
  console.log(`[prefix3-e2e] ${msg}`);
}

async function runSubTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  log(`Running: ${name}`);
  try {
    await fn();
    const durationMs = Date.now() - start;
    log(`PASSED: ${name} (${(durationMs / 1000).toFixed(2)}s)`);
    results.push({ name, success: true, durationMs });
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = (err as Error).message || String(err);
    log(`FAILED: ${name}: ${message}`);
    results.push({ name, success: false, message, durationMs });
  }
}

/**
 * Build an in-memory N3 store with a dataset shaped to exercise
 * prefix-3 NOT EXISTS / OPTIONAL collapse:
 *
 *   - `ex:alice ex:knows ex:bob`
 *   - `ex:alice ex:knows ex:carol`
 *   - `ex:bob ex:age 30`        -- only `ex:bob` has an age triple
 *
 * Queries below select `?s` from `?s ex:knows ?p` and either
 * NOT EXISTS / OPTIONAL on `?p ex:age ?age`. For the binding where
 * `?p = ex:carol`, the `ex:carol`-prefix is absent in the prefix-3
 * tree (Lower / Middle / Upper depending on hash order), and the
 * proof must succeed via prefix-3 bracketing. For `?p = ex:bob`
 * the absent prefix is present in the dataset, so the constraint
 * fails and that binding is dropped.
 */
function buildDataset(): N3.Store {
  const { namedNode, literal, quad } = N3.DataFactory;
  const ex = (local: string) => namedNode(`http://example.org/${local}`);
  const xsd = 'http://www.w3.org/2001/XMLSchema#';

  const store = new N3.Store();
  store.addQuad(quad(ex('alice'), ex('knows'), ex('bob')));
  store.addQuad(quad(ex('alice'), ex('knows'), ex('carol')));
  store.addQuad(quad(ex('bob'), ex('age'), literal('30', namedNode(xsd + 'integer'))));
  return store;
}

async function main(): Promise<void> {
  await runSubTest('sign produces both round-3 and prefix-3 roots with separate signatures', async () => {
    const store = buildDataset();
    const signed = await sign(store);
    if (!signed.root) throw new Error('signed.root missing');
    if (!signed.rootPrefix3 || signed.rootPrefix3 === '0x0') {
      throw new Error(`expected non-zero rootPrefix3, got ${signed.rootPrefix3}`);
    }
    if (!signed.signature) throw new Error('signed.signature missing');
    if (!signed.signaturePrefix3) {
      throw new Error('signed.signaturePrefix3 missing -- prefix-3 root must be signed under the same key (gap 1)');
    }
    if (!signed.lowSentinelPath || !signed.highSentinelPath) {
      throw new Error('round-3 sentinel paths missing from signed data');
    }
    if (!signed.prefix3 || !signed.prefix3.lowSentinelPath || !signed.prefix3.highSentinelPath) {
      throw new Error('prefix-3 sentinel paths missing from signed data');
    }
    log(`  root_4         = ${signed.root.slice(0, 18)}...`);
    log(`  root_3sp_g     = ${signed.rootPrefix3.slice(0, 18)}...`);
    log(`  prefix3 leaves = ${signed.prefix3.prefixes.length} (deduplicated)`);
  });

  await runSubTest('prove + verify NOT EXISTS over prefix-3 absent object', async () => {
    const store = buildDataset();
    const signed = await sign(store);
    const query = `
      PREFIX ex: <http://example.org/>
      SELECT ?s WHERE {
        ?s ex:knows ?p .
        FILTER(NOT EXISTS { ?p ex:age ?age . })
      }
    `;
    const proofResult = await prove(query, signed);
    if (!proofResult.proofs || proofResult.proofs.length === 0) {
      throw new Error('no proofs were generated');
    }
    log(`  generated ${proofResult.proofs.length} proof(s)`);
    const verifyResult = await verify(proofResult);
    if (!verifyResult.success) {
      throw new Error(`verification failed: ${verifyResult.errors?.join(', ')}`);
    }
    log(`  verified ${proofResult.proofs.length} proof(s) end-to-end`);
  });

  // OPTIONAL-collapse case is tracked as an orthogonal follow-up --
  // the prover-side matched-arm slot population needs per-binding
  // matched / unmatched dispatch on top of the gap-2 substitution
  // glue. See `spec/prefix-tree-commitment.md` Sec.8.6.

  // Print summary.
  console.log('\n========================================');
  console.log('Prefix-3 end-to-end summary');
  console.log('========================================\n');
  for (const r of results) {
    const status = r.success ? 'PASS' : 'FAIL';
    console.log(`${status}  ${r.name} (${(r.durationMs / 1000).toFixed(2)}s)`);
    if (!r.success && r.message) {
      console.log(`     -> ${r.message}`);
    }
  }
  const passed = results.filter(r => r.success).length;
  console.log(`\nTotal: ${passed}/${results.length} sub-tests passed\n`);

  if (passed !== results.length) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
