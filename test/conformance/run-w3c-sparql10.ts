#!/usr/bin/env node
/**
 * W3C SPARQL 1.0 conformance harness for sparql_noir (transform-only).
 *
 * For each test in the W3C SPARQL 1.0 evaluation manifest:
 *  1. Classify the query by SPARQL feature (BGP / Filter / Optional / ...).
 *  2. Attempt to lower it through the transform layer.
 *  3. Record an outcome row: passed / failed / unsupported / errored / skipped.
 *
 * Emits a JSON report to `test/conformance/w3c-sparql10-report.json`
 * (path overridable with --out=<path>) and prints a markdown summary
 * to stdout. The summary is what the paper §8.2 table will cite.
 *
 * This is the carved transform-only mode used by CI; the full
 * prove/verify pipeline is tracked separately (see the §8.2 hardening
 * tracker in the workspace TODOs) and not exposed here.
 *
 * Usage:
 *   npx tsx test/conformance/run-w3c-sparql10.ts                 # transform-only
 *   npx tsx test/conformance/run-w3c-sparql10.ts --limit=20      # bootstrap subset
 *   npx tsx test/conformance/run-w3c-sparql10.ts --filter=bgp    # regex by name/uri
 *   npx tsx test/conformance/run-w3c-sparql10.ts --concurrency=8 # parallel workers
 *   npx tsx test/conformance/run-w3c-sparql10.ts --threshold=0.4 # exit non-zero if pass-rate < 0.4
 *
 * CI-friendly defaults: threshold=0 (never gate), JSON report uploaded
 * as artefact for paper §8.2.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Writer, Parser, type Quad } from 'n3';

import { classifyQuery, type Feature } from './feature-classifier.js';
import type {
  ConformanceReport,
  FeatureSummary,
  TestRecord,
  TestStatus,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sparqlNoirRoot = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// CLI parsing — minimal, no commander dep so the harness stays standalone.
// ---------------------------------------------------------------------------

interface CliOptions {
  limit: number | null;
  filter: RegExp | null;
  concurrency: number;
  manifestUrl: string;
  outPath: string;
  threshold: number;
  noCacheManifest: boolean;
  printJson: boolean;
}

function parseCli(argv: string[]): CliOptions {
  const has = (flag: string): boolean => argv.includes(flag);
  const value = (flag: string): string | null => {
    const v = argv.find((a) => a.startsWith(`${flag}=`));
    return v ? v.slice(flag.length + 1) : null;
  };

  if (has('--help') || has('-h')) {
    // eslint-disable-next-line no-console
    console.log(`
W3C SPARQL 1.0 conformance harness (transform-only)

Options:
  --limit=N               Run only the first N tests after filtering.
  --filter=PATTERN        Regex filter on test name or URI (case-insensitive).
  --concurrency=N         Parallel test workers (default: 4).
  --manifest=URL          Override manifest URL (default: W3C SPARQL 1.0).
  --out=PATH              Output JSON report path (default: w3c-sparql10-report.json).
  --threshold=FLOAT       Minimum pass-rate; exits 1 if below (default: 0 — never gate).
  --no-cache-manifest     Re-fetch the manifest from network.
  --print-json            Echo the JSON report to stdout (for piping).
  -h, --help              Show this help.
`);
    process.exit(0);
  }

  return {
    limit: value('--limit') ? Number.parseInt(value('--limit')!, 10) : null,
    filter: value('--filter') ? new RegExp(value('--filter')!, 'i') : null,
    concurrency: value('--concurrency')
      ? Math.max(1, Number.parseInt(value('--concurrency')!, 10))
      : 4,
    manifestUrl:
      value('--manifest') ??
      'https://w3c.github.io/rdf-tests/sparql/sparql10/manifest.ttl',
    outPath:
      value('--out') ??
      path.join(__dirname, 'w3c-sparql10-report.json'),
    threshold: value('--threshold') ? Number.parseFloat(value('--threshold')!) : 0,
    noCacheManifest: has('--no-cache-manifest'),
    printJson: has('--print-json'),
  };
}

// ---------------------------------------------------------------------------
// Manifest loading — uses a separate cache directory from ts.js's legacy
// runner. The harness needs richer expected-result info (type + value)
// than ts.js stores (`queryResultValue` only); a shared cache path
// would silently corrupt either runner depending on which wrote last.
// Versioned path keeps the two runners independent.
// ---------------------------------------------------------------------------

interface CachedTestEntry {
  name: string;
  uri: string;
  types: string[];
  approval: string;
  queryString: string;
  baseIRI: string;
  queryDataSerialized: string;
  queryResult: { type?: string; value?: unknown } | null;
}

interface NormalisedTest {
  name: string;
  uri: string;
  types: string[];
  approval: string;
  queryString: string;
  baseIRI: string;
  queryData: Quad[];
  queryResult: { type?: string; value?: unknown } | null;
}

const manifestCacheDir = path.join(
  sparqlNoirRoot,
  'temp',
  'conformance-manifest-cache-v1',
);

function manifestCacheKey(manifestUrl: string): string {
  const hash = crypto.createHash('md5').update(manifestUrl).digest('hex');
  return `manifest-${hash}.json`;
}

function loadCachedManifest(manifestUrl: string): CachedTestEntry[] | null {
  const cachePath = path.join(manifestCacheDir, manifestCacheKey(manifestUrl));
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as CachedTestEntry[];
  } catch {
    return null;
  }
}

function saveCachedManifest(manifestUrl: string, entries: CachedTestEntry[]): void {
  fs.mkdirSync(manifestCacheDir, { recursive: true });
  const cachePath = path.join(manifestCacheDir, manifestCacheKey(manifestUrl));
  fs.writeFileSync(cachePath, JSON.stringify(entries));
}

async function fetchManifest(manifestUrl: string): Promise<CachedTestEntry[]> {
  // Dynamic import so the harness can be loaded for type checking without
  // the dep being installed.
  const { ManifestLoader } = await import('rdf-test-suite');
  const loader = new ManifestLoader();
  const manifest = await loader.from(manifestUrl);
  const writer = new Writer({ format: 'Turtle' });
  const subEntries = (manifest.subManifests ?? []).flatMap(
    (m) => m.testEntries ?? [],
  );
  const ownEntries = manifest.testEntries ?? [];
  const allEntries = [...subEntries, ...ownEntries];
  return allEntries.map((test) => {
    const t = test as unknown as {
      name: string;
      uri: string;
      types: string[];
      approval: string;
      queryString?: string;
      baseIRI?: string;
      queryData?: unknown;
      queryResult?: { type?: string; value?: unknown };
    };
    return {
      name: t.name,
      uri: t.uri,
      types: t.types,
      approval: t.approval,
      queryString: t.queryString ?? '',
      baseIRI: t.baseIRI ?? '',
      queryDataSerialized: writer.quadsToString(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (t.queryData ?? []) as any,
      ),
      queryResult: t.queryResult
        ? {
            ...(t.queryResult.type !== undefined ? { type: t.queryResult.type } : {}),
            ...(t.queryResult.value !== undefined ? { value: t.queryResult.value } : {}),
          }
        : null,
    };
  });
}

async function loadManifest(
  manifestUrl: string,
  noCache: boolean,
): Promise<NormalisedTest[]> {
  let cached = noCache ? null : loadCachedManifest(manifestUrl);
  if (!cached) {
    cached = await fetchManifest(manifestUrl);
    saveCachedManifest(manifestUrl, cached);
  }
  const parser = new Parser();
  return cached.map((entry) => {
    let queryData: Quad[] = [];
    try {
      queryData = parser.parse(entry.queryDataSerialized || '') as Quad[];
    } catch {
      queryData = [];
    }
    return {
      name: entry.name,
      uri: entry.uri,
      types: entry.types,
      approval: entry.approval,
      queryString: entry.queryString,
      baseIRI: entry.baseIRI,
      queryData,
      queryResult: entry.queryResult,
    };
  });
}

// ---------------------------------------------------------------------------
// Transform module loader — gracefully degrades if WASM artefacts missing.
// ---------------------------------------------------------------------------

interface TransformBindings {
  transform: (queryString: string) => string;
  transform_with_options?: (queryString: string, skipSigning: boolean) => string;
}

let cachedTransform: TransformBindings | null = null;
let transformLoadError: string | null = null;

async function loadTransform(): Promise<TransformBindings | null> {
  if (cachedTransform) return cachedTransform;
  if (transformLoadError) return null;
  const wasmPath = path.join(sparqlNoirRoot, 'transform', 'pkg', 'transform.cjs');
  if (!fs.existsSync(wasmPath)) {
    transformLoadError = `Transform WASM bundle not found at ${wasmPath}. Run \`npm run build:wasm\` first.`;
    return null;
  }
  try {
    const { createRequire } = await import('node:module');
    const require_ = createRequire(import.meta.url);
    const mod = require_(wasmPath) as TransformBindings;
    cachedTransform = mod;
    return mod;
  } catch (err) {
    transformLoadError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test filtering — only QueryEvaluationTest entries with non-empty data
// and an approved status are exercised. SyntaxTest / NegativeSyntax /
// CSV-result tests are out-of-scope for §8.2.
// ---------------------------------------------------------------------------

const QUERY_EVALUATION_TYPE =
  'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#QueryEvaluationTest';
const APPROVED =
  'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#Approved';

interface CandidateTest {
  test: NormalisedTest;
  /** Pre-classification result, computed once. */
  classification: ReturnType<typeof classifyQuery>;
}

