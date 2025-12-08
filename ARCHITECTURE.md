# Architecture Plan: SPARQL-to-Noir Circuit Generation

This document describes the architecture for SPARQL-to-Noir circuit generation. The key design principle is **import over generation**: generated circuits import shared libraries from `noir/lib/` rather than generating configuration inline.

---

## Design Principles

1. **Import Pattern:** Generated circuits import from `noir/lib/` (consts, types, utils) rather than generating inline code
2. **Configuration in Libraries:** Hash/signature selection is configured in `noir/lib/consts/` via TypeScript setup
3. **Rust for Transform Only:** Rust handles SPARQL → Noir code generation; TypeScript handles signing, proving, verification
4. **Minimal Generation:** Only generate query-specific code (BGP patterns, constraints); reuse shared infrastructure

---

## Current State

### TypeScript (src/)
- `config.ts` - Configuration types (hash, signature, merkle depth)
- `encode.ts` - RDF term encoding functions
- `mappings.ts` - Hash/signature function mappings  
- `serializeProve.ts` - Proof serialization
- `scripts/sign.ts` - **Dataset signing (stays in TypeScript)**

### Rust (transform/)
- `main.rs` - SPARQL parsing, Noir code generation
- **No hash knowledge:** Generates references to `hash2()`, `hash4()`, `hash_string()` from `dep::consts`
- Hash selection happens at Noir compile time via `noir/lib/consts/`

### Noir (noir/)
- `lib/consts/` - Exports `hash2()`, `hash4()`, `hash_string()`, `MERKLE_DEPTH`, signature re-exports
- `lib/types/` - `Triple`, `Root`, `IndexedRoot`, `Proof` structs
- `lib/utils/` - `verify_inclusion()`, `verify_signature()`, `merkle()` functions
- `lib/signatures/` - Schnorr, secp256k1, secp256r1, babyjubjub, BLS implementations
- `lib/hashes/` - Poseidon2, keccak256 implementations
- `bin/` - Example circuits showing import pattern

---

## Implementation Status

### ✅ Already Implemented

| Component | Location | Status | Notes |
|-----------|----------|--------|-------|
| **Noir Libraries** | | | |
| `hash2()`, `hash4()`, `hash_string()` | `noir/lib/consts/src/lib.nr` | ✅ Complete | Pedersen default, configurable |
| `MERKLE_DEPTH` constant | `noir/lib/consts/src/lib.nr` | ✅ Complete | Default: 11 |
| Signature re-exports | `noir/lib/consts/src/lib.nr` | ✅ Complete | `pub use signature` |
| `Triple`, `Root`, `IndexedRoot`, `Proof` | `noir/lib/types/src/lib.nr` | ✅ Complete | All structs defined |
| `verify_signature()` | `noir/lib/utils/src/lib.nr` | ✅ Complete | Uses consts::signature |
| `verify_inclusion()` | `noir/lib/utils/src/lib.nr` | ✅ Complete | Merkle path verification |
| `merkle()` helper | `noir/lib/utils/src/lib.nr` | ✅ Complete | Tree construction |
| Schnorr signatures | `noir/lib/signatures/schnorr/` | ✅ Complete | Grumpkin curve |
| secp256k1 signatures | `noir/lib/signatures/secp256k1/` | ✅ Complete | ECDSA |
| secp256r1 signatures | `noir/lib/signatures/secp256r1/` | ✅ Complete | P-256 |
| BabyJubJub signatures | `noir/lib/signatures/babyjubjub/` | ✅ Complete | EdDSA |
| BLS signatures | `noir/lib/signatures/bls/` | ✅ Complete | BLS12-381 |
| Poseidon2 hash | `noir/lib/hashes/` | ✅ Complete | BN254 optimized |
| Example circuits | `noir/bin/signature/`, `noir/bin/verify_inclusion/` | ✅ Complete | Import pattern examples |
| **TypeScript** | | | |
| Dataset signing | `src/scripts/sign.ts` | ✅ Complete | Multi-scheme support |
| Signature verification | `src/scripts/verify.ts` | ✅ Complete | Proof generation/verification |
| RDF encoding | `src/encode.ts` | ✅ Complete | Term → Field encoding |
| Configuration types | `src/config.ts` | ✅ Complete | Hash/sig/depth types |
| **Rust Transform** | | | |
| SPARQL parsing | `transform/src/main.rs` | ✅ Complete | Via spargebra |
| BGP handling | `transform/src/main.rs` | ✅ Complete | `handle_patterns()` |
| JOIN support | `transform/src/main.rs` | ✅ Complete | Variable unification |
| UNION support | `transform/src/main.rs` | ✅ Complete | Branch indicators |
| FILTER support | `transform/src/main.rs` | ✅ Complete | `filter_to_noir()` |
| Property paths | `transform/src/main.rs` | ✅ Complete | `expand_path_to_plans()` |
| BIND/EXTEND | `transform/src/main.rs` | ✅ Complete | Variable binding |

