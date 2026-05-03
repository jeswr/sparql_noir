/**
 * Verifier-side post-processing for SPARQL aggregates / ORDER BY / LIMIT
 * under the disclose-and-verify pattern (SPARQL_ROADMAP.md §8.6, Q6
 * decision 2026-05-03).
 *
 * The transform never emits in-circuit DISTINCT, sort, or count
 * primitives. Instead, the circuit discloses the underlying multiset
 * of source-variable bindings and tags `metadata.json` with the
 * aggregate kind / order-by direction / limit / offset. This module
 * applies those modifiers externally on the disclosed multiset.
 *
 * The principle is: information revealed in the disclosed output must
 * not be ZK-proven inside the circuit. The verifier checks revealed
 * properties directly. See the workspace memory note
 * `feedback_zkp_no_proof_of_revealed_properties.md`.
 *
 * ## Numeric precision
 *
 * SPARQL aggregate / ORDER BY arithmetic must not be routed through
 * JavaScript `Number` — `Number` is an IEEE 754 double, which loses
 * precision above 2^53 and for many decimals. The implementation here
 * dispatches on datatype:
 *
 * - `xsd:integer` and its derived integer types use `BigInt`.
 * - `xsd:decimal` / `xsd:double` / `xsd:float` (and any mixed numeric
 *   set) are handled via `decimal.js` with a precision wide enough to
 *   represent the full mantissa of `xsd:double` (40 significant
 *   digits — IEEE 754 binary64 has at most ~17 decimal digits, but we
 *   double that to absorb intermediate sums losslessly).
 *
 * The choice of library follows
 * `feedback_prefer_libraries.md`: `decimal.js` is the standard
 * arbitrary-precision decimal library on npm. We do not roll our own
 * scaled-integer arithmetic.
 */

import type { Literal, Term } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { Decimal } from 'decimal.js';

const { literal: dfLiteral, namedNode: dfNamedNode } = DataFactory;

// xsd:double has 17 significant decimal digits; 40 absorbs the worst-
// case rounding for sums of ~10^7 such values without truncation
// surprises in the tests. Scoped to a Decimal clone so we don't
// disturb global Decimal config the caller might rely on.
const Dec: typeof Decimal = Decimal.clone({ precision: 40 });
type Dec = InstanceType<typeof Dec>;

/** Kinds the transform emits — see `AggregateKind::metadata_tag` in Rust. */
export type AggregateKindTag =
  | 'count'
  | 'count_distinct'
  | 'count_solutions'
  | 'count_solutions_distinct'
  | 'sum'
  | 'sum_distinct'
  | 'min'
  | 'min_distinct'
  | 'max'
  | 'max_distinct'
  | 'avg'
  | 'avg_distinct';

export interface AggregateMetadata {
  kind: AggregateKindTag;
  /** The disclosed multiset variable; `null` for `COUNT(*)`. */
  source: string | null;
  /** Variable name the aggregate result is bound to in the projection. */
  output: string;
}

export interface OrderByMetadata {
  variable: string;
  direction: 'asc' | 'desc';
}

/** Subset of `metadata.json` consumed by `applyPostProcessing`. */
export interface PostProcessingMetadata {
  aggregates?: AggregateMetadata[];
  order_by?: OrderByMetadata[];
  orderBy?: OrderByMetadata[];
  limit?: number | null;
  offset?: number | null;
}

/** A single disclosed row: variable name -> RDF/JS term. */
export type DisclosedRow = Record<string, Term>;

/** A row returned after post-processing — aggregate columns are RDF terms. */
export type ResultRow = Record<string, Term>;

/**
 * Stable string key for an RDF term, suitable for grouping / DISTINCT.
 * Uses term-equality semantics: type + value + language tag + datatype.
 */
function termKey(t: Term | undefined): string {
  if (!t) return ' undef';
  switch (t.termType) {
    case 'NamedNode':
      return `nn|${t.value}`;
    case 'BlankNode':
      return `bn|${t.value}`;
    case 'Literal': {
      const lang = (t as { language?: string }).language ?? '';
      const dt = (t as { datatype?: { value: string } }).datatype?.value ?? '';
      return `lt|${t.value}|${lang}|${dt}`;
    }
    case 'Variable':
      return `vr|${t.value}`;
    default:
      return `??|${t.value}`;
  }
}

const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** xsd integer-derived datatypes — values fit in a BigInt without loss. */
const INTEGER_DATATYPES = new Set<string>([
  `${XSD}integer`,
  `${XSD}long`,
  `${XSD}int`,
  `${XSD}short`,
  `${XSD}byte`,
  `${XSD}nonNegativeInteger`,
  `${XSD}positiveInteger`,
  `${XSD}negativeInteger`,
  `${XSD}nonPositiveInteger`,
  `${XSD}unsignedLong`,
  `${XSD}unsignedInt`,
  `${XSD}unsignedShort`,
  `${XSD}unsignedByte`,
]);

