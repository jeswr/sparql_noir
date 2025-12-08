# Copilot Coding Agent Instructions

Project-specific context for AI agents working in this repo.

## Purpose

Generate zero-knowledge proofs that SPARQL query results are correct, without revealing the underlying signed RDF datasets.

**Core workflow:** `setup` → `sign` → `transform` → `compile` → `prove` → `verify`

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    TypeScript (src/scripts/)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ setup.ts    │  │ sign.ts     │  │ prove.ts / verify.ts    │  │
│  │ - Configure │  │ - Sign RDF  │  │ - Generate witness      │  │
│  │   lib/consts│  │ - Merkle    │  │ - Run nargo/bb.js       │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ Rust Transform (transform/)     │    noir/lib/ (shared libs)    │
│ - SPARQL parsing (spargebra)    │    ├── consts/ (hash config)  │
│ - Noir code generation          │    ├── types/ (Triple, Root)  │
│ - BGP → constraint mapping      │    ├── utils/ (merkle, sig)   │
│ - ZERO hash knowledge           │    └── signatures/*           │
│ - Generates "hash2(...)"        │                               │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              Generated Circuit (output/)                         │
│  ┌─────────────────────┐  ┌─────────────────────────────────┐   │
│  │ Nargo.toml          │  │ src/main.nr + src/sparql.nr     │   │
│  │ deps: consts, types │  │ use dep::consts::hash2;         │   │
│  │       utils         │  │ use dep::types::Triple;         │   │
│  └─────────────────────┘  └─────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
sparql_noir/
├── transform/              # Rust: SPARQL → Noir (ONLY transform, zero hash knowledge)
│   ├── Cargo.toml
│   └── src/main.rs         # SPARQL parsing, Noir code generation
├── noir/
│   ├── lib/                # Shared libraries (imported by generated circuits)
│   │   ├── consts/         # hash2, hash4, hash_string, MERKLE_DEPTH, signature
│   │   ├── types/          # Triple, Root, IndexedRoot, Proof structs
│   │   ├── utils/          # verify_inclusion, verify_signature, merkle
│   │   ├── signatures/     # schnorr, secp256k1, secp256r1, babyjubjub, bls
│   │   └── hashes/         # poseidon2, keccak256
│   └── bin/                # Standalone utility circuits (examples)
│       ├── encode/
│       ├── signature/
│       └── verify_inclusion/
├── src/                    # TypeScript: signing, proving, verification
│   ├── config.ts
│   ├── encode.ts
│   ├── mappings.ts
│   └── scripts/
│       ├── setup.ts        # Configure noir/lib/consts (🆕 to create)
│       ├── sign.ts         # Sign RDF datasets (✅ complete)
│       ├── prove.ts        # Generate proofs (⚠️ needs update)
│       └── verify.ts       # Verify proofs (✅ complete)
├── spec/                   # Specification documents
│   ├── encoding.md         # RDF term → Field encoding
│   ├── algebra.md          # SPARQL pattern → Noir constraint mapping
│   ├── proofs.md           # API: sign(), prove(), verify()
│   ├── disclosure.md       # What proofs reveal vs hide
│   └── config.md           # Configurable parameters
├── legacy/                 # Old implementations (reference only)
└── inputs/                 # Example data and queries
```

## Key Design Principle: Import Over Generation

**Generated circuits MUST import from `noir/lib/`, never inline hash/signature code.**

The Rust transform generates Noir code with function calls like `hash2(...)`, `hash_string(...)`. These resolve to actual implementations at **Noir compile time** based on what's configured in `noir/lib/consts/src/lib.nr`.

```
Rust generates:     "hash2([x, y])"           ← String literal, no hash knowledge
Noir resolves to:   pedersen_hash([x, y])     ← Resolved at compile time
```

## Implementation Status

### ✅ Complete

| Component | Location | Notes |
|-----------|----------|-------|
| Noir shared libs | `noir/lib/*` | consts, types, utils, signatures, hashes |
| Sign script | `src/scripts/sign.ts` | Multi-scheme signing |
| Verify script | `src/scripts/verify.ts` | bb.js verification |
| Rust SPARQL parsing | `transform/src/main.rs` | BGP, JOIN, FILTER, paths |
| Specification docs | `spec/*` | Encoding, algebra, proofs, disclosure, config |

### ⚠️ Needs Migration

| Task | Current State | Target |
|------|--------------|--------|
| Remove hash refs in Rust | Has `HASH`, `STRING_HASH` consts | Generate literal `"hash2(...)"` |
| Generate Nargo.toml | Not generated | Include deps to `noir/lib/*` |
| OPTIONAL support | In legacy TS | Port to Rust |

### 🆕 Needs Implementation

| Task | Location | Reference |
|------|----------|-----------|
| setup.ts | `src/scripts/setup.ts` | Configure `noir/lib/consts/` |
| prove.ts update | `src/scripts/prove.ts` | Port from `legacy/prove.js` |
| E2E test | `package.json` | Full pipeline test |

## Key Files Reference

### Rust Transform (`transform/src/main.rs`)

**Purpose:** Parse SPARQL, generate Noir circuit code.

**Key functions:**
- `handle_patterns()` - Process SPARQL algebra patterns
- `filter_to_noir()` - Convert FILTER to Noir constraints
- `expand_path_to_plans()` - Property path expansion

**CRITICAL:** Rust has ZERO hash implementation knowledge. It generates string literals:
```rust
// CORRECT - generates function reference
format!("hash2([{}, {}])", a, b)

// WRONG - hardcodes hash name (remove these)
format!("{}([{}, {}])", hash_name, a, b)
```

**What to remove:**
```rust
const STRING_HASH: &str = "blake3";      // DELETE
const HASH: &str = "pedersen";           // DELETE
fn hash2_name() -> &'static str { ... }  // DELETE
```

### Noir Libraries (`noir/lib/`)

**consts/src/lib.nr:**
```noir
global MERKLE_DEPTH: u32 = 11;

pub fn hash2(input: [Field; 2]) -> Field {
    std::hash::pedersen_hash(input)  // Configurable via setup.ts
}

pub fn hash4(input: [Field; 4]) -> Field {
    std::hash::pedersen_hash(input)
}

pub fn hash_string<let N: u32>(s: str<N>) -> Field {
    Field::from_le_bytes(std::hash::blake3(s.as_bytes()))
}

pub mod signature {
    pub use dep::signature::*;  // Re-export selected scheme
}
```

**types/src/lib.nr:**
```noir
pub struct Triple<let DEPTH: u32> {
    pub terms: [Field; 4],           // s, p, o, g encoded
    pub path: [Field; DEPTH],        // Merkle proof path
    pub directions: [bool; DEPTH],   // Path directions
}

pub struct Root {
    pub value: Field,
    pub signature: [Field; 64],
}

pub struct IndexedRoot {
    pub value: Field,
    pub signature: [Field; 64],
    pub key_index: u32,
}
```

**utils/src/lib.nr:**
```noir
use crate::consts::{hash2, hash4, MERKLE_DEPTH};

pub fn verify_inclusion<let DEPTH: u32>(triple: Triple<DEPTH>) -> Field {
    let leaf = hash4(triple.terms);
    merkle(leaf, triple.path, triple.directions)
}

pub fn merkle<let N: u32>(leaf: Field, path: [Field; N], directions: [bool; N]) -> Field {
    // Compute Merkle root using hash2
}
```

### TypeScript Scripts (`src/scripts/`)

**sign.ts:** Signs RDF datasets with Merkle tree + signature (complete).

**prove.ts:** Generate ZK proof using bb.js (needs update for new circuit structure).

**verify.ts:** Verify proof using bb.js (complete).

**setup.ts (to create):** Configure `noir/lib/consts/` for hash/signature/depth selection.

### Generated Circuit Structure

**Nargo.toml:**
```toml
[package]
name = "sparql_proof"
type = "bin"

[dependencies]
consts = { path = "../noir/lib/consts" }
types = { path = "../noir/lib/types" }
utils = { path = "../noir/lib/utils" }
```

**src/main.nr:**
```noir
mod sparql;
use dep::types::{Triple, IndexedRoot};
use dep::utils::{verify_inclusion, verify_signature};
use dep::consts::signature::PubKey;

fn main(
    public_keys: [PubKey; 1],
    roots: [IndexedRoot; 1],
    bgp: BGP,
    variables: pub Variables
) {
    // Verify signatures, inclusion, and SPARQL constraints
}
```

**src/sparql.nr:** Query-specific BGP patterns and constraints.

## Encoding (from spec/encoding.md)

```
Enc_t(term) = hash2([type_code, value_encoding])
Enc_Q(s,p,o,g) = hash4([Enc_t(s), Enc_t(p), Enc_t(o), Enc_t(g)])
```

| Term Type | Code |
|-----------|------|
| NamedNode | 0 |
| BlankNode | 1 |
| Literal | 2 |
| Variable | 3 |
| DefaultGraph | 4 |

## SPARQL → Noir Mapping (from spec/algebra.md)

| SPARQL | Noir Circuit |
|--------|--------------|
| BGP triple | Merkle inclusion proof + binding assertions |
| JOIN | Multiple patterns with variable unification |
| UNION | Branch indicators with disjunctive constraints |
| OPTIONAL | Conditional matching with `is_matched` flag |
| FILTER (`=`) | RDFterm-equal: `a == b` (value equality) |
| FILTER (`sameTerm`) | RDF identity: same encoded value |
| Property paths | Bounded expansion to UNION of BGP sequences |

## Configuration Defaults (from spec/config.md)

| Parameter | Default | Notes |
|-----------|---------|-------|
| `hash2`, `hash4` | pedersen_hash | Term/triple encoding |
| `hash_string` | blake3 | String → Field |
| Signature | Schnorr/Grumpkin | Noir native |
| MERKLE_DEPTH | 11 | Max 2048 triples |
| PATH_SEGMENT_MAX | 8 | Max path hops |

## Supported SPARQL Features

| Feature | Status |
|---------|--------|
| SELECT | ✅ |
| BGP | ✅ |
| JOIN | ✅ |
| UNION | ✅ |
| OPTIONAL | ⚠️ Needs Rust port |
| FILTER (equality, comparison) | ✅ |
| BIND/EXTEND | ✅ |
| Property Paths (+, *, ?, /, \|, ^) | ✅ |
| DISTINCT, LIMIT | ⚠️ Post-processing |
| GROUP BY, aggregates | ❌ Deferred |

## Disclosure Model (from spec/disclosure.md)

**Always disclosed:** Query, public keys, signature scheme, merkle depth

**Disclosed by SELECT:** Variable bindings (determined by SELECT clause)

**Never disclosed:** Merkle roots, signatures, dataset content

## Build & Run

```sh
# Prerequisites: Node.js, Rust, nargo (Noir 1.0.0-beta.12)
npm install

# Configure hash/signature/depth
npm run setup -- --hash pedersen --sig schnorr --depth 11

# Sign RDF dataset
npm run sign -- --data inputs/data/data.ttl --out signed.json

# Generate Noir circuit from SPARQL
npm run transform -- -q inputs/sparql.rq -o output

# Compile circuit
cd output && nargo compile

# Generate and verify proof
npm run prove -- --circuit output --signed signed.json --out proof.json
npm run verify -- --proof proof.json
```

## Dependencies

- **Rust:** spargebra, spareval, clap, serde_json
- **Noir:** std::hash (pedersen, blake3), poseidon2 (optional)
- **TypeScript:** n3, @noir-lang/noir_js, @aztec/bb.js

## Development Workflow

1. **Read spec/** before making changes to understand formal semantics
2. **Rust transform is hash-agnostic** - never add hash implementation details
3. **Generated circuits import** - never generate inline hash code
4. **Test with `nargo check`** after any Noir library changes
5. **Run E2E** after changes to validate full pipeline
