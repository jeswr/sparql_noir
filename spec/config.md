# Configuration

Configurable parameters for the ZK-SPARQL proof system.

## Config Structure

```rust
pub struct Config {
    pub hash: HashType,
    pub string_hash: StringHashType,
    pub signature: SignatureType,
    pub merkle_depth: u32,
    pub path_segment_max: u32,
}
```

## Hash Functions

### h_2 / h_4 (Term Encoding)

| Type | Implementation |
|------|----------------|
| `Pedersen` | `std::hash::pedersen_hash` (default) |
| `Poseidon2` | `poseidon2::bn254::hash_{2,4}` |

### h_s (String Encoding)

| Type | Implementation |
|------|----------------|
| `Blake3` | `std::hash::blake3` (default) |
| `Sha256` | `sha256::digest` |
| `Keccak256` | `keccak256::keccak256` |

## Signature Schemes

| Type | Curve | Notes |
|------|-------|-------|
| `Schnorr` | Grumpkin | Default, Noir native |
| `EcdsaSecp256k1` | secp256k1 | Bitcoin/Ethereum |
| `EcdsaSecp256r1` | P-256 | WebAuthn |
| `BabyJubJub` | BabyJubJub | EdDSA-like |

## Architecture Parameters

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| `merkle_depth` | 11 | 1-32 | Max triples = 2^depth |
| `path_segment_max` | 8 | 1-32 | Max property path hops |

## Defaults

```rust
impl Default for Config {
    fn default() -> Self {
        Self {
            hash: HashType::Pedersen,
            string_hash: StringHashType::Blake3,
            signature: SignatureType::Schnorr,
            merkle_depth: 11,
            path_segment_max: 8,
        }
    }
}
```

## Disclosed Variables

Disclosed variables are determined by the SPARQL query, not configuration:

- **SELECT queries:** Variables listed after `SELECT` are disclosed
- **SELECT *:** All in-scope variables are disclosed

```sparql
# Discloses: ?name, ?email
SELECT ?name ?email WHERE { ... }

# Discloses: all bound variables
SELECT * WHERE { ... }
```

See [disclosure.md](./disclosure.md) for details on what proofs reveal.

## CLI Usage

```bash
sparql-zk prove \
    --query query.rq \
    --datasets signed.json \
    --hash pedersen \
    --string-hash blake3 \
    --signature schnorr \
    --merkle-depth 11
```

## JSON Configuration

```json
{
  "hash": "pedersen",
  "stringHash": "blake3",
  "signature": "schnorr",
  "merkleDepth": 11,
  "pathSegmentMax": 8
}
```
