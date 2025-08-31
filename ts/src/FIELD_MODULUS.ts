// Utilities
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function modP(x: bigint): bigint { let r = x % FIELD_MODULUS; if (r < 0) r += FIELD_MODULUS; return r; }
export function iriToField(str: string): string {
  // FNV-1a 64-bit then widen by mixing to 254-bit
  let h = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * FNV_PRIME) & ((1n << 64n) - 1n);
  }
  // widen/mix
  let x = h;
  x = (x << 64n) ^ (h * 0x9e3779b97f4a7c15n);
  x = (x << 64n) ^ (h * 0xc2b2ae3d27d4eb4fn);
  return modP(x).toString();
}