### ⚠️ Needs Migration / Update

| Component | From | To | Required Changes |
|-----------|------|-----|------------------|
| **Hash function references** | `transform/src/main.rs` | Same file | Remove `HASH`, `STRING_HASH` constants and `hash2_name()`, `hash4_name()`, `string_hash_name()` functions. Generate `hash2()`, `hash_string()` as literal strings |
| **Nargo.toml generation** | Not implemented | `transform/src/main.rs` | Generate `Nargo.toml` with deps on `consts`, `types`, `utils` |
| **main.nr generation** | `legacy/template/main.template.nr` | `transform/src/main.rs` | Generate using `dep::*` imports instead of templates |
| **OPTIONAL support** | `legacy/transform/src/transform.ts` | `transform/src/main.rs` | Port LeftJoin handling from TypeScript |
| **Path normalization** | `legacy/transform/src/transform.ts` | `transform/src/main.rs` | Port `pathToBgp()` with depth limits |
| **Prove script** | `legacy/prove.js` | `src/scripts/prove.ts` | Modernize: TypeScript, use new circuit structure |
| **Encoding consistency** | `src/encode.ts` + `legacy/dist/encode.js` | Unified | Ensure TS and Rust produce identical encodings |

### 🆕 Needs Implementation from Scratch

| Component | Location | Priority | Description |
|-----------|----------|----------|-------------|
| **Setup script** | `src/scripts/setup.ts` | High | Generate `noir/lib/consts/src/lib.nr` from config, update `Nargo.toml` signature path |
| **Nargo.toml generation** | `transform/src/main.rs` | High | Generate `[dependencies]` with correct paths to `noir/lib/*` |
| **main.nr with imports** | `transform/src/main.rs` | High | Generate `use dep::consts::*`, `use dep::types::*`, `use dep::utils::*` |
| **sparql.nr generation** | `transform/src/main.rs` | High | Extract query-specific code into separate module |
| **prove.ts (modern)** | `src/scripts/prove.ts` | Medium | Full proof generation using new circuit structure |
| **CLI lib path arg** | `transform/src/main.rs` | Medium | `--lib-path` argument to specify `noir/lib/` location |
| **E2E test harness** | `tests/` | Medium | Automated setup → sign → transform → compile → prove → verify |
| **Recursive proofs** | `noir/lib/` | Low | Support for proof aggregation (types already have `HONK_*` constants) |
| **info command** | `transform/src/main.rs` or TypeScript | Low | Query analysis: what variables are disclosed, circuit size estimate |

### Legacy Code Reference

The `legacy/` directory contains working but outdated implementations:

