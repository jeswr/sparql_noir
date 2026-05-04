/**
 * Round-6 prefix-3 prover-side input builder
 * (`spec/prefix-tree-commitment.md` Sec.8.6).
 *
 * `prove.ts` calls into this module when the circuit's metadata
 * contains a non-empty `prefixNotExists` array (or a prefix-3
 * `easyOptionals` entry). The module substitutes the constraint's
 * `absent_terms` against the live binding, computes the absent prefix
 * hash via the same `hash3_sp_g(s, p, g)` primitive the circuit uses,
 * locates the bracketing prefix-3 leaves, and returns the
 * `bgp_prefix3` / `low_sentinel_3` / `high_sentinel_3` /
 * `boundary_cases_prefix3` inputs the generated `main.nr` expects.
 *
 * The algorithm has three phases:
 *
 *   1. **Substitute.** Each `absentTerms[j]` is one of `variable`
 *      (resolve from binding), `static` (encoded constant), or
 *      `input` (read `bgp[p].terms[j]` from the live triple at
 *      pattern index `p`).
 *
 *   2. **Compute absent hash.** Call `runJson` once per query to
 *      evaluate `hash3_sp_g(s, p, g)` for every constraint. The same
 *      Pedersen primitive that the circuit uses, so the comparison
 *      is exact.
 *
 *   3. **Bracket + dispatch.** Sort the prefix-3 tree's real leaves
 *      ascending by hash, then for each absent hash either find the
 *      adjacent bracket pair (Middle), or fall to the Lower / Upper
 *      sentinel arm. The boundary case selects which
 *      `verify_non_membership_prefix3_*_no_inclusion` primitive
 *      fires.
 *
 * Invariants:
 * - The prefix-3 tree's leaves are deduplicated at sign time, so the
 *   absent hash is either equal to one real leaf (constraint fails:
 *   the prefix is present) or strictly between two consecutive
 *   sorted leaves / sentinels.
 * - `bgp_prefix3` is a fixed-length array whose layout (which slot
 *   indexes which constraint's left / right bracket) is dictated by
 *   `metadata.bgp_prefix3_length` and the per-constraint
 *   `bracketLeftIdx` / `bracketRightIdx`.
 * - In the Lower case the left bracket slot is a "filler" -- the
 *   circuit ignores `bgp_prefix3[left]` for that constraint -- but
 *   the slot still has to be inclusion-checked, so we stuff in a
 *   real prefix leaf (the smallest one). Same for Upper / right.
 */
import type { SignedData, PrefixTree3Data } from './sign.js';
import { runJson } from '../encode.js';

/** Substituted absent terms in canonical `[s, p, g]` order (as Field strings). */
export interface PrefixAbsence {
  /** `[s_enc, p_enc, g_enc]` -- the three encoded fixed-position fields. */
  fixedTerms: [string, string, string];
  /** Hash output `hash3_sp_g(fixedTerms)` as a `0x`-prefixed hex string. */
  absentHash: string;
  /** Left bracket slot index in `bgp_prefix3`. */
  bracketLeftIdx: number;
  /** Right bracket slot index in `bgp_prefix3`. */
  bracketRightIdx: number;
}

/** Description of one constraint as it appears in `metadata.prefixNotExists`. */
export interface PrefixNotExistsMeta {
  prefixKind: string;
  bracketLeftIdx: number;
  bracketRightIdx: number;
  absentTerms: AbsentTermDescriptor[];
  freePosition: number;
  fixedPositions: number[];
}

/** The three flavours of `absent_terms[j]` (mirrors the Rust `Term` enum). */
export type AbsentTermDescriptor =
  | { kind: 'variable'; name: string }
  | { kind: 'input'; patternIdx: number; position: number }
  | {
      kind: 'static';
      term: {
        termType: string;
        value?: string;
        language?: string;
        datatype?: { termType: string; value: string };
      };
    };

/** PrefixTriple3 slot value the circuit expects. */
export interface PrefixTriple3Input {
  terms: [string, string, string];
  path: string[];
  directions: boolean[];
}

/** SentinelLeaf input shape (shared with round-3 sentinels). */
export interface SentinelLeafInput {
  path: string[];
  directions: boolean[];
}

/** Output of {@link buildPrefix3Inputs}. */
export interface Prefix3Inputs {
  bgp_prefix3: PrefixTriple3Input[];
  low_sentinel_3: SentinelLeafInput;
  high_sentinel_3: SentinelLeafInput;
  boundary_cases_prefix3: string[];
}

