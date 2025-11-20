// A script to prepare an RDF Dataset for a Merkle tree proof
import type { Term, Literal } from "@rdfjs/types";
import { execSync } from 'child_process';
import fs from "fs";

const termTypeMapping: Partial<Record<Term['termType'], number>> = {
  "NamedNode": 0,
  "BlankNode": 1,
  "Literal": 2,
  "Variable": 3,
  "DefaultGraph": 4,
  "Quad": 5,
}

export function run(fn: string) {
  const template = fs.readFileSync('./noir/bin/encode/src/main.nr.template', 'utf8');

  const content = template.replaceAll('{{fn}}', fn)
  fs.writeFileSync('./noir/bin/encode/src/main.nr', content);
  const res = execSync('cd noir/bin/encode && nargo execute', { stdio: 'pipe' }).toString();
  fs.rmSync('./noir/bin/encode/src/main.nr');

  const resObj = res
      .slice(res.indexOf('§') + 1, res.lastIndexOf('§'))
      // Add quotes around anything that looks like a hex encoding and then parse to json
      .replace(/0x[0-9a-fA-F]+/g, match => `"${match}"`);

  return resObj;
}

export function runJson(fn: string) {
  let res = run(fn)
    // Put strings around keys of objects if they are not already in quotes
    .replace(/[a-zA-Z0-9_]+(?=:)/g, match => `"${match}"`)
    // Remove the struct names to make it valid JSON
    .replace(/[a-zA-Z]+ (?={)/g, '');
  return JSON.parse(res);
}

export function stringToFieldFn(str: string) {
  return `utils::encode_string("${str.replaceAll('"', '\\"')}")`;
}

export function specialLiteralHandling(term: Literal) {
  // TODO: Add more special handling for different datatypes
  if (term.datatype && term.datatype.value === 'http://www.w3.org/2001/XMLSchema#boolean') {
    if (term.value.toLowerCase() === 'true' || term.value === '1')
      return '1';
    if (term.value.toLowerCase() === 'false' || term.value === '0')
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
    return `consts::hash4([${
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
  return `consts::hash2([${termTypeMapping[term.termType]}, ${termToFieldFn(term, termEncodingVariables)}])`
}

export function getTermEncodingsStrings(term: Term[]): string[] {
  return runJson(`[${term.map((term) => getTermEncodingString(term)).join(', ')}]`)
}

export function getTermField(term: Term[]): string[] {
  return runJson(`[${term.map((term) =>termToFieldFn(term)).join(', ')}]`)
}

export function getTermEncodings(term: Term[]): BigInt[] {
  return getTermEncodingsStrings(term).map((triple: string) => BigInt(triple));
}