| File | Contains | Migrate? |
|------|----------|----------|
| `legacy/sign.js` | Dataset signing with Merkle tree | ❌ Replaced by `src/scripts/sign.ts` |
| `legacy/prove.js` | Proof generation with bb.js | ⚠️ Port patterns to `src/scripts/prove.ts` |
| `legacy/keygen.js` | Key generation helpers | ⚠️ Useful utilities to keep |
| `legacy/transform/src/transform.ts` | SPARQL → algebra transformation | ⚠️ Port OPTIONAL/path handling to Rust |
| `legacy/transform/src/encode.ts` | RDF encoding functions | ⚠️ Reference for encoding consistency |
| `legacy/noir_prove/src/` | Generated circuit files | ❌ Reference only, don't migrate |
| `legacy/template/` | Noir templates | ❌ Replace with direct generation |

### Current Rust Hardcoded Values to Remove

```rust
// DELETE from transform/src/main.rs:
const STRING_HASH: &str = "blake3";
const HASH: &str = "pedersen";

fn hash2_name() -> &'static str { ... }     // DELETE
fn hash4_name() -> &'static str { ... }     // DELETE  
fn string_hash_name() -> &'static str { ... }  // DELETE

// REPLACE calls like:
format!("{}([...])", hash2_name())
// WITH:
"hash2([...])"
```

---

## Target Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    TypeScript (src/)                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ setup.ts    │  │ sign.ts     │  │ prove.ts / verify.ts    │  │
│  │ - Configure │  │ - Sign RDF  │  │ - Run nargo/bb.js       │  │
│  │   lib/consts│  │ - Merkle    │  │ - Generate witness      │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │                                      │
         ▼                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│ noir/lib/consts/    │          │    Rust Transform (transform/)  │
│ src/lib.nr          │◄─────────│  - SPARQL parsing               │
│ - hash2(), hash4()  │  imports │  - Noir code generation         │
│ - MERKLE_DEPTH      │          │  - BGP → constraint mapping     │
│ - pub use signature │          └─────────────────────────────────┘
└─────────────────────┘                         │
         ▲                                      │
         │                                      ▼
         │                        ┌─────────────────────────────────┐
         │                        │    Generated Circuit (output/)   │
         │                        │  ┌─────────────┐ ┌────────────┐ │
         └────────────────────────│  │ main.nr     │ │ sparql.nr  │ │
                     imports      │  │ use dep::*  │ │ BGP, vars  │ │
                                  │  └─────────────┘ └────────────┘ │
                                  │  ┌─────────────────────────────┐│
                                  │  │ Nargo.toml                  ││
                                  │  │ deps: consts, types, utils  ││
                                  │  └─────────────────────────────┘│
                                  └─────────────────────────────────┘
```

### Data Flow

```
1. setup.ts ──────► noir/lib/consts/src/lib.nr (configure hash/sig)
                           │
2. sign.ts ──────► SignedDataset { root, signature, merkle_proofs }
                           │
3. transform ──────► SPARQL query ──► Generated circuit
                           │
                    ┌──────┴──────┐
                    ▼             ▼
              main.nr        sparql.nr
              (uses deps)    (BGP patterns)
                    │
4. nargo compile ──► circuit artifacts
                    │
5. prove.ts ──────► witness + proof
                    │
6. verify.ts ──────► verification result
```

---

## Import Pattern (from existing noir/bin/)

### Example: noir/bin/signature/src/main.nr
```noir
use dep::types::Root;
use dep::utils::verify_signature;
use dep::consts::signature::PubKey;

fn main(root: Root, public_key: pub PubKey) {
    verify_signature(root.value, root.signature, public_key);
}
```

### Example: noir/bin/verify_inclusion/src/main.nr
```noir
use dep::types::Triple;
use dep::utils::verify_inclusion;

fn main(triple: Triple, root: pub Field) {
    assert(verify_inclusion(triple) == root);
}
```

### Example: noir/bin/signature/Nargo.toml
```toml
[package]
name = "signature"
type = "bin"

[dependencies]
utils = { path = "../../lib/utils" }
types = { path = "../../lib/types" }
consts = { path = "../../lib/consts" }
```

---

## Generated Circuit Structure

### Nargo.toml (generated)
```toml
[package]
name = "sparql_proof"
type = "bin"
authors = [""]