/**
 * Reconstruct the sorted-tree index of an input prefix from its
 * direction bits. Mirrors `reconstruct_index` in
 * `noir/lib/utils/src/lib.nr` (low-bit first).
 */
function reconstructSortedIndex(directions: ReadonlyArray<boolean | number>): number {
  let idx = 0;
  let bit = 1;
  for (const d of directions) {
    if (d === true || d === 1) {
      idx += bit;
    }
    bit *= 2;
  }
  return idx;
}

/**
 * Decimal-to-hex BigInt parser that copes with the prove-time
 * encoded-term strings. Accepts `0x`-prefixed hex, plain decimal
 * digits, or BigInt-shape strings.
 */
function parseFieldString(s: string): bigint {
  const trimmed = s.trim();
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    return BigInt(trimmed);
  }
  return BigInt(trimmed);
}

/** Big-endian hex of a Field element, `0x`-prefixed. */
function fieldToHex(value: bigint): string {
  return '0x' + value.toString(16);
}

/**
 * Build the `bgp_prefix3` / sentinel / boundary-case inputs for a
 * single binding's prefix-3 dispatches.
 *
 * `bgpTriples` is the per-binding `bgp` array as built by `prove.ts`
 * (each element carries the encoded `terms: [string; 4]`); it is the
 * source for `Term::Input(p, j)` substitutions in `absent_terms`.
 */
