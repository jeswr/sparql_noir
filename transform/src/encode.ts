// A script to prepare an RDF Dataset for a Merkle tree proof
import { Term, Literal } from "@rdfjs/types";
import { execSync } from 'child_process';
import fs from "fs";
import config from './config.js';

export const hash2 = {
  'poseidon2': 'dep::poseidon2::bn254::hash_2',
  'blake2s': 'std::hash::hash_to_field',
  'pedersen': 'std::hash::pedersen_hash',
}[config.hash];

export const hash4 = {
  'poseidon2': 'dep::poseidon2::bn254::hash_4',
  'blake2s': 'std::hash::hash_to_field',
  'pedersen': 'std::hash::pedersen_hash',
}[config.hash];

export const stringHash = {
  'blake2s': 'std::hash::blake2s',
  'blake3': 'std::hash::blake3',
  'sha256': 'dep::sha256::sha256::sha256',
}[config.stringHash];

const termTypeMapping: Partial<Record<Term['termType'], number>> = {
  "NamedNode": 0,
  "BlankNode": 1,
  "Literal": 2,
  "Variable": 3,
  "DefaultGraph": 4,
  "Quad": 5,
}

export function run(fn: string) {
  fs.mkdirSync('./noir_encode/src/', { recursive: true });
  const content = `fn main() {\nprint("§");\nprint(${fn});\nprint("§");\n}\n`;
  fs.writeFileSync('./noir_encode/src/main.nr', content);
  const res = execSync('cd noir_encode && nargo execute', { stdio: 'pipe' }).toString();
  fs.rmSync('./noir_encode/src', { force: true, recursive: true });
  const resObj = res
      .slice(res.indexOf('§') + 1, res.lastIndexOf('§'))
      // Add quotes around anything that looks like a hex encoding and then parse to json
      .replace(/0x[0-9a-fA-F]+/g, match => `"${match}"`);

  return resObj;
}

export function runJson(fn: string) {
  return JSON.parse(run(fn));
}

export function stringToFieldFn(str: string) {
  return `Field::from_le_bytes(${stringHash}("${str.replaceAll('"', '\\"')}".as_bytes()))`;
}

export function specialLiteralHandling(term: Literal) {
  if (term.datatype && term.datatype.value === 'http://www.w3.org/2001/XMLSchema#boolean' && (term.value.toLowerCase() === 'true' || term.value === '1')) {
    return '1';
  }
  if (term.datatype && term.datatype.value === 'http://www.w3.org/2001/XMLSchema#boolean' && (term.value.toLowerCase() === 'false' || term.value === '0')) {
    return '0';
  }
  if (term.datatype && term.datatype.value === 'http://www.w3.org/2001/XMLSchema#integer') {
    return parseInt(term.value, 10).toString();
  }
  if (term.datatype && term.datatype.value === 'http://www.w3.org/2001/XMLSchema#dateTime') {
    // Convert to epoch milliseconds for numeric comparisons
    const ms = Date.parse(term.value);
    if (!Number.isNaN(ms)) {
      return ms.toString();
    }
    // Fallback: treat as string if parse fails
    return stringToFieldFn(term.value);
  }
  // Add more special handling as needed
  return stringToFieldFn(term.value);
}

interface TermEncodingVariables {
  lang?: string;
  valueEncoding?: string;
  literalEncoding?: string;
  datatypeEncoding?: string;
}

export function termToFieldFn(term: Term, termEncodingVariables?: TermEncodingVariables): string {
  // If there are term encoding variables, then this string value is likely to be used in a circuit,
  // thus we want to precompute as many internal vales as possible.
  let r = (fn: string) => termEncodingVariables ? BigInt(run(fn).replaceAll('\"', '')).toString() : fn;
  if (term.termType === 'Literal') {
    return `${hash4}([${
      termEncodingVariables?.valueEncoding ?? r(stringToFieldFn(term.value))
    }, ${
      termEncodingVariables?.literalEncoding ?? r(specialLiteralHandling(term))
    }, ${
      termEncodingVariables?.lang ?? r(stringToFieldFn(term.language))
    }, ${
      termEncodingVariables?.datatypeEncoding ?? r(termToFieldFn(term.datatype))
    }])`;
    // return `dep::poseidon2::bn254::hash_4([${stringToFieldFn(term.value)}, ${specialLiteralHandling(term)}, ${term.language ? stringToFieldFn(term.language) : 0}, ${stringToFieldFn(term.datatype.value)}])`;
    // return `dep::poseidon2::bn254::hash_4([${ stringToFieldFn(term.value)}, ${specialLiteralHandling(term)}, ${termEncodingVariables?.lang || (term.language ? termToFieldFn(DF.literal(term.language)) : 0)}, ${stringToFieldFn(term.datatype.value)}])`;
  }
  return r(stringToFieldFn(term.value));
}

export function getTermEncodingString(term: Term, termEncodingVariables?: TermEncodingVariables): string {
  return `${hash2}([${termTypeMapping[term.termType]}, ${termToFieldFn(term, termEncodingVariables)}])`
}

export function getTermEncodingsStrings(term: Term[]): string[] {
  return runJson(`[${term.map((term) => getTermEncodingString(term)).join(', ')}]`)
}

export function getTermField(term: Term[]): string[] {
  return runJson(`[${term.map((term) =>termToFieldFn(term)).join(', ')}]`)
}

export function getTermEncodings(term: Term[]): BigInt[] {
  console.log('getTermEncodings called with term:', getTermEncodingsStrings(term));
  return getTermEncodingsStrings(term).map((triple: string) => BigInt(triple));
}