[dependencies]
consts = { path = "../noir/lib/consts" }
types = { path = "../noir/lib/types" }
utils = { path = "../noir/lib/utils" }
```

### src/main.nr (generated)
```noir
mod sparql;

use dep::types::{Triple, IndexedRoot};
use dep::utils::{verify_inclusion, verify_signature};
use dep::consts::signature::PubKey;
use dep::consts::MERKLE_DEPTH;

use sparql::{BGP, Variables, check_binding};

fn main(
    public_keys: [PubKey; 1],
    roots: [IndexedRoot; 1],
    bgp: BGP,
    variables: pub Variables
) {
    // Verify signatures on all roots
    for root in roots {
        verify_signature(root.value, root.signature, public_keys[root.key_index]);
    }

    // Verify inclusion of all triples
    for triple in bgp {
        assert(verify_inclusion(triple) == roots[0].value);
    }

    // Check SPARQL constraints and bindings
    check_binding(bgp, variables);
}
```

### src/sparql.nr (generated - query-specific)
```noir
use dep::consts::{hash2, hash4, hash_string, MERKLE_DEPTH};
use dep::types::Triple;

// Type aliases for this specific query
type BGP = [Triple<MERKLE_DEPTH>; 3];
type Variables = [Field; 2];

// Encode static terms used in query
fn encode_foaf_name() -> Field {
    hash2([0, hash_string("http://xmlns.com/foaf/0.1/name")])
}

fn encode_foaf_knows() -> Field {
    hash2([0, hash_string("http://xmlns.com/foaf/0.1/knows")])
}

// Check that BGP satisfies query constraints and produces variables
fn check_binding(bgp: BGP, variables: Variables) {
    // Triple 0: ?person foaf:name ?name
    assert(bgp[0].terms[1] == encode_foaf_name());
    
    // Triple 1: ?person foaf:knows ?friend
    assert(bgp[1].terms[1] == encode_foaf_knows());
    
    // Variable unification: bgp[0].s == bgp[1].s (same ?person)
    assert(bgp[0].terms[0] == bgp[1].terms[0]);
    
    // Output bindings
    assert(variables[0] == bgp[0].terms[2]); // ?name
    assert(variables[1] == bgp[1].terms[2]); // ?friend
}
```

---

## Phase 1: Configure lib/consts via Setup Script

### Goal
Create TypeScript setup script that configures `noir/lib/consts/` based on user preferences.

### Implementation

#### 1.1 Create `src/scripts/setup.ts`

```typescript
import * as fs from 'fs';
import * as path from 'path';

interface Config {
  hash: 'pedersen' | 'poseidon2' | 'blake2s' | 'mimc';
  stringHash: 'blake3' | 'sha256' | 'blake2s';
  signature: 'schnorr' | 'secp256k1' | 'secp256r1' | 'babyjubjub' | 'bls';
  merkleDepth: number;
}

const HASH_IMPLEMENTATIONS: Record<string, string> = {
  pedersen: 'std::hash::pedersen_hash',
  poseidon2: 'dep::hashes::poseidon2::bn254::hash',
  blake2s: 'std::hash::blake2s',
  mimc: 'dep::mimc::mimc_bn254',
};

function generateConstsLib(config: Config): string {
  return `// Generated by setup.ts - do not edit manually
// Configuration: hash=${config.hash}, signature=${config.signature}, merkleDepth=${config.merkleDepth}

pub mod signature {
    pub use dep::signature::PubKey;
    pub use dep::signature::verify;
}

global MERKLE_DEPTH: u32 = ${config.merkleDepth};

pub fn hash2(input: [Field; 2]) -> Field {
    ${HASH_IMPLEMENTATIONS[config.hash]}(input)
}

pub fn hash4(input: [Field; 4]) -> Field {
    ${HASH_IMPLEMENTATIONS[config.hash]}(input)
}

pub fn hash_string<let N: u32>(s: str<N>) -> Field {
    Field::from_le_bytes(std::hash::${config.stringHash}(s.as_bytes()))
}
`;
}

