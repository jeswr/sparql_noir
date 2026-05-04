/**
 * Tests for the verifier-side aggregate / ORDER BY / LIMIT post-
 * processing in `src/aggregates.ts`.
 *
 * Audit-driven (see `notes/research/pr-review-audit-2026-05-03.md`,
 * sparql_noir #39 row). Every fix item gets a regression test:
 *
 * 1. SUM / AVG / MIN / MAX / ORDER BY precision above 2^53.
 * 2. LIMIT does not reject disclosed multisets larger than the cap.
 * 4. Synthetic aggregate-result literals satisfy RDF/JS Term.equals.
 *
 * Items 3 (ORDER BY keys threaded into circuit_vars) and 5 (top-level
 * ORDER BY error propagation) live in the Rust transform — see
 * `transform/tests/snapshot.rs`.
 */

import type { Term } from '@rdfjs/types';
import { DataFactory } from 'n3';
import {
  applyPostProcessing,
  type AggregateMetadata,
  type DisclosedRow,
} from '../src/aggregates.js';

const { literal: lit, namedNode: nn } = DataFactory;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const xInt = nn(`${XSD}integer`);
const xDec = nn(`${XSD}decimal`);
const xDbl = nn(`${XSD}double`);

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

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

function group(name: string, fn: () => void): void {
  console.log(`\n# ${name}`);
  fn();
}

function row(o: Record<string, Term>): DisclosedRow {
  return o;
}

// --- Item 1: precision ------------------------------------------------------

group('SUM keeps full precision above 2^53 (item 1)', () => {
  // 2^53 = 9007199254740992; 2^53 + 1 cannot be represented as a Number.
  // Sum of 2^53 and 1 must equal 2^53 + 1, not 2^53.
  const big = '9007199254740992';
  const rows: DisclosedRow[] = [
    row({ x: lit(big, xInt) }),
    row({ x: lit('1', xInt) }),
  ];
  const agg: AggregateMetadata = { kind: 'sum', source: 'x', output: 'total' };
  const out = applyPostProcessing({ aggregates: [agg] }, rows);
  assertEqual(out.length, 1, 'one aggregate row');
  const total = out[0]!.total;
  assertEqual(total.value, '9007199254740993', 'integer sum stays exact');
  assertEqual(total.termType, 'Literal', 'result is a Literal');
  if (total.termType === 'Literal') {
    assertEqual(total.datatype.value, `${XSD}integer`, 'integer datatype preserved');
  }
});

group('SUM with very large BigInts (item 1)', () => {
  // 10^30 — far beyond any Number representation.
  const big1 = '1000000000000000000000000000000';
  const big2 = '2000000000000000000000000000000';
  const rows: DisclosedRow[] = [
    row({ x: lit(big1, xInt) }),
    row({ x: lit(big2, xInt) }),
  ];
  const out = applyPostProcessing(
    { aggregates: [{ kind: 'sum', source: 'x', output: 't' }] },
    rows
  );
  assertEqual(
    out[0]!.t.value,
    '3000000000000000000000000000000',
    '30-digit sum stays exact'
  );
});

group('AVG with decimals stays precise (item 1)', () => {
  // 0.1 + 0.2 in Number is 0.30000000000000004. With decimal.js it
  // stays 0.3 — and the average is 0.15.
  const rows: DisclosedRow[] = [
    row({ x: lit('0.1', xDec) }),
    row({ x: lit('0.2', xDec) }),
  ];
  const out = applyPostProcessing(
    { aggregates: [{ kind: 'avg', source: 'x', output: 'a' }] },
    rows
  );
  // Decimal.js returns "0.15" without the floating-point fuzz.
  assertEqual(out[0]!.a.value, '0.15', '(0.1 + 0.2) / 2 = 0.15 exactly');
  if (out[0]!.a.termType === 'Literal') {
    assertEqual(out[0]!.a.datatype.value, `${XSD}decimal`, 'avg returns xsd:decimal');
  }
});

group('SUM mixed integer + decimal (item 1)', () => {
  const rows: DisclosedRow[] = [
    row({ x: lit('1', xInt) }),
    row({ x: lit('0.5', xDec) }),
  ];
  const out = applyPostProcessing(
    { aggregates: [{ kind: 'sum', source: 'x', output: 't' }] },
    rows
  );
  assertEqual(out[0]!.t.value, '1.5', 'mixed integer/decimal sum is decimal');
  if (out[0]!.t.termType === 'Literal') {
    assertEqual(out[0]!.t.datatype.value, `${XSD}decimal`, 'mixed sum returns xsd:decimal');
  }
});

