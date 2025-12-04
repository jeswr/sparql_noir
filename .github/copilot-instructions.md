# Copilot Coding Agent Instructions

These instructions capture project-specific context so an AI agent can be immediately productive in this repo.

## Big Picture
- Purpose: Generate and verify zero-knowledge proofs of SPARQL query results using Noir circuits.
- Top-level components:
  - `transform/` (Rust crate): parses SPARQL, lowers to an assertion-based Noir function (`checkBinding`), emits Noir source and metadata.
  - `noir/` (Noir workspaces): multiple circuits under `bin/` and shared libs under `lib/` (hashes, types, signatures, utils).
  - `src/` (TypeScript): orchestration, encoding, signing, verification CLIs and utilities.
  - `inputs/` and `temp/`: sample RDF and generated inputs.

## Key Flows
- Circuit generation (Rust → Noir): `transform/src/main.rs` reads a SPARQL query and emits:
  - `noir_prove/src/sparql.nr`: Noir function that asserts variable bindings vs. BGP and filters.
  - `noir_prove/src/main.nr`: Noir entry templated from `template/main-verify.template.nr` with hash config substitutions.
  - `noir_prove/metadata.json`: variables, input patterns, optional patterns, union branches, hidden inputs, and path plans.
- Signing and verification (TypeScript + Noir):
  - `src/scripts/sign.ts`: signs data and prepares circuit inputs.
  - `src/scripts/verify.ts`: verifies inclusion/proofs against the generated circuits.
  - Benchmarks: `src/scripts/benchmarks/noir-benchmark.ts` drives build/run timings for circuits under `noir/bin/*`.

## Build & Run
- Prereqs:
  - Node.js + npm; Rust toolchain (`cargo`), Noir `nargo` matching README version.
  - Run `npm install` (executes `scripts/postinstall.js`).
- Common commands (macOS zsh):
  - Build everything:
    ```sh
    npm run build
    ```
  - End-to-end example (generate inputs, sign, verify):
    ```sh
    npm run e2e
    ```
  - Generate Noir files from SPARQL + RDF via Rust:
    ```sh
    npm run build:noir:gen
    ```
  - Individual circuit builds (via nargo):
    ```sh
    npm run build:signature
    ```
  - Benchmarks:
    ```sh
    npm run benchmark:list
    npm run benchmark:signature
    npm run benchmark:encode
    npm run benchmark:verify
    ```

## Conventions & Patterns
- Hash selection is controlled in `transform/src/main.rs` via `HASH` and `STRING_HASH` constants.
  - `hash2_name`/`hash4_name` and `string_hash_name` map to Noir functions; blake2s requires a generated `noir_prove/src/hash.nr` wrapper.
- Property paths: complex `GraphPattern::Path` are expanded to combinations of BGP/Join/Union/Extend with intermediate variables (`__v{n}`). See `expand_path` and `expand_path_to_plans`.
- Filters: `filter_to_noir` supports logical connectors, `SameTerm`, `=` and basic numeric/date comparisons via hidden inputs. EBV for literals is delegated to SPARQL evaluation.
- Optional (`LEFT JOIN`) handling: optional BGPs are tracked in metadata (`optionalPatterns`) but do not add assertions to the circuit.
- UNION: branches produce disjunctive assertions; code emits `branch_i` ANDs and asserts their OR.
- Metadata: emitted with both camelCase and snake_case keys for TS compatibility.

## Important Files
- `transform/src/main.rs`: core lowering from SPARQL to Noir, file emission.
- `transform/src/{encoding.rs,eval.rs,inputs.rs,merkle.rs,prover.rs}`: helpers for value encoding, evaluating bindings, preparing Noir inputs, Merkle logic, and Prover.toml emission.
- `src/{encode.ts,serializeProve.ts,mappings.ts,config.ts}`: TS-side encoding and configuration.
- `src/scripts/{sign.ts,verify.ts,setup.ts}`: CLIs for signing, verifying, and Noir setup.
- `noir/lib/*`: shared Noir libraries (hashes, signatures, types, utils); `noir/bin/*`: circuit packages (encode, signature, verify_inclusion).

## Integration Points
- Noir JS: `@noir-lang/noir_js` and `@noir-lang/noirc_abi` for compiling/running circuits from TS.
- Aztec backend: `@aztec/bb.js` used by benchmarks/tooling to run proofs.
- RDF tooling: `n3`, `rdf-dereference-store`, `rdfjs-c14n`, `rdf-string-ttl` handle RDF inputs and canonicalization.

## Gotchas
- Template dependency: `template/main-verify.template.nr` must exist; generation fails otherwise.
- Hash config mismatches: switching `HASH` to `blake2s` requires the generated `hash.nr` and proper Noir `std::hash::blake2s` availability.
- Query input: `--query` can be a raw string or a file path; defaults to `SELECT ?s ?p ?o WHERE { ?s ?p ?o . }`.
- Paths: emission targets are under `noir_prove/`; ensure directory exists or let generator create it.

## Example: Regenerate and Verify
```sh
# Generate circuit and metadata from sample inputs
npm run build:noir:gen

# Sign sample data and verify
npm run example:sign
npm run example:verify
```

Please review unclear sections (e.g., exact Noir template path, additional circuits in `noir/bin/*`) and share corrections so we can refine these instructions.