// Usage: npx ts-node src/scripts/setup.ts --hash pedersen --sig schnorr --depth 11
```

#### 1.2 Update `noir/lib/consts/Nargo.toml`

The Nargo.toml's `signature` dependency path changes based on selected scheme:

```toml
[dependencies]
# Conditionally included based on setup
signature = { path = "../signatures/schnorr" }  # or babyjubjub, secp256k1, etc.
```

---

## Phase 2: Update Rust Transform (Hash-Agnostic)

### Goal
Rust generates Noir code that references `hash2()`, `hash4()`, `hash_string()` from `dep::consts`. **Rust has zero knowledge of which hash is used** - the actual hash implementation is selected when Noir compiles.

### Key Principle

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│   Rust Transform    │     │  Generated Noir     │     │  noir/lib/consts    │
│                     │     │                     │     │                     │
│ Generates:          │ ──► │ hash2([...])        │ ──► │ Resolves to:        │
│ "hash2([...])"      │     │ hash_string("...")  │     │ pedersen/poseidon/  │
│ "hash_string(...)"  │     │                     │     │ blake2s at compile  │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
```

### Implementation

#### 2.1 Rust Code Generation (hash-agnostic)

Rust simply generates string literals referencing the consts functions:

```rust
// Rust generates Noir code - no hash knowledge needed
fn string_to_field_expr(s: &str) -> String {
    format!("hash_string(\"{}\")", s.replace('"', "\\\""))
}

fn hash2_expr(args: &str) -> String {
    format!("hash2({})", args)
}

fn hash4_expr(args: &str) -> String {
    format!("hash4({})", args)
}

// Example: encoding a NamedNode
fn encode_named_node(uri: &str) -> String {
    format!("hash2([0, hash_string(\"{}\")])"  uri)
}
```

#### 2.2 Remove ALL Hash Configuration from Rust

```rust
// DELETE everything related to hash selection:
const STRING_HASH: &str = "blake3";      // DELETE
const HASH: &str = "pedersen";           // DELETE
fn hash2_name() -> &'static str { ... }  // DELETE  
fn hash4_name() -> &'static str { ... }  // DELETE
fn string_hash_name() -> &'static str { ... }  // DELETE
```

#### 2.3 Generate Nargo.toml with Dependencies

```rust
fn generate_nargo_toml(lib_path: &str) -> String {
    format!(r#"[package]
name = "sparql_proof"
type = "bin"
authors = [""]

[dependencies]
consts = {{ path = "{lib_path}/consts" }}
types = {{ path = "{lib_path}/types" }}
utils = {{ path = "{lib_path}/utils" }}
"#)
}
```

### Why This Matters

1. **Single source of truth:** Hash selection is only in `noir/lib/consts/src/lib.nr`
2. **No Rust changes for new hashes:** Adding a new hash only requires updating `setup.ts` and `consts`
3. **Compile-time resolution:** Hash is selected when `nargo compile` runs, not when Rust runs

---

## Phase 3: TypeScript Pipeline Integration

### Goal
Integrate Rust transform with TypeScript sign/prove/verify scripts.

### Implementation

#### 3.1 Update `package.json`

```json
{
  "scripts": {
    "setup": "ts-node src/scripts/setup.ts",
    "sign": "ts-node src/scripts/sign.ts",
    "transform": "cargo run --manifest-path transform/Cargo.toml --",
    "prove": "ts-node src/scripts/prove.ts",
    "verify": "ts-node src/scripts/verify.ts",
    "e2e": "npm run setup && npm run sign && npm run transform -- -q inputs/sparql.rq -d inputs/data/data.ttl -o output && npm run prove && npm run verify"
  }
}
```