group('MIN / MAX precise comparison (item 1)', () => {
  // Two values that differ only beyond the Number precision boundary.
  const a = '9007199254740992';
  const b = '9007199254740993';
  const rows: DisclosedRow[] = [row({ x: lit(b, xInt) }), row({ x: lit(a, xInt) })];
  const min = applyPostProcessing(
    { aggregates: [{ kind: 'min', source: 'x', output: 'm' }] },
    rows
  );
  const max = applyPostProcessing(
    { aggregates: [{ kind: 'max', source: 'x', output: 'm' }] },
    rows
  );
  assertEqual(min[0]!.m.value, a, 'MIN uses BigInt comparison');
  assertEqual(max[0]!.m.value, b, 'MAX uses BigInt comparison');
});

group('ORDER BY uses precise comparison (item 1)', () => {
  const a = '9007199254740992';
  const b = '9007199254740993';
  const c = '9007199254740994';
  const rows: DisclosedRow[] = [
    row({ x: lit(c, xInt) }),
    row({ x: lit(a, xInt) }),
    row({ x: lit(b, xInt) }),
  ];
  const out = applyPostProcessing(
    { orderBy: [{ variable: 'x', direction: 'asc' }] },
    rows
  );
  assertEqual(out.length, 3, '3 rows out');
  assertEqual(out[0]!.x.value, a, 'order asc first');
  assertEqual(out[1]!.x.value, b, 'order asc second');
  assertEqual(out[2]!.x.value, c, 'order asc third');
});

group('AVG of doubles preserves precision (item 1)', () => {
  // Three doubles whose mean Number cannot represent exactly.
  const rows: DisclosedRow[] = [
    row({ x: lit('1.1', xDbl) }),
    row({ x: lit('2.2', xDbl) }),
    row({ x: lit('3.3', xDbl) }),
  ];
  const out = applyPostProcessing(
    { aggregates: [{ kind: 'avg', source: 'x', output: 'a' }] },
    rows
  );
  // Mean is exactly 2.2.
  assertEqual(out[0]!.a.value, '2.2', 'avg of {1.1, 2.2, 3.3} = 2.2');
});

// --- Item 2: LIMIT no longer rejects ---------------------------------------

group('LIMIT does not reject larger disclosed multiset (item 2)', () => {
  const rows: DisclosedRow[] = [
    row({ x: lit('1', xInt) }),
    row({ x: lit('2', xInt) }),
    row({ x: lit('3', xInt) }),
    row({ x: lit('4', xInt) }),
    row({ x: lit('5', xInt) }),
  ];
  // LIMIT 2 with 5 disclosed rows must succeed and yield 2 output rows.
  let out: ReturnType<typeof applyPostProcessing> | undefined;
  let err: unknown;
  try {
    out = applyPostProcessing({ limit: 2 }, rows);
  } catch (e) {
    err = e;
  }
  assert(err === undefined, 'LIMIT < disclosed.length must not throw');
  assertEqual(out?.length, 2, 'LIMIT caps output to 2 rows');
});

group('LIMIT + ORDER BY top-k (item 2)', () => {
  const rows: DisclosedRow[] = [
    row({ x: lit('30', xInt) }),
    row({ x: lit('10', xInt) }),
    row({ x: lit('20', xInt) }),
  ];
  const out = applyPostProcessing(
    {
      orderBy: [{ variable: 'x', direction: 'asc' }],
      limit: 2,
    },
    rows
  );
  assertEqual(out.length, 2, 'top-2 returned');
  assertEqual(out[0]!.x.value, '10', 'sorted top-1');
  assertEqual(out[1]!.x.value, '20', 'sorted top-2');
});

// --- Item 4: Term.equals contract ------------------------------------------

group('Synthetic aggregate literals satisfy Term.equals (item 4)', () => {
  // RDF/JS Term.equals: same termType, same value (and for Literal:
  // same language, same datatype.value). Synthetic aggregate results
  // built via DataFactory must round-trip through `equals`.
  const rows: DisclosedRow[] = [
    row({ x: lit('5', xInt) }),
    row({ x: lit('7', xInt) }),
  ];
  const out = applyPostProcessing(
    { aggregates: [{ kind: 'sum', source: 'x', output: 't' }] },
    rows
  );
  const total = out[0]!.t;
  const expected = lit('12', xInt);
  assert(
    typeof total.equals === 'function',
    'aggregate result has a callable .equals()'
  );
  assert(total.equals(expected), 'aggregate result equals an independently-built literal of the same value/type');
  // And the asymmetric direction.
  assert(expected.equals(total), 'equals is symmetric across DataFactory builds');
  // Negative case: different value must NOT be equal.
  assert(!total.equals(lit('13', xInt)), 'different value -> not equal');
  // Negative case: different datatype must NOT be equal.
  assert(!total.equals(lit('12', xDec)), 'different datatype -> not equal');
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
