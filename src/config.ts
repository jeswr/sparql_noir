export const stringHashes = ['blake2s', 'blake3', 'sha256'] as const;
export const fieldHashes = ['pedersen', 'blake2s'] as const;
export const merkleDepths = [11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31] as const;
export const signatures = ['secp256k1', 'babyjubjub', 'bls'] as const;

interface IConfig {
  stringHash: (typeof stringHashes)[number];
  fieldHash: (typeof fieldHashes)[number];
  merkleDepth: (typeof merkleDepths)[number];
  signature: (typeof signatures)[number];
}

export const defaultConfig: IConfig = {
  stringHash: 'blake2s',
  fieldHash: 'pedersen',
  merkleDepth: 11,
  signature: 'secp256k1',
}

export function *configGenerator(): Generator<IConfig> {
  for (const stringHash of stringHashes)
    for (const fieldHash of fieldHashes)
      for (const merkleDepth of merkleDepths)
        for (const signature of signatures)
          yield { stringHash, fieldHash, merkleDepth, signature };
}
