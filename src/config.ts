export const stringHashes = [
  'blake2s',
  'blake3',
  'sha256',
  // This doesn't work because we cannot convert [u8; 48] to Field over the current modulus
  // 'sha384',
  // This doesn't work because we cannot convert [u8; 64] to Field over the current modulus
  // 'sha512',
  'keccak256',
] as const;
export const fieldHashes = [
  'pedersen',
  // std::hash::hash_to_field is not available in Noir currently
  // 'blake2s',
  'poseidon',
  'poseidon2',
  'mimc',
] as const;
export const merkleDepths = [9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31] as const;
export const signatures = [
  'secp256k1',
  'secp256r1',
  // TODO: Fix this
  // 'babyjubjub',
  'babyjubjubOpt',
  'schnorr',
] as const;

/**
 * Default upper bound on the bounded byte-array term witness
 * (`STRING_LEN_MAX`). See `spec/encoding.md` §6 — this knob trades
 * privacy (length-leak resistance) and circuit size for the maximum
 * length of any RDF lexical the circuit's string operators can read.
 * Round-1 default; callers can pick any positive integer at setup time.
 */
export const DEFAULT_STRING_LEN_MAX = 64;

interface IConfigInternal {
  stringHash: (typeof stringHashes)[number];
  fieldHash: (typeof fieldHashes)[number];
  merkleDepth: (typeof merkleDepths)[number];
  signature: (typeof signatures)[number];
  /**
   * Upper bound on the bounded byte-array witness per term (see
   * `spec/encoding.md` §6.5). Round-1 default 64; callers can pick
   * any positive integer at setup time.
   */
  stringLenMax: number;
}

interface IConfig extends IConfigInternal {
  stringHashOutputSize: number;
}

const defaultConfigInternal: IConfigInternal = {
  stringHash: 'sha256',
  fieldHash: 'pedersen',
  merkleDepth: 11,
  signature: 'babyjubjubOpt',
  stringLenMax: DEFAULT_STRING_LEN_MAX,
}

export const defaultConfig: IConfig = {
  ...defaultConfigInternal,
  // For sha384, output size is 48 bytes, for sha512 64 bytes, otherwise 32 bytes
  stringHashOutputSize: 32,
};

export function* configGenerator(): Generator<IConfig> {
  for (const stringHash of stringHashes)
    for (const fieldHash of fieldHashes)
      for (const merkleDepth of merkleDepths)
        for (const signature of signatures)
          yield { stringHash, fieldHash, merkleDepth, signature, stringHashOutputSize: 32, stringLenMax: DEFAULT_STRING_LEN_MAX };
}
