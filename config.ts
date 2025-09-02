export const stringHashes = ['blake2s', 'blake3', 'sha256'] as const;
export const fieldHashes = ['poseidon2', 'pedersen', 'blake2s'] as const;
export const merkleDepths = [11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31] as const;

interface IConfig {
  stringHash: (typeof stringHashes)[number];
  fieldHash: (typeof fieldHashes)[number];
  merkleDepth: (typeof merkleDepths)[number];
}

export const defaultConfig: IConfig = {
  stringHash: 'blake3',
  fieldHash: 'pedersen',
  merkleDepth: 11,
}

export function *configGenerator(): Generator<IConfig> {
  for (const stringHash of stringHashes)
    for (const fieldHash of fieldHashes)
      for (const merkleDepth of merkleDepths)
        yield { stringHash, fieldHash, merkleDepth };
}
