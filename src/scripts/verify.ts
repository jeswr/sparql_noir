import { Buffer } from 'node:buffer';
import { readFileSync } from 'fs';
import { join } from 'path';
import { type CompiledCircuit, type ForeignCallHandler, type ForeignCallInput, Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';

// Load JSON files dynamically
const jsonPath = join(process.cwd(), 'temp', 'main.json');
const circuitPath = join(process.cwd(), 'noir', 'bin', 'signature', 'target', 'signature.json');

const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
const verifyCircuit = JSON.parse(readFileSync(circuitPath, 'utf8'));

// Proceed with circuit verification for all signature types
const noir = new Noir(verifyCircuit as unknown as CompiledCircuit);
const backend = new UltraHonkBackend(verifyCircuit.bytecode, { threads: 6 });

const noirPrintLogger: ForeignCallHandler = async (name, inputs) => {
  if (name !== 'print')
    throw new Error(`Unexpected foreign call during circuit execution: ${name}`);

  const message = decodeNoirPrint(inputs);
  console.log(`[noir] ${message}`);

  return [];
};

function decodeNoirPrint(inputs: ForeignCallInput[]): string {
  const asciiChunks = inputs
    .map(decodeAsciiChunk)
    .filter((chunk): chunk is string => typeof chunk === 'string' && chunk.length > 0);

  const preferredChunk = asciiChunks.find((chunk) => !chunk.trimStart().startsWith('{')) ?? asciiChunks[0];
  if (preferredChunk)
    return preferredChunk;

  const fallback = inputs
    .map((chunk) => chunk.map((value) => formatFieldValue(value)).join(', '))
    .filter(Boolean)
    .join(' | ');

  return fallback.length > 0 ? fallback : '(no output)';
}

function decodeAsciiChunk(chunk: ForeignCallInput): string | undefined {
  if (chunk.length === 0)
    return undefined;

  const bytes: number[] = [];
  for (const value of chunk) {
    const byte = toPrintableByte(value);
    if (byte === undefined)
      return undefined;
    bytes.push(byte);
  }

  const text = Buffer.from(bytes).toString('utf8').replace(/\u0000+$/g, '');
  if (text.length === 0)
    return undefined;
  return /^[\t\n\r\x20-\x7E]+$/.test(text) ? text : undefined;
}

function toPrintableByte(value: string): number | undefined {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > 0xffn)
      return undefined;
    return Number(parsed);
  } catch {
    return undefined;
  }
}

function formatFieldValue(value: string): string {
  try {
    return BigInt(value).toString();
  } catch {
    return value;
  }
}

try {
  console.time('Witness generation');
  const { witness } = await noir.execute({
    public_key: json.pubKey,
    root: {
      value: json.root,
      signature: json.signature,
    },
  }, noirPrintLogger);
  console.timeEnd('Witness generation');

  // Generate and verify the proof using UltraHonkBackend
  console.time('Proof generation');
  const proof = await backend.generateProof(witness);
  console.timeEnd('Proof generation');

  console.time('Proof verification');
  const isValid = await backend.verifyProof(proof);
  console.timeEnd('Proof verification');

  if (!isValid)
    throw new Error('Circuit verification failed');
} catch (error) {
  // @ts-expect-error
  console.log('Circuit verification failed:', error.message);
}

backend.destroy();