/** Fractional / approximate numeric types — handled via decimal.js. */
const FRACTIONAL_DATATYPES = new Set<string>([
  `${XSD}decimal`,
  `${XSD}double`,
  `${XSD}float`,
]);

const NUMERIC_DATATYPES = new Set<string>([
  ...INTEGER_DATATYPES,
  ...FRACTIONAL_DATATYPES,
]);

function literalDatatype(t: Term): string | undefined {
  if (t.termType !== 'Literal') return undefined;
  return (t as Literal).datatype?.value;
}

function isNumericLiteral(t: Term): boolean {
  const dt = literalDatatype(t);
  return !!dt && NUMERIC_DATATYPES.has(dt);
}

function isIntegerLiteral(t: Term): boolean {
  const dt = literalDatatype(t);
  return !!dt && INTEGER_DATATYPES.has(dt);
}

/**
 * Compare two terms under SPARQL's ORDER BY ordering. This is a
 * deliberate simplification: numeric literals compare numerically
 * (via `decimal.js` — never via `Number`), other literals
 * lexicographically, IRIs lexicographically by their value. Real
 * SPARQL ordering (§15.1) has more nuance around language tags and
 * incompatible datatypes, but for round-2 the disclose-and-verify
 * pattern just needs a deterministic total order without precision
 * loss.
 */
function compareTerms(a: Term | undefined, b: Term | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;

  if (isNumericLiteral(a) && isNumericLiteral(b)) {
    // Both integers — BigInt is exact and faster than Decimal.
    if (isIntegerLiteral(a) && isIntegerLiteral(b)) {
      const ai = BigInt(a.value);
      const bi = BigInt(b.value);
      if (ai < bi) return -1;
      if (ai > bi) return 1;
      return 0;
    }
    // Mixed or fractional — decimal.js. `Decimal` handles `NaN` /
    // `Infinity` / `-Infinity` lexical forms directly so the .cmp()
    // result is well defined.
    const ad = new Dec(a.value);
    const bd = new Dec(b.value);
    return ad.cmp(bd);
  }

  if (a.value < b.value) return -1;
  if (a.value > b.value) return 1;
  return 0;
}

/**
 * Build a typed literal via the n3 DataFactory. Unlike the previous
 * inline cast, this returns a real RDF/JS term whose `equals()`
 * implementation matches the spec (term-identity comparison) — see
 * `feedback_sdk_object_interface.md` and the round-2 audit for context.
 */
function makeIntegerLiteral(n: bigint | number): Term {
  const v = typeof n === 'bigint' ? n.toString() : Math.trunc(n).toString();
  return dfLiteral(v, dfNamedNode(`${XSD}integer`));
}

function makeDecimalLiteral(d: InstanceType<typeof Dec> | number | bigint | string): Term {
  let v: string;
  if (d instanceof Dec) {
    v = d.toFixed();
  } else if (typeof d === 'bigint') {
    v = d.toString();
  } else if (typeof d === 'number') {
    // Should never happen on the hot path — every code path now
    // routes via Decimal. Keep the conversion as a safety net so
    // the function is total.
    v = new Dec(d).toFixed();
  } else {
    v = d;
  }
  return dfLiteral(v, dfNamedNode(`${XSD}decimal`));
}

function isDistinctKind(kind: AggregateKindTag): boolean {
  return kind === 'count_distinct'
    || kind === 'count_solutions_distinct'
    || kind === 'sum_distinct'
    || kind === 'min_distinct'
    || kind === 'max_distinct'
    || kind === 'avg_distinct';
}

