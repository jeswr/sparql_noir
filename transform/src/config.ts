interface IConfig {
  stringHash: 'blake2s' | 'blake3' | 'sha256';
  hash: 'poseidon2' | 'pedersen' | 'blake2s';
  merkleDepth: number;
}

const config: IConfig = {
  stringHash: 'blake3',
  hash: 'pedersen',
  merkleDepth: 11,
}

export default config;
