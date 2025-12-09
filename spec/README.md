# ZK-SPARQL Specification

Zero-knowledge proofs of SPARQL query results over signed RDF datasets.

## Documents

| Document | Description |
|----------|-------------|
| [encoding.md](./encoding.md) | RDF term and triple encoding into field elements |
| [algebra.md](./algebra.md) | SPARQL to Noir circuit mapping |
| [preprocessing.md](./preprocessing.md) | Query transformations before circuit generation |
| [proofs.md](./proofs.md) | API specification (sign, prove, verify, info) |
| [disclosure.md](./disclosure.md) | What information is disclosed by proofs |
| [config.md](./config.md) | Configuration parameters |

## Quick Reference

### Term Encoding

```
Enc_t(term) = h_2(type_code, value_encoding)
Enc_Q(s, p, o, g) = h_4(Enc_t(s), Enc_t(p), Enc_t(o), Enc_t(g))
```

### Term Type Codes

| Type | Code |
|------|------|
| NamedNode | 0 |
| BlankNode | 1 |
| Literal | 2 |
| Variable | 3 |
| DefaultGraph | 4 |

### Default Configuration

| Parameter | Default |
|-----------|---------|
| `h_2`, `h_4` | pedersen_hash |
| `h_s` | blake3 |
| Signature | Schnorr |
| Merkle Depth | 11 |
| Path Segment Max | 8 |

### API

```rust
sign(dataset, keypair, config) -> SignedDataset
prove(query, datasets, config) -> Proof
verify(proof) -> VerificationResult
info(query, config) -> DisclosureInfo
```

## References

- [RDF 1.1 Concepts](https://www.w3.org/TR/rdf11-concepts/)
- [SPARQL 1.1 Query Language](https://www.w3.org/TR/sparql11-query/)
- [Noir Language](https://noir-lang.org/docs)
