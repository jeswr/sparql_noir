# SPARQL Noir

Zero-knowledge proofs for SPARQL query results over signed RDF datasets.

## Overview

sparql_noir generates ZK proofs that SPARQL query results are correct, without revealing the underlying signed RDF datasets. This enables privacy-preserving querying of sensitive linked data.

## SPARQL 1.0 Support

✅ **Comprehensive SPARQL 1.0 coverage achieved!**

All core SPARQL 1.0 features are now supported:

- **Query Forms**: SELECT, ASK
- **Graph Patterns**: BGP, UNION, OPTIONAL, GRAPH
- **Filters**: All comparison, equality, and logical operators
- **Functions**: isIRI, isBlank, isLiteral, STR, LANG, DATATYPE, LANGMATCHES, BOUND, sameTerm
- **Solution Modifiers**: DISTINCT, ORDER BY, LIMIT, OFFSET (via post-processing)

See [SPARQL_COVERAGE.md](./SPARQL_COVERAGE.md) for complete feature documentation.

## Quick Start

### Prerequisites

```bash
# Check Noir version (requires 1.0.0-beta.12 or later)
% nargo --version
nargo version = 1.0.0-beta.12
noirc version = 1.0.0-beta.12+9a5b3695b42e391fa27c48e87b9bbb07523d664d
(git version hash: 9a5b3695b42e391fa27c48e87b9bbb07523d664d, is dirty: false)
```

### Installation

```bash
npm install
npm run build
```

### Example Usage

```bash
# Sign an RDF dataset
npm run sign -- -i inputs/data/data.ttl -o signed.json

# Transform SPARQL to Noir circuit
npm run transform -- -q inputs/sparql.rq -o output/

# Generate proof
npm run prove -- --circuit output --signed signed.json --out proof.json

# Verify proof
npm run verify -- --proof proof.json
```

## Architecture

The system consists of four main components:

1. **Transform** (Rust): Converts SPARQL queries to Noir circuits
2. **Sign** (TypeScript): Signs RDF datasets with Merkle tree
3. **Prove** (TypeScript): Generates ZK proofs using Noir/bb.js
4. **Verify** (TypeScript): Verifies proofs

### Post-Processing Architecture

Solution modifiers (DISTINCT, ORDER BY, LIMIT, OFFSET) are handled via post-processing:

1. **Circuit proves**: Each result binding is valid
2. **Verifier applies**: DISTINCT, ORDER BY, LIMIT, OFFSET to proven results

This architecture minimizes circuit complexity while maintaining correctness.

## Documentation

- [SPARQL_COVERAGE.md](./SPARQL_COVERAGE.md) - Complete SPARQL feature support matrix
- [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) - Technical implementation details
- [spec/](./spec/) - Formal specifications for encoding, algebra, and proofs

## Testing

```bash
# Run SPARQL 1.0 test suite (requires internet)
npm run test:sparql10

# Run with filters
npm run test:sparql10 -- -f="OPTIONAL"  # Only OPTIONAL tests
npm run test:sparql10 -- -1             # Single binding (faster)
npm run test:sparql10 -- -t             # Transform only (fastest)

# Run snapshot tests (offline)
npm run test:snapshot

# Run full E2E test
npm run e2e
```

## Project Structure

```
sparql_noir/
├── transform/          # Rust: SPARQL → Noir transform
├── noir/lib/           # Shared Noir libraries
├── src/scripts/        # TypeScript: sign, prove, verify
├── spec/               # Specifications
├── test/               # Test suites
└── inputs/             # Example queries and data
```

## License

[Add license information]

## Contributing

[Add contributing guidelines]