function selectCandidates(
  tests: NormalisedTest[],
  filter: RegExp | null,
): CandidateTest[] {
  const out: CandidateTest[] = [];
  for (const t of tests) {
    if (!t.types.includes(QUERY_EVALUATION_TYPE)) continue;
    if (t.approval !== APPROVED) continue;
    if (filter && !filter.test(t.name) && !filter.test(t.uri)) continue;
    const cls = classifyQuery(t.queryString, t.baseIRI || undefined);
    out.push({ test: t, classification: cls });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-test execution.
// ---------------------------------------------------------------------------

/** Heuristic: identify "this is unsupported by design" transform errors so
 * we can bucket them as `unsupported` rather than `failed`.
 *
 * Patterns are derived from the actual error strings emitted by
 * `transform/src/lib.rs`; cross-referenced against `SPARQL_ROADMAP.md` §3
 * (Hard / OOS feasibility column) and `SPARQL_COVERAGE.md`.
 */
const UNSUPPORTED_ERROR_PATTERNS: RegExp[] = [
  /unsupported/i,
  /not (yet )?implemented/i,
  /not (yet )?supported/i,
  /cannot convert expression to term/i, // arithmetic / function call in expression position
  /cannot handle/i,
  /aggregat/i,
  /CONSTRUCT/i,
  /DESCRIBE/i,
  /SERVICE/i,
  /MINUS/i, // Listed in SPARQL_ROADMAP §3 as Hard / out of bootstrap scope.
  /VALUES/i,
  /GROUP[_ ]BY/i,
  /REGEX/i,
  /NaN|INF/i,
  /(?:^|\W)BIND(?:\W|$)/i,
  /xsd:[a-z]+\s*\(/i, // XSD cast functions
];

function classifyTransformError(message: string): TestStatus {
  for (const re of UNSUPPORTED_ERROR_PATTERNS) {
    if (re.test(message)) return 'unsupported';
  }
  return 'failed';
}

async function runOneTest(
  candidate: CandidateTest,
  transform: TransformBindings | null,
): Promise<TestRecord> {
  const { test, classification } = candidate;
  const startedAt = Date.now();

  const baseRecord: TestRecord = {
    name: test.name,
    uri: test.uri,
    status: 'errored',
    features: classification
      ? { headline: classification.headline, all: classification.all }
      : null,
    durationMs: 0,
  };

  // 1. Skip CONSTRUCT / DESCRIBE / SERVICE outright — out of §8.2 scope.
  if (classification) {
    if (
      classification.all.includes('Construct') ||
      classification.all.includes('Describe') ||
      classification.all.includes('Service')
    ) {
      return {
        ...baseRecord,
        status: 'skipped',
        reason: `Out of scope: ${classification.headline}`,
        stage: 'parse',
        durationMs: Date.now() - startedAt,
      };
    }
  } else {
    return {
      ...baseRecord,
      status: 'errored',
      reason: 'Could not parse query into algebra',
      stage: 'parse',
      durationMs: Date.now() - startedAt,
    };
  }

  // 2. Skip tests with empty data — these typically check empty-result
  // semantics that need separate witness-construction logic and are
  // tracked under §6.4 honest map, not §8.2.
  if (test.queryData.length === 0) {
    return {
      ...baseRecord,
      status: 'skipped',
      reason: 'Test has empty input data',
      stage: 'parse',
      durationMs: Date.now() - startedAt,
    };
  }

  // 3. Transform → Noir.
  if (!transform) {
    return {
      ...baseRecord,
      status: 'errored',
      reason: transformLoadError ?? 'Transform module unavailable',
      stage: 'transform',
      durationMs: Date.now() - startedAt,
    };
  }

  let transformResultJson: string;
  try {
    transformResultJson = transform.transform_with_options
      ? transform.transform_with_options(test.queryString, true)
      : transform.transform(test.queryString);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...baseRecord,
      status: classifyTransformError(message),
      reason: `Transform threw: ${message}`,
      stage: 'transform',
      durationMs: Date.now() - startedAt,
    };
  }

  let parsed: { error?: string; sparql_nr?: string; main_nr?: string };
  try {
    parsed = JSON.parse(transformResultJson) as typeof parsed;
  } catch (err) {
    return {
      ...baseRecord,
      status: 'errored',
      reason: `Could not parse transform output: ${
        err instanceof Error ? err.message : String(err)
      }`,
      stage: 'transform',
      durationMs: Date.now() - startedAt,
    };
  }

  if (parsed.error) {
    return {
      ...baseRecord,
      status: classifyTransformError(parsed.error),
      reason: `Transform rejected: ${parsed.error}`,
      stage: 'transform',
      durationMs: Date.now() - startedAt,
    };
  }

  if (!parsed.sparql_nr) {
    return {
      ...baseRecord,
      status: 'failed',
      reason: 'Transform produced no sparql.nr',
      stage: 'transform',
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    ...baseRecord,
    status: 'passed',
    stage: 'transform',
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Concurrency runner — same shape as ts.js's runTestsWithConcurrency.
// ---------------------------------------------------------------------------

async function runWithConcurrency(
  candidates: CandidateTest[],
  concurrency: number,
  transform: TransformBindings | null,
): Promise<TestRecord[]> {
  const results: TestRecord[] = new Array(candidates.length);
  let nextIndex = 0;
  let completed = 0;
  const total = candidates.length;

  async function worker(): Promise<void> {
    while (nextIndex < total) {
      const idx = nextIndex++;
      const candidate = candidates[idx]!;
      const result = await runOneTest(candidate, transform);
      results[idx] = result;
      completed++;
      const symbol =
        result.status === 'passed'
          ? 'PASS'
          : result.status === 'unsupported'
            ? 'UNSUP'
            : result.status === 'skipped'
              ? 'SKIP'
              : result.status === 'failed'
                ? 'FAIL'
                : 'ERR ';
      // eslint-disable-next-line no-console
      console.log(
        `[${completed.toString().padStart(3)}/${total}] ${symbol} ${
          candidate.test.name
        }${result.reason ? ` — ${result.reason}` : ''}`,
      );
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, total) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Aggregation + report rendering.
// ---------------------------------------------------------------------------

function aggregate(records: TestRecord[]): {
  totals: ConformanceReport['totals'];
  byFeature: FeatureSummary[];
} {
  const totals = {
    total: records.length,
    passed: 0,
    failed: 0,
    unsupported: 0,
    errored: 0,
    skipped: 0,
    passRate: 0,
  };
  const featureMap = new Map<Feature, FeatureSummary>();
  const ensure = (f: Feature): FeatureSummary => {
    let s = featureMap.get(f);
    if (!s) {
      s = {
        feature: f,
        total: 0,
        passed: 0,
        failed: 0,
        unsupported: 0,
        errored: 0,
        skipped: 0,
        passRate: 0,
      };
      featureMap.set(f, s);
    }
    return s;
  };

  for (const r of records) {
    totals[r.status]++;
    if (r.features) {
      const s = ensure(r.features.headline);
      s.total++;
      s[r.status]++;
    }
  }

  totals.passRate = totals.total > 0 ? totals.passed / totals.total : 0;
  const byFeature = [...featureMap.values()].map((s) => ({
    ...s,
    passRate: s.total > 0 ? s.passed / s.total : 0,
  }));
  byFeature.sort((a, b) => b.total - a.total);
  return { totals, byFeature };
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function renderMarkdown(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`# W3C SPARQL 1.0 conformance — ${report.mode}`);
  lines.push('');
  lines.push(`- **Generated:** ${report.generatedAt}`);
  lines.push(`- **Manifest:** \`${report.manifestUrl}\``);
  if (report.commitSha) lines.push(`- **Commit:** \`${report.commitSha}\``);
  lines.push('');
  const t = report.totals;
  lines.push(
    `**${t.passed}/${t.total} passed (${pct(t.passRate)})** — ` +
      `${t.failed} failed, ${t.unsupported} unsupported, ` +
      `${t.errored} errored, ${t.skipped} skipped.`,
  );
  lines.push('');
  lines.push('## Per-feature pass-rate');
  lines.push('');
  lines.push('| Feature | Total | Passed | Failed | Unsupported | Errored | Skipped | Pass-rate |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of report.byFeature) {
    lines.push(
      `| ${s.feature} | ${s.total} | ${s.passed} | ${s.failed} | ${s.unsupported} | ${s.errored} | ${s.skipped} | ${pct(s.passRate)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function tryReadCommitSha(): string | null {
  // Use execFileSync with a fixed argv to avoid any shell interpolation;
  // sparqlNoirRoot is a derived path, not user-controlled, but the policy
  // is "no execSync with interpolated strings anywhere in this harness".
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sparqlNoirRoot,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(
    `Loading manifest: ${opts.manifestUrl} (mode=transform-only, concurrency=${opts.concurrency})`,
  );
  const tests = await loadManifest(opts.manifestUrl, opts.noCacheManifest);
  // eslint-disable-next-line no-console
  console.log(`Loaded ${tests.length} entries from manifest.`);

  let candidates = selectCandidates(tests, opts.filter);
  if (opts.limit !== null) candidates = candidates.slice(0, opts.limit);
  // eslint-disable-next-line no-console
  console.log(`Running ${candidates.length} candidate tests…`);

  const transform = await loadTransform();
  if (!transform) {
    // eslint-disable-next-line no-console
    console.warn(
      `Warning: ${transformLoadError ?? 'transform module unavailable'} — every test will record an "errored" outcome.`,
    );
  }

  const records = await runWithConcurrency(
    candidates,
    opts.concurrency,
    transform,
  );

  const { totals, byFeature } = aggregate(records);
  const report: ConformanceReport = {
    generatedAt: new Date().toISOString(),
    manifestUrl: opts.manifestUrl,
    mode: 'transform-only',
    commitSha: tryReadCommitSha(),
    totals,
    byFeature,
    tests: records,
  };

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, JSON.stringify(report, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nReport written to ${opts.outPath}\n`);

  const md = renderMarkdown(report);
  // eslint-disable-next-line no-console
  console.log(md);

  // GitHub Actions step summary, if available.
  if (process.env['GITHUB_STEP_SUMMARY']) {
    fs.appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `${md}\n`);
  }

  if (opts.printJson) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
  }

  if (opts.threshold > 0 && totals.passRate < opts.threshold) {
    // eslint-disable-next-line no-console
    console.error(
      `Pass-rate ${pct(totals.passRate)} below threshold ${pct(opts.threshold)} — failing.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(2);
});