#### 3.2 Workflow

```
1. npm run setup -- --hash pedersen --sig babyjubjub --depth 11
   └─► Configures noir/lib/consts/src/lib.nr

2. npm run sign -- --data inputs/data.ttl --key keypair.json --out signed.json
   └─► Creates SignedDataset with merkle proofs

3. npm run transform -- -q inputs/sparql.rq -o output
   └─► Generates output/src/main.nr and output/src/sparql.nr

4. cd output && nargo compile
   └─► Compiles circuit

5. npm run prove -- --circuit output --signed signed.json --out proof.json
   └─► Generates ZK proof

6. npm run verify -- --proof proof.json
   └─► Verifies proof
```

---

## Phase 4: Future Rust Expansion (Deferred)

When cargo package bindings are added, Rust can take over more functionality:

### 4.1 `sign` Subcommand
```rust
// Future: transform/src/sign.rs
pub fn sign_dataset(dataset: &str, keypair: &KeyPair) -> SignedDataset
```

### 4.2 `prove` Subcommand  
```rust
// Future: transform/src/prove.rs
pub fn prove(query: &str, signed: &SignedDataset) -> Proof
```

### 4.3 `verify` Subcommand
```rust
// Future: transform/src/verify.rs
pub fn verify(proof: &Proof) -> bool
```

### 4.4 WASM Bindings
```rust
// Future: transform/src/lib.rs
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn sign_dataset_wasm(dataset: &str, keypair: &str) -> String
```

---

## Directory Structure

```
sparql_noir/
├── transform/                    # Rust: SPARQL → Noir ONLY
│   ├── Cargo.toml
│   └── src/
│       └── main.rs               # SPARQL parsing, Noir generation
├── noir/
│   ├── lib/                      # Shared libraries (imported by generated circuits)
│   │   ├── consts/               # hash2, hash4, hash_string, MERKLE_DEPTH, signature
│   │   │   ├── Nargo.toml        # Dependencies include signature path
│   │   │   └── src/lib.nr        # Configurable via setup.ts
│   │   ├── types/                # Triple, Root, IndexedRoot, Proof
│   │   ├── utils/                # verify_inclusion, verify_signature, merkle
│   │   ├── signatures/           # schnorr, secp256k1, secp256r1, babyjubjub, bls
│   │   └── hashes/               # poseidon2, keccak256
│   └── bin/                      # Standalone utility circuits (examples)
├── src/                          # TypeScript: signing, proving, verification
│   ├── config.ts
│   ├── encode.ts
│   └── scripts/
│       ├── setup.ts              # Configure noir/lib/consts
│       ├── sign.ts               # Sign RDF datasets
│       ├── prove.ts              # Generate proofs
│       └── verify.ts             # Verify proofs
├── spec/                         # Specification documents
└── inputs/                       # Example data and queries
```

---

## Implementation Plan

### Step-by-Step Execution Order

Execute these tasks in order. Each step has verification criteria that must pass before moving to the next.

---

### Step 1: Clean Up Rust Hash References (Day 1)

**Goal:** Make `transform/src/main.rs` hash-agnostic.

**Tasks:**
1. Delete these lines from `main.rs`:
   ```rust
   const STRING_HASH: &str = "blake3";
   const HASH: &str = "pedersen";
   ```
2. Delete these functions:
   - `hash2_name()`
   - `hash4_name()`
   - `string_hash_name()`
3. Replace all usages with literal function names:
   - `format!("{}(...)", hash2_name())` → `"hash2(...)"`
   - `format!("{}(...)", string_hash_name())` → `"hash_string(...)"`
4. Find all patterns like `format!("dep::hashes::{}(...)", ...)` and replace with `"hash2(...)"` or `"hash_string(...)"`

**Verify:**
```sh
cargo build --manifest-path transform/Cargo.toml
grep -rn "pedersen\|blake3" transform/src/  # Should return nothing
```

---

