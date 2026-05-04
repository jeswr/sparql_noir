/**
 * Shared types for the W3C SPARQL conformance harness.
 */

import type { Feature } from './feature-classifier.js';

export type TestStatus =
  | 'passed' // The harness successfully exercised the test (transform-only or full).
  | 'failed' // The harness ran the test but produced an incorrect result / verify failure.
  | 'unsupported' // The transform rejected the query with a known feature gap.
  | 'errored' // Unexpected internal error.
  | 'skipped'; // Out-of-scope (e.g. CONSTRUCT, SERVICE, empty data).

export interface TestRecord {
  /** Test name from the manifest. */
  name: string;
  /** Test URI (mf:test entry IRI). */
  uri: string;
  /** Final status. */
  status: TestStatus;
  /** Free-form reason — populated for `failed` / `unsupported` / `errored` / `skipped`. */
  reason?: string;
  /** SPARQL feature classification. `null` only if the query failed to parse. */
  features: {
    headline: Feature;
    all: Feature[];
  } | null;
  /**
   * Stage at which a non-passing outcome occurred — useful for the
   * paper's "what fails where" breakdown.
   */
  stage?: 'parse' | 'transform' | 'compile' | 'sign' | 'prove' | 'verify' | 'compare';
  /** Wallclock duration in milliseconds. */
  durationMs: number;
}

export interface FeatureSummary {
  feature: Feature;
  total: number;
  passed: number;
  failed: number;
  unsupported: number;
  errored: number;
  skipped: number;
  passRate: number; // passed / total, in [0, 1].
}

export interface ConformanceReport {
  /** ISO timestamp when the run completed. */
  generatedAt: string;
  /** Manifest URL. */
  manifestUrl: string;
  /** Harness mode — `transform-only` is the default in CI. */
  mode: 'transform-only' | 'full';
  /** sparql_noir git commit SHA, if discoverable. */
  commitSha: string | null;
  /** Aggregate counters. */
  totals: {
    total: number;
    passed: number;
    failed: number;
    unsupported: number;
    errored: number;
    skipped: number;
    passRate: number;
  };
  /** Per-headline-feature aggregation — the §8.2 paper table. */
  byFeature: FeatureSummary[];
  /** One row per test. */
  tests: TestRecord[];
}