function dedupeRows(rows: DisclosedRow[]): DisclosedRow[] {
  const seen = new Set<string>();
  const out: DisclosedRow[] = [];
  for (const row of rows) {
    const keys = Object.keys(row).sort();
    const key = keys.map((k) => `${k}=${termKey(row[k])}`).join('');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

function dedupeTerms(terms: Term[]): Term[] {
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const t of terms) {
    const k = termKey(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

function termsForAgg(rows: DisclosedRow[], source: string | null): Term[] {
  if (source === null) return [];
  return rows
    .map((r) => r[source])
    .filter((t): t is Term => t !== undefined);
}

/**
 * True iff every numeric literal in `terms` is an exact integer type.
 * If so, sums and averages can stay in the `BigInt` domain (avg goes
 * into Decimal at the division step only).
 */
function allIntegers(terms: Term[]): boolean {
  for (const t of terms) {
    if (!isIntegerLiteral(t)) return false;
  }
  return terms.length > 0;
}

function sumAsDecimal(terms: Term[]): InstanceType<typeof Dec> {
  let total = new Dec(0);
  for (const t of terms) {
    total = total.plus(new Dec(t.value));
  }
  return total;
}

function sumAsBigInt(terms: Term[]): bigint {
  let total = 0n;
  for (const t of terms) {
    total += BigInt(t.value);
  }
  return total;
}

function computeAggregate(
  agg: AggregateMetadata,
  rows: DisclosedRow[]
): Term {
  const distinct = isDistinctKind(agg.kind);

  // COUNT(*) variants count solutions, not source bindings.
  if (agg.kind === 'count_solutions' || agg.kind === 'count_solutions_distinct') {
    const considered = distinct ? dedupeRows(rows) : rows;
    return makeIntegerLiteral(BigInt(considered.length));
  }

  let terms = termsForAgg(rows, agg.source);
  if (distinct) terms = dedupeTerms(terms);

  switch (agg.kind) {
    case 'count':
    case 'count_distinct':
      return makeIntegerLiteral(BigInt(terms.length));
    case 'sum':
    case 'sum_distinct': {
      if (terms.length === 0) return makeIntegerLiteral(0n);
      // Stay in BigInt for pure-integer sums; otherwise Decimal.
      if (allIntegers(terms)) {
        return makeIntegerLiteral(sumAsBigInt(terms));
      }
      return makeDecimalLiteral(sumAsDecimal(terms));
    }
    case 'avg':
    case 'avg_distinct': {
      if (terms.length === 0) return makeIntegerLiteral(0n);
      // Average is always a decimal (per SPARQL §17.4.4.5).
      const total = allIntegers(terms)
        ? new Dec(sumAsBigInt(terms).toString())
        : sumAsDecimal(terms);
      const mean = total.div(new Dec(terms.length));
      return makeDecimalLiteral(mean);
    }
    case 'min':
    case 'min_distinct': {
      if (terms.length === 0) return makeIntegerLiteral(0n);
      return [...terms].sort(compareTerms)[0]!;
    }
    case 'max':
    case 'max_distinct': {
      if (terms.length === 0) return makeIntegerLiteral(0n);
      return [...terms].sort((a, b) => compareTerms(b, a))[0]!;
    }
    default:
      throw new Error(`Unsupported aggregate kind: ${agg.kind}`);
  }
}

function sortRows(
  rows: DisclosedRow[],
  keys: OrderByMetadata[]
): DisclosedRow[] {
  if (keys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const cmp = compareTerms(a[key.variable], b[key.variable]);
      if (cmp !== 0) {
        return key.direction === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

/**
 * Apply the SPARQL-side post-processing modifiers (aggregates,
 * ORDER BY, LIMIT, OFFSET) to a set of disclosed rows, externally to
 * the circuit. The disclosed rows must already be the output of a
 * successful proof verification.
 *
 * `LIMIT k` caps the **output** of post-processing — it does NOT cap
 * the disclosed multiset. This matches the SPARQL spec: the prover
 * may legitimately disclose more rows than `k` (e.g. when ORDER BY
 * picks the top-k from a larger set). The verifier cannot reject
 * such inputs without being told the *expected* size, which the
 * disclose-and-verify pattern intentionally does not commit to.
 *
 * @param metadata The `metadata.json` produced by the transform.
 * @param disclosedRows The rows extracted from successful proof
 *   verifications, keyed by variable name.
 * @returns The post-processed result rows.
 */
export function applyPostProcessing(
  metadata: PostProcessingMetadata,
  disclosedRows: DisclosedRow[]
): ResultRow[] {
  const aggregates = metadata.aggregates ?? [];
  const orderBy = metadata.orderBy ?? metadata.order_by ?? [];
  const limit = metadata.limit ?? null;
  const offset = metadata.offset ?? null;

  // Aggregates produce one result row containing every aggregate
  // column. ORDER BY / LIMIT / OFFSET on aggregate output is rare in
  // practice but is applied uniformly afterwards.
  let working: ResultRow[];
  if (aggregates.length > 0) {
    const aggRow: ResultRow = {};
    for (const agg of aggregates) {
      aggRow[agg.output] = computeAggregate(agg, disclosedRows);
    }
    working = [aggRow];
  } else {
    working = disclosedRows.slice();
  }

  working = sortRows(working, orderBy);

  if (offset !== null && offset > 0) {
    working = working.slice(offset);
  }
  if (limit !== null && working.length > limit) {
    working = working.slice(0, limit);
  }

  return working;
}