### Step 2: Update Generated Circuit Imports (Day 1-2)

**Goal:** Generated circuits use `dep::consts`, `dep::types`, `dep::utils`.

**Tasks:**
1. Update `main.rs` to generate `main.nr` with these imports:
   ```noir
   use dep::types::{Triple, IndexedRoot};
   use dep::utils::{verify_inclusion, verify_signature};
   use dep::consts::{hash2, hash4, hash_string, MERKLE_DEPTH};
   use dep::consts::signature::PubKey;
   ```
2. Update `main.rs` to generate `sparql.nr` with:
   ```noir
   use dep::consts::{hash2, hash4, hash_string, MERKLE_DEPTH};
   use dep::types::Triple;
   ```
3. Remove any inline hash function generation in Rust

**Verify:**
```sh
cargo run --manifest-path transform/Cargo.toml -- -q inputs/sparql.rq -d inputs/data/data.ttl -o output
grep "dep::consts" output/src/main.nr    # Should find imports
grep "pedersen\|blake3" output/src/*.nr  # Should return nothing
```

---

### Step 3: Generate Nargo.toml with Dependencies (Day 2)

**Goal:** Transform generates `Nargo.toml` that links to `noir/lib/`.

**Tasks:**
1. Add function to `main.rs`:
   ```rust
   fn generate_nargo_toml(output_dir: &str, lib_path: &str) -> String {
       // Generate Nargo.toml with deps pointing to lib_path
   }
   ```
2. CLI argument for library path: `--lib-path ../noir/lib`
3. Generate `Nargo.toml` alongside `src/main.nr`

**Verify:**
```sh
cargo run --manifest-path transform/Cargo.toml -- -q inputs/sparql.rq -d inputs/data/data.ttl -o output --lib-path ../noir/lib
cat output/Nargo.toml  # Should show dependencies to noir/lib/*
cd output && nargo check  # Should pass
```

---

### Step 4: Create setup.ts Configuration Script (Day 2-3)

**Goal:** TypeScript script configures `noir/lib/consts/src/lib.nr`.

**Tasks:**
1. Create `src/scripts/setup.ts` with:
   - CLI args: `--hash`, `--sig`, `--depth`
   - Generate `noir/lib/consts/src/lib.nr` content
   - Update `noir/lib/consts/Nargo.toml` signature dependency
2. Hash options: `pedersen`, `poseidon2`
3. Signature options: `schnorr`, `secp256k1`, `secp256r1`, `babyjubjub`, `bls`
4. Default: `pedersen`, `schnorr`, depth `11`

**Verify:**
```sh
npx ts-node src/scripts/setup.ts --hash poseidon2 --sig secp256k1 --depth 11
grep "poseidon2" noir/lib/consts/src/lib.nr    # Should find hash impl
grep "secp256k1" noir/lib/consts/Nargo.toml     # Should find sig dependency
cd noir/lib/consts && nargo check               # Should pass
```

---

### Step 5: Update prove.ts and verify.ts (Day 3-4)

**Goal:** Working prove and verify scripts using bb.js.

**Tasks:**
1. Review `legacy/prove.js` for patterns to port
2. Create/update `src/scripts/prove.ts`:
   - Load compiled circuit
   - Load signed dataset
   - Generate witness
   - Create proof using bb.js
3. Update `src/scripts/verify.ts`:
   - Load proof
   - Verify using bb.js
   - Return verification result

**Verify:**
```sh
npm run prove -- --circuit output --signed signed.json --out proof.json
npm run verify -- --proof proof.json  # Should output: Verified: true
```

---

### Step 6: Port OPTIONAL/UNION Handling to Rust (Day 4-5)

**Goal:** Full SPARQL pattern support in Rust transform.

**Tasks:**
1. Review `legacy/transform/src/transform.ts` for OPTIONAL handling
2. Port OPTIONAL pattern to `main.rs`:
   - Generate `is_matched` boolean field
   - Conditional constraint application
