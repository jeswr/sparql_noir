# SPARQL Noir

Zero-knowledge proofs for SPARQL query results over signed RDF datasets.

## Overview

sparql_noir generates ZK proofs that SPARQL query results are correct, without revealing the underlying signed RDF datasets. This enables privacy-preserving querying of sensitive linked data.

## Installation

```bash
npm install @jeswr/sparql-noir
```

## API Usage

### Quick Start

```typescript
import { sign, prove, verify, info } from '@jeswr/sparql-noir';
import { Store, Parser } from 'n3';

// 1. Load your RDF data into an RDF/JS dataset
const store = new Store();
const parser = new Parser();
// Parse your RDF data...

// 2. Sign the dataset
const signed = await sign(store);

// 3. Get disclosure information for your query
const query = 'SELECT ?name WHERE { ?person foaf:name ?name }';
const disclosure = info(query);
console.log('Disclosed variables:', disclosure.disclosedVariables);

// 4. Generate a proof (internally generates and compiles circuit)
const proof = await prove(query, signed);

// 5. Verify the proof
const result = await verify(proof);
console.log('Valid:', result.success);
```

### API Reference

#### `sign(dataset: DatasetCore, config?: Config): Promise<SignedData>`

Signs an RDF/JS dataset, producing a signed dataset with Merkle root and signature.

**Parameters:**
- `dataset` - RDF/JS DatasetCore (e.g., N3.Store) containing the quads to sign
- `config` - Optional configuration (hash functions, signature scheme, merkle depth)

**Returns:** Signed dataset with Merkle root, signature, and encoded triples

**Example:**
```typescript
import { Store, Parser } from 'n3';
const store = new Store();
const parser = new Parser();
// Parse your Turtle data into the store
const signed = await sign(store);
```

#### `prove(query: string, signedData: SignedData, config?: Config): Promise<ProveResult>`

Generates a zero-knowledge proof that a SPARQL query holds over signed datasets.
Internally generates the Noir circuit, compiles it, and creates the proof.

**Parameters:**
- `query` - SPARQL SELECT query string
- `signedData` - Signed dataset(s) to query over
- `config` - Optional configuration

**Returns:** Proof object with proof bytes, verification key, and embedded circuit

**Note:** Requires Rust/Cargo and Nargo to be installed for circuit generation and compilation.

#### `verify(proof: ProveResult, config?: Config): Promise<VerifyResult>`

Verifies a proof is valid using the compiled circuit embedded in the proof.

**Parameters:**
- `proof` - Proof object returned from `prove()`
- `config` - Optional configuration

**Returns:** Verification result indicating if the proof is valid

#### `info(query: string, config?: Config): DisclosureInfo`

Returns disclosure information for a query and configuration.

**Parameters:**
- `query` - SPARQL SELECT query string
- `config` - Optional configuration

**Returns:** Information about what will be disclosed vs. hidden in the proof

### Exported Types

- `SignedData` - Signed RDF dataset structure
- `ProveResult` - Proof generation result
- `VerifyResult` - Verification result
- `Config` - Configuration options
- `DisclosureInfo` - Disclosure information

For complete API documentation, see [spec/proofs.md](./spec/proofs.md).

## CLI Usage

For development and advanced usage, you can also use the CLI tools:

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

## Development Setup

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
git clone https://github.com/jeswr/sparql_noir
cd sparql_noir
npm install
npm run build
```

## SPARQL 1.0 Support

✅ **Comprehensive SPARQL 1.0 coverage achieved!**

All core SPARQL 1.0 features are now supported:

- **Query Forms**: SELECT, ASK
- **Graph Patterns**: BGP, UNION, OPTIONAL, GRAPH
- **Filters**: All comparison, equality, and logical operators
- **Functions**: isIRI, isBlank, isLiteral, STR, LANG, DATATYPE, LANGMATCHES, BOUND, sameTerm
- **Solution Modifiers**: DISTINCT, ORDER BY, LIMIT, OFFSET (via post-processing)

See [SPARQL_COVERAGE.md](./SPARQL_COVERAGE.md) for complete feature documentation.

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