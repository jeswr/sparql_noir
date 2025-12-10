# Test Infrastructure

This directory contains test infrastructure for verifying the SPARQL→Noir transform generates correct circuit code.

## Directory Structure

```
test/
├── README.md                  # This file
├── run-snapshot-tests.ts      # TypeScript test runner for snapshots
├── generate-circuit-tests.ts  # Generate circuit tests from W3C test suite
├── fixtures/                  # Snapshot test fixtures
│   ├── basic_bgp/
│   │   ├── query.rq           # Input SPARQL query
│   │   └── expected.nr        # Expected sparql.nr output
│   ├── static_predicate/
│   ├── filter_inequality/
│   └── filter_comparison/
└── circuits/                  # Circuit validity tests
    └── sparql11/              # Generated from W3C SPARQL 1.1 test suite
        ├── bind/              # BIND tests
        ├── property-path/     # Property path tests
        ├── sparql10-basic/    # SPARQL 1.0 basic tests
        ├── sparql10-triple-match/
        ├── sparql10-optional/
        ├── sparql10-algebra/
        ├── sparql10-expr-equals/
        └── sparql10-distinct/
```

## Running Tests

### Rust Snapshot Tests (Recommended)

The primary test infrastructure is in Rust. Run from the repo root:

```bash
# Run all transform tests
cargo test --manifest-path transform/Cargo.toml

# Run only snapshot tests
cargo test --manifest-path transform/Cargo.toml -- snapshot_

# Run only assertion tests  
cargo test --manifest-path transform/Cargo.toml -- test_variables test_static test_filter
```

### TypeScript Test Runner

The TypeScript runner provides a convenient wrapper:

```bash
# Run all tests (both Rust and TS)
npx tsx test/run-snapshot-tests.ts

# Run only TypeScript tests
npx tsx test/run-snapshot-tests.ts --ts-only

# Run only Rust tests
npx tsx test/run-snapshot-tests.ts --rust-only

# Update expected.nr files from current transform output
npx tsx test/run-snapshot-tests.ts --update --ts-only
```

## Test Categories

### 1. Snapshot Tests

Each fixture contains:
- `query.rq`: A SPARQL query
- `expected.nr`: The expected `sparql.nr` output

Tests verify the generated `sparql.nr` exactly matches the expected output.

### 2. Assertion Tests

In `transform/src/main.rs`, these tests verify specific behaviors:
- `test_variables_struct_only_projected`: Variables struct contains only SELECT vars
- `test_static_predicate_assertion`: Static predicates generate assertions
- `test_filter_inequality_generates_noir`: FILTER(?x != ?y) generates Noir code
- `test_filter_comparison_generates_noir`: FILTER(?x > 3) generates Noir with hidden inputs

### 3. IEEE 754 Tests

Tests for IEEE 754 compliance with special float values:
- `test_ieee754_less_than_nan`: NaN comparisons return false
- `test_ieee754_less_than_infinity`: INF ordering
- `test_ieee754_equal_nan`: NaN != NaN
- `test_ieee754_equal_zero`: +0 == -0

## Adding New Test Fixtures

1. Create a new directory under `test/fixtures/`:
   ```bash
   mkdir test/fixtures/my_new_test
   ```

2. Add `query.rq` with the SPARQL query:
   ```sparql
   PREFIX ex: <http://example.org/>
   SELECT ?s ?o WHERE { ?s ex:prop ?o . }
   ```

3. Generate the expected output:
   ```bash
   cargo run --manifest-path transform/Cargo.toml -- -q "$(cat test/fixtures/my_new_test/query.rq)"
   cp noir_prove/src/sparql.nr test/fixtures/my_new_test/expected.nr
   ```

4. Add a Rust test in `transform/src/main.rs`:
   ```rust
   #[test]
   fn snapshot_my_new_test() {
       run_snapshot_test("my_new_test");
   }
   ```

## Common Bugs These Tests Catch

| Bug | Test That Catches It |
|-----|---------------------|
| Variables struct has non-projected vars | `snapshot_*`, `test_variables_struct_only_projected` |
| Missing static predicate assertion | `snapshot_static_predicate`, `test_static_predicate_assertion` |
| Missing filter constraint | `snapshot_filter_*`, `test_filter_*_generates_noir` |
| Filter evaluated in Rust, not Noir | `test_filter_comparison_generates_noir` |
| IEEE 754 handled incorrectly | `test_ieee754_*` |

## Circuit Validity Tests

The `test/circuits/sparql11/` directory contains tests generated from the W3C SPARQL 1.1 test suite.

### Generating Circuit Tests

```bash
# Generate tests from all supported categories
npm run test:circuits:generate

# List available tests
npm run test:circuits:list

# Preview without writing files
npm run test:circuits:dry-run

# Generate for specific category
npx tsx test/generate-circuit-tests.ts -c sparql10-basic

# Generate with verbose output
npx tsx test/generate-circuit-tests.ts -v --max 50
```

### Test Structure

Each circuit test directory contains:
```
test/circuits/sparql11/{category}/{test_name}/
├── query.rq                  # SPARQL query
├── data.ttl                  # RDF dataset
├── expected_bindings.json    # Expected variable bindings
├── valid_inputs/             # Positive test cases
│   ├── case_1.json          # One JSON file per valid binding
│   └── case_2.json
└── invalid_inputs/           # Negative test cases (to be generated)
    └── README.md
```

### Supported Categories

| Category | Description |
|----------|-------------|
| `bind` | BIND expression tests |
| `bindings` | Variable binding tests |
| `property-path` | Property path expressions |
| `sparql10-basic` | Basic BGP and query tests |
| `sparql10-triple-match` | Triple pattern matching |
| `sparql10-optional` | OPTIONAL clause tests |
| `sparql10-algebra` | Algebra optimization tests |
| `sparql10-expr-equals` | Equality expression tests |
| `sparql10-distinct` | DISTINCT modifier tests |

### Valid Inputs

Each `valid_inputs/case_N.json` contains a valid binding set that should satisfy the query constraints:

```json
{
  "description": "Valid binding 1 from SPARQL 1.1 test suite",
  "variables": {
    "v": "\"d:x ns:p\"",
    "p": "<http://example.org/ns#p>"
  }
}
```

### Invalid Inputs (To Be Generated)

The `invalid_inputs/` directories are placeholders for synthetic negative tests that will:
- Modify variable values to violate constraints
- Use wrong predicates/objects
- Fail filter conditions

These will be generated in a subsequent step.
