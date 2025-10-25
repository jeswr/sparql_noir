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
] as const;
export const merkleDepths = [9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31] as const;
export const signatures = [
  'secp256k1',
  'secp256r1',
  // TODO: Fix this
  // 'babyjubjub',
  'babyjubjubOpt'
] as const;

interface IConfigInternal {
  stringHash: (typeof stringHashes)[number];
  fieldHash: (typeof fieldHashes)[number];
  merkleDepth: (typeof merkleDepths)[number];
  signature: (typeof signatures)[number];
}

interface IConfig extends IConfigInternal {
  stringHashOutputSize: number;
}

const defaultConfigInternal: IConfigInternal = {
  stringHash: 'sha256',
  fieldHash: 'poseidon2',
  merkleDepth: 11,
  signature: 'babyjubjubOpt',
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
          yield { stringHash, fieldHash, merkleDepth, signature, stringHashOutputSize: 32 };
}