3. Port UNION pattern:
   - Generate branch indicator
   - Disjunctive constraints
4. Ensure property paths work with new import pattern

**Verify:**
```sh
# Test with OPTIONAL query
echo "SELECT ?name WHERE { ?s a ?type . OPTIONAL { ?s foaf:name ?name } }" > test_optional.rq
cargo run --manifest-path transform/Cargo.toml -- -q test_optional.rq -o output
cd output && nargo compile
```

---

### Step 7: E2E Integration Test (Day 5-6)

**Goal:** Complete pipeline works end-to-end.

**Tasks:**
1. Update `package.json` with all scripts
2. Create test fixtures in `inputs/`
3. Create E2E test script that runs:
   ```sh
   npm run setup -- --hash pedersen --sig schnorr --depth 11
   npm run sign -- --data inputs/data/data.ttl --out signed.json
   npm run transform -- -q inputs/sparql.rq -o output --lib-path noir/lib
   cd output && nargo compile
   npm run prove -- --circuit output --signed signed.json --out proof.json
   npm run verify -- --proof proof.json
   ```
4. Verify proof validates and disclosed variables are correct

**Verify:**
```sh
npm run e2e  # Should complete without errors
```

---

### Step 8: Documentation and Cleanup (Day 6-7)

**Goal:** Clean codebase, accurate documentation.

**Tasks:**
1. Update README.md with new workflow
2. Remove dead code from transform/src/main.rs
3. Archive legacy/ (don't delete yet)
4. Add JSDoc/rustdoc comments
5. Update spec/ documents if implementation deviated

**Verify:**
- README instructions work from scratch
- No unused imports or dead code warnings
- `npm run build` completes without errors

---

## Implementation Checklist

### Phase 1: Setup Script
- [ ] Create `src/scripts/setup.ts`
- [ ] Generate `noir/lib/consts/src/lib.nr` from config
- [ ] Update `noir/lib/consts/Nargo.toml` signature dependency path
- [ ] Test: setup → nargo check on lib/consts

### Phase 2: Transform Updates (Hash-Agnostic)
- [ ] Remove ALL hash-related constants and functions from `main.rs`
- [ ] Generate code using literal strings: `"hash2(...)"`, `"hash_string(...)"`
- [ ] Generate `Nargo.toml` with correct dependency paths
- [ ] Generate `main.nr` using `dep::*` imports
- [ ] Verify: Rust has zero knowledge of hash implementations
- [ ] Test: transform → nargo compile → success

### Phase 3: Pipeline Integration
- [ ] Create `src/scripts/prove.ts`
- [ ] Create `src/scripts/verify.ts`
- [ ] Update `package.json` scripts
- [ ] E2E test: setup → sign → transform → compile → prove → verify

### Phase 4 (Deferred): Rust Expansion
- [ ] Add `sign` subcommand when cargo bindings available
- [ ] Add `prove` subcommand when cargo bindings available
- [ ] Add WASM bindings
- [ ] Publish to crates.io and npm

---

## Testing Strategy

1. **Unit tests:** TypeScript encode/sign functions, Rust SPARQL parsing
2. **Integration tests:** Setup → Transform → Compile cycle
3. **E2E tests:** Full sign → prove → verify pipeline
4. **Benchmark tests:** Compare hash function performance
5. **Regression tests:** Ensure generated circuits match expected output

---

## Success Criteria

1. **Generated circuits import from `noir/lib/`** - no inline hash/signature code
2. **Rust is hash-agnostic** - generates `hash2()`, `hash_string()` references, resolved at Noir compile time
3. **Configuration via setup.ts** - hash/signature/depth selectable in `noir/lib/consts/`
4. **Rust does transform only** - no signing/proving in Rust until cargo bindings
5. **TypeScript handles execution** - sign.ts, prove.ts, verify.ts work end-to-end
6. **Single source of truth** - hash selection only exists in `noir/lib/consts/src/lib.nr`