export function buildPrefix3Inputs(
  signedData: SignedData,
  metadata: {
    prefixNotExists?: PrefixNotExistsMeta[];
    prefix_not_exists?: PrefixNotExistsMeta[];
    bgpPrefix3Length?: number;
    bgp_prefix3_length?: number;
    variables?: string[];
  },
  binding: ReadonlyMap<string, { termType: string; value: string; language?: string; datatype?: { value: string } }>,
  bgpTriples: ReadonlyArray<{ terms: string[] }>,
  encodeTerm: (descriptor: AbsentTermDescriptor, binding: ReadonlyMap<string, { termType: string; value: string; language?: string; datatype?: { value: string } }>, bgpTriples: ReadonlyArray<{ terms: string[] }>) => string,
): Prefix3Inputs | null {
  const constraints = metadata.prefixNotExists || metadata.prefix_not_exists || [];
  const bgpPrefix3Length = metadata.bgpPrefix3Length ?? metadata.bgp_prefix3_length ?? 0;

  if (!signedData.prefix3) {
    if (constraints.length === 0 && bgpPrefix3Length === 0) {
      // No prefix-3 dispatches and no prefix-3 inputs needed -- but if
      // the circuit declares a `BgpPrefix3` array of any size, the
      // verifier still expects a (possibly empty) shape. Return null
      // so the caller knows to omit the inputs entirely.
      return null;
    }
    throw new Error(
      'prefix-3 inputs requested by circuit metadata but signedData.prefix3 is absent. ' +
      'Re-sign the dataset with the round-6 signer (sign.ts) to populate the prefix-3 commitment.',
    );
  }

  const prefix3 = signedData.prefix3;

  // Phase 1: substitute absent_terms[j] for each constraint into
  // encoded Field strings. We collect the substituted (s, p, g)
  // triples first so we can batch the absent-hash computation in a
  // single Noir execution call.
  const absences: { fixedTerms: [string, string, string]; bracketLeftIdx: number; bracketRightIdx: number }[] = [];
  for (const c of constraints) {
    if (c.prefixKind !== 'prefix3_sp_g') {
      throw new Error(`unsupported prefix kind ${c.prefixKind}: round 6 only ships prefix3_sp_g`);
    }
    const fixed = c.fixedPositions;
    const fixedTerms: [string, string, string] = [
      encodeTerm(c.absentTerms[fixed[0]!]!, binding, bgpTriples),
      encodeTerm(c.absentTerms[fixed[1]!]!, binding, bgpTriples),
      encodeTerm(c.absentTerms[fixed[2]!]!, binding, bgpTriples),
    ];
    absences.push({
      fixedTerms,
      bracketLeftIdx: c.bracketLeftIdx,
      bracketRightIdx: c.bracketRightIdx,
    });
  }

  // Phase 2: compute hash3_sp_g for each absent prefix in one Noir
  // batch -- runJson handles the array shape and we get back a
  // string[] aligned with `absences`.
  const absentHashes: string[] = absences.length > 0
    ? runJson(`[${absences.map(a => `utils::prefix3::hash3_sp_g(${a.fixedTerms[0]}, ${a.fixedTerms[1]}, ${a.fixedTerms[2]})`).join(',')}]`)
    : [];

  // Phase 3: bracket + boundary dispatch. Sort the prefix-3 tree's
  // real leaves by hash (their `paths[i][0]`); compare each absent
  // hash and find the bracketing pair.
  const realLeafCount = prefix3.prefixes.length;
  const realLeavesByInputIdx: { inputIdx: number; sortedIdx: number; hash: bigint }[] = [];
  for (let i = 0; i < realLeafCount; i++) {
    const sortedIdx = reconstructSortedIndex(prefix3.direction[i]!);
    const hash = parseFieldString(prefix3.paths[i]![0]!);
    realLeavesByInputIdx.push({ inputIdx: i, sortedIdx, hash });
  }
  realLeavesByInputIdx.sort((a, b) => (a.sortedIdx - b.sortedIdx));

  // Initialise `bgp_prefix3` slots to a default-included leaf (the
  // smallest real leaf) so every slot satisfies the per-triple
  // inclusion check. Slots that participate in a real bracket are
  // overwritten below.
  const fillerInputIdx = realLeavesByInputIdx[0]!.inputIdx;
  const bgpPrefix3: PrefixTriple3Input[] = [];
  for (let s = 0; s < bgpPrefix3Length; s++) {
    bgpPrefix3.push(prefixTriple3FromSignedData(prefix3, fillerInputIdx));
  }

  const boundaryCasesPrefix3: string[] = [];
  for (let i = 0; i < absences.length; i++) {
    const a = absences[i]!;
    const absentHash = parseFieldString(absentHashes[i] as unknown as string);

    // Strict-`<` ordering against sorted real leaves.
    let leftReal: { inputIdx: number; sortedIdx: number; hash: bigint } | null = null;
    let rightReal: { inputIdx: number; sortedIdx: number; hash: bigint } | null = null;
    for (const leaf of realLeavesByInputIdx) {
      if (leaf.hash < absentHash) {
        leftReal = leaf;
      } else if (leaf.hash === absentHash) {
        throw new Error(
          `prefix-3 NOT EXISTS constraint ${i} found absent prefix already in the dataset; ` +
          `this binding fails the non-existence check. Drop it from the binding set or fix the query.`,
        );
      } else if (rightReal == null) {
        rightReal = leaf;
        break;
      }
    }

    let boundaryCase: number;
    if (leftReal == null) {
      // Lower: low sentinel + smallest real prefix leaf.
      boundaryCase = 0;
      bgpPrefix3[a.bracketRightIdx] = prefixTriple3FromSignedData(prefix3, rightReal!.inputIdx);
      // Left bracket slot stays as the filler -- the circuit ignores
      // it in the Lower arm.
    } else if (rightReal == null) {
      // Upper: largest real prefix leaf + high sentinel.
      boundaryCase = 2;
      bgpPrefix3[a.bracketLeftIdx] = prefixTriple3FromSignedData(prefix3, leftReal.inputIdx);
    } else {
      // Middle: two adjacent real prefix leaves.
      boundaryCase = 1;
      bgpPrefix3[a.bracketLeftIdx] = prefixTriple3FromSignedData(prefix3, leftReal.inputIdx);
      bgpPrefix3[a.bracketRightIdx] = prefixTriple3FromSignedData(prefix3, rightReal.inputIdx);
    }
    boundaryCasesPrefix3.push(fieldToHex(BigInt(boundaryCase)));
  }

  return {
    bgp_prefix3: bgpPrefix3,
    low_sentinel_3: {
      path: prefix3.lowSentinelPath,
      directions: prefix3.lowSentinelDirections,
    },
    high_sentinel_3: {
      path: prefix3.highSentinelPath,
      directions: prefix3.highSentinelDirections,
    },
    boundary_cases_prefix3: boundaryCasesPrefix3,
  };
}

/**
 * Build a `PrefixTriple3` slot from the signed prefix-3 commitment's
 * input-positional metadata at index `i`. The triple's `terms` are
 * the encoded `(s, p, g)` Fields; `path` / `directions` lift the
 * leaf to the prefix-3 sorted root.
 */
function prefixTriple3FromSignedData(prefix3: PrefixTree3Data, i: number): PrefixTriple3Input {
  const prefix = prefix3.prefixes[i]!;
  return {
    terms: [prefix[0]!, prefix[1]!, prefix[2]!] as [string, string, string],
    path: prefix3.paths[i]!,
    directions: prefix3.direction[i]!,
  };
}
