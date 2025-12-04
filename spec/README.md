# ZK-SPARQL Specification

This directory contains the formal specification for the ZK-SPARQL proof system, enabling zero-knowledge proofs of SPARQL query results over signed RDF datasets.

## Overview

The ZK-SPARQL system allows a prover to demonstrate that query results are correct without revealing the underlying data beyond explicitly disclosed bindings.

### Core Capabilities

- **Prove query results** from signed RDF datasets
- **Selective disclosure** of variable bindings
- **Configurable** hash functions, signatures, and architecture
- **Multiple dataset** support with distinct signers

---

## Specification Documents

### [1. Encoding Specification](./encoding.md)

Formal definitions for encoding RDF terms into circuit inputs.

**Key Topics:**
- Term type codes (NamedNode, BlankNode, Literal, Variable, DefaultGraph)
- Hash function interfaces (`h_2`, `h_4`, `h_s`)
- Term encoding: `Enc_t(t) = h_2(type(t), Enc_v(t))`
- Literal encoding with special XSD type handling
- Triple/Quad encoding
- Merkle tree structure

### [2. Algebra Specification](./algebra.md)

Extended SPARQL evaluation semantics with occurrence tracking.

**Key Topics:**
- Indexed solution mappings (`μ+`)
- Extended evaluation (`eval+`) for BGP, Join, Union, LeftJoin, Filter, Extend
- Property path bounded expansion
- Filter expression handling
- Query analysis for proof requirements

### [3. Proof Specification](./proofs.md)

Proof types, derivation rules, and proof structure.

**Key Topics:**
- Proof of Knowledge of Signature (PoKS)
- Merkle inclusion proofs
- Variable binding proofs
- Proof of Numeric Bounds (PoNB)
- Filter and Union branch proofs
- Complete proof structure

### [4. Disclosure Specification](./disclosure.md)

Privacy model and disclosure analysis.

**Key Topics:**
- Structural disclosure (merkle depth, path limits, etc.)
- Query and authentication disclosure
- Configurable result disclosure
- Numeric bounds disclosure
- Privacy analysis and compliance considerations

### [5. Configuration Specification](./config.md)

Configurable parameters and presets.

**Key Topics:**
- Encoding configuration (hash functions)
- Signature scheme selection
- Architecture parameters (merkle depth, path segment max)
- Disclosure configuration
- CLI configuration options
- Configuration presets (default, high-performance, compatibility, privacy)

---

## Quick Reference

### Term Type Codes

| Type | Code |
|------|------|
| NamedNode | 0 |
| BlankNode | 1 |
| Literal | 2 |
| Variable | 3 |
| DefaultGraph | 4 |

### Default Configuration

| Parameter | Default Value |
|-----------|---------------|
| `h_2` | Pedersen |
| `h_4` | Pedersen |
| `h_s` | Blake3 |
| Signature | Schnorr/Grumpkin |
| Merkle Depth | 11 |
| Path Segment Max | 8 |

### Core Encoding Formulas

```
Enc_t(t) = h_2(type(t), Enc_v(t))

Enc_v(literal) = h_4(Enc_s(value), Enc_special(literal), Enc_s(lang), Enc_s(datatype))

Enc_Q(s, p, o, g) = h_4(Enc_t(s), Enc_t(p), Enc_t(o), Enc_t(g))
```

---

## Directory Structure

```
spec/
├── README.md          # This file
├── encoding.md        # Term/triple encoding specification
├── algebra.md         # Extended SPARQL algebra
├── proofs.md          # Proof types and structure
├── disclosure.md      # Privacy and disclosure model
├── config.md          # Configuration parameters
├── schema/            # Machine-readable schemas (future)
│   ├── encoding.jsonld
│   ├── proof.jsonld
│   └── config.jsonld
└── w3c/               # W3C ReSpec specification (future)
    └── index.html
```

---

## Relationship to Implementation

| Spec Section | Implementation |
|--------------|----------------|
| Encoding | `transform/src/main.rs` (Rust), `src/encode.ts` (TS legacy) |
| Algebra | `transform/src/main.rs` (pattern handling) |
| Proofs | `noir/lib/` (circuit libraries) |
| Configuration | `noir/lib/consts/src/lib.nr`, `transform/src/main.rs` |

---

## Versioning

| Version | Date | Status |
|---------|------|--------|
| 0.1.0 | 2024-12-04 | Initial draft |

---

## Contributing

When modifying these specifications:

1. Ensure formal notation is consistent across documents
2. Update implementation references when code changes
3. Maintain alignment with the WWW26 zkRDF paper
4. Add changelog entries for significant changes

---

## References

1. [RDF 1.1 Concepts and Abstract Syntax](https://www.w3.org/TR/rdf11-concepts/)
2. [SPARQL 1.1 Query Language](https://www.w3.org/TR/sparql11-query/)
3. [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
4. WWW26 zkRDF Paper (collaborative work)
5. [Noir Language Documentation](https://noir-lang.org/docs)
