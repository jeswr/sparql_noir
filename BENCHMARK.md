# Noir Backend Benchmarking Tool

This tool allows you to benchmark different Noir proving backends against your circuits to compare their performance characteristics. **Backends can be automatically installed** with a single command for easy setup.

## Overview

The benchmarking tool tests various aspects of each backend:
- **Compilation time**: Time to compile the Noir circuit
- **Witness generation**: Time to generate the witness
- **Setup time**: Time for backend-specific setup (if required)
- **Proving time**: Time to generate a proof
- **Verification time**: Time to verify a proof
- **Proof size**: Size of the generated proof (when available)

## Supported Backends

Based on the [awesome-noir](https://github.com/noir-lang/awesome-noir) repository, the following backends are supported:

### Currently Implemented
- **Barretenberg (UltraHonk/MegaHonk)** - The default backend by Aztec Labs
- **Plonky2** - By Blocksense Network
- **Sonobe (Nova/HyperNova)** - By 0xPARC and PSE

### Planned Support
- coSNARKs by Taceo Labs
- Edge (Supernova) by Pluto
- ProveKit (Recursive Groth16) by World

## Installation

### Prerequisites
```bash
# Ensure you have Node.js and npm installed
npm install

# Install ts-node for running TypeScript directly
npm install -g ts-node
```

### Backend Installation

You can install backends automatically using the built-in installation commands, or manually as described below.

#### Automated Installation (Recommended)

**Using npm scripts:**
```bash
# List all available backends and their installation status
npm run benchmark:list

# Install a specific backend
npm run benchmark:install barretenberg-ultrahonk
npm run benchmark:install sonobe
npm run benchmark:install plonky2-blocksense

# Install all available backends at once
npm run benchmark:install-all

# Get installation help and requirements
npm run benchmark:help
```

**Using standalone installer:**
```bash
# List all available backends
npx tsx scripts/install-backends.ts list

# Install a specific backend
npx tsx scripts/install-backends.ts install barretenberg-ultrahonk

# Install all backends
npx tsx scripts/install-backends.ts install-all

# Get help
npx tsx scripts/install-backends.ts help
```

#### Manual Installation

#### Barretenberg (Default - Already Available)
```bash
# Install Barretenberg CLI
curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/bbup/install | bash
bbup
```

#### Plonky2 (Blocksense)
```bash
git clone https://github.com/blocksense-network/noir
cd noir-plonky2
cargo install --path .
```

#### Sonobe
```bash
git clone https://github.com/privacy-scaling-explorations/sonobe
cd sonobe
cargo build --release
cargo install --path cli --bin solidity-verifiers-cli
```

## Usage

### Quick Start

### Simple Benchmark (Recommended)
```bash
# Benchmark the signature circuit (includes proving/verification)
npm run benchmark:simple:signature

# Benchmark all circuits (compilation and witness generation only for non-signature circuits)
npm run benchmark:simple

# Benchmark specific circuits
npx tsx scripts/simple-benchmark.ts noir/bin/signature noir/bin/encode
```

### Advanced Backend Comparison (Experimental)
```bash
# Benchmark all available backends on the signature circuit
npm run benchmark:signature

# Benchmark a specific circuit
npm run benchmark noir/bin/encode

# List available backends and their installation status
npm run benchmark:list

# Get backend installation help
npm run benchmark:help
```

### Advanced Usage

#### Benchmark Specific Backends
```bash
# Test only Barretenberg and Plonky2
npm run benchmark noir/bin/signature -- -b barretenberg plonky2-blocksense
```

#### Custom Output Location
```bash
# Save results to a custom directory
npm run benchmark noir/bin/signature -- -o ./my-benchmark-results
```

#### Save Results to Specific File
```bash
# Save with custom filename
npm run benchmark noir/bin/signature -- -s my-benchmark-results.json
```

#### Skip Text Report
```bash
# Only save JSON results, don't print report
npm run benchmark noir/bin/signature -- --no-report
```

### CLI Options

```
Usage: noir-backend-benchmark [options] <circuit-path>

Arguments:
  circuit-path                    Path to the Noir circuit directory

Options:
  -V, --version                   output the version number
  -b, --backends <backends...>    Specific backends to test (space-separated)
  -o, --output <path>            Output directory for results (default: "./benchmark-results")
  -s, --save <filename>          Save results to specific file
  --no-report                    Skip generating text report
  -h, --help                     display help for this message

Commands:
  list-backends                  List all available backends and their installation status
  install-help                   Show installation instructions for all backends
  help [command]                 display help for command
```

## Examples

### Example 1: Simple Benchmark
```bash
npm run benchmark:simple:signature
```

Expected output:
```
🚀 Starting benchmark for 1 circuit(s)...

🔬 Benchmarking circuit: signature
📋 Compiling circuit...
⚡ Generating witness...
[signature] Circuit witness successfully solved
[signature] Witness saved to target/signature.gz
🔐 Running proof generation and verification...

Witness generation: 151.055ms
Proof generation: 1.430s
Proof verification: 264.296ms

🔧 Initializing backend and warming up threads...
✓ Backend initialized and threads warmed up
📏 Measuring witness generation...
📏 Measuring proof generation...
📏 Measuring proof verification...
✓ Witness: 96.55ms
✓ Proving: 816.60ms
✓ Verification: 266.61ms

📊 NOIR CIRCUIT BENCHMARK RESULTS
============================================================

✅ Successful Benchmarks:

| Circuit | Compile (ms) | Witness (ms) | Prove (ms) | Verify (ms) | Total (ms) | Size |
|---------|--------------|--------------|------------|-------------|------------|------|
| signature |     251.19 |      96.55 |   816.60 |    266.61 |  1430.95 | 185948 |

💾 Results saved to: simple-benchmark-2025-09-07T21-43-17-616Z.json
```

### Example 2: Compare Multiple Backends
```bash
# Assuming you have multiple backends installed
npm run benchmark noir/bin/signature -- -b barretenberg plonky2-blocksense sonobe
```

Expected output:
```
📊 BENCHMARK RESULTS
==================================================

✅ Successful Runs:
| Backend   | Compile (ms) | Witness (ms) | Setup (ms) | Prove (ms) | Verify (ms) | Proof Size (bytes) |
|-----------|--------------|--------------|------------|------------|-------------|-------------------|
| barrete   |     1234.56  |     234.78   |   456.78   |   2345.67  |    123.45   |              2048 |
| plonky2   |     1234.56  |     234.78   |    N/A     |   1234.56  |     89.12   |              1024 |
| sonobe    |     1234.56  |     234.78   |   567.89   |   3456.78  |    234.56   |              4096 |

🏆 Performance Ranking:

Fastest Proving:
🥇 plonky2-blocksense: 1234.56ms
🥈 barretenberg: 2345.67ms
🥉 sonobe: 3456.78ms

Fastest Verification:
🥇 plonky2-blocksense: 89.12ms
🥈 barretenberg: 123.45ms
🥉 sonobe: 234.56ms
```

### Example 3: Benchmark All Circuits
```bash
npm run benchmark:all
```

This will sequentially benchmark all three circuits:
- `noir/bin/signature`
- `noir/bin/encode`
- `noir/bin/verify_inclusion`

## Output Format

### JSON Results
The tool saves detailed JSON results with the following structure:

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "circuit": "noir/bin/signature",
  "results": [
    {
      "backend": "barretenberg",
      "compileTime": 1234.56,
      "proveTime": 2345.67,
      "verifyTime": 123.45,
      "proofSize": 2048,
      "success": true,
      "witnessGenTime": 234.78,
      "setupTime": 456.78
    }
  ],
  "summary": {
    "totalBackends": 3,
    "availableBackends": 1,
    "successfulRuns": 1,
    "failedRuns": 0
  }
}
```

### Text Report
The tool generates a formatted text report with:
- Success/failure status for each backend
- Performance comparison table
- Ranking by proving and verification speed
- Installation notes for failed backends

## Troubleshooting

### Common Issues

#### "Backend not installed" Error
```bash
# Check which backends are available
npm run benchmark:list

# Get installation instructions
npm run benchmark:help
```

#### Circuit Compilation Fails
- Ensure your circuit directory contains a valid `Nargo.toml`
- Make sure all dependencies are properly configured
- Try building the circuit manually: `cd noir/bin/signature && nargo build`

#### Permission Denied
```bash
# Make sure the benchmark script is executable
chmod +x scripts/benchmark.js
```

#### Memory Issues
- Large circuits may require more memory
- Consider testing with smaller circuits first
- Monitor system resources during benchmarking

### Debug Mode
For more detailed output, you can run the TypeScript file directly:

```bash
npx ts-node scripts/benchmark-backends.ts noir/bin/signature --verbose
```

## Contributing

### Adding New Backends

To add support for a new backend:

1. Add the backend configuration to the `backends` array in `benchmark-backends.ts`:

```typescript
{
  name: 'new-backend',
  command: 'new-backend-cli',
  proveCommand: (circuit, witness) => `new-backend prove ${circuit} ${witness}`,
  verifyCommand: (proof, vk) => `new-backend verify ${proof} ${vk}`,
  setupRequired: true,
  setupCommand: (circuit) => `new-backend setup ${circuit}`,
  installed: false,
  installInstructions: 'Installation instructions here'
}
```

2. Test the new backend with a known circuit
3. Update this documentation
4. Submit a pull request

### Generated Files

The benchmark scripts generate temporary files that are automatically excluded from version control via `.gitignore`:

- `benchmark-results/` - Directory containing JSON benchmark results
- `simple-benchmark-*.json` - Individual benchmark result files
- `noir/bin/*/Prover.toml` - Auto-generated input files for circuits
- `proof`, `vk`, `vk.bin`, `verification_key` - Backend-generated files
- `temp_data.ttl`, `temp_output.json` - Temporary files during input generation

These files are automatically cleaned up and should not be committed to the repository.

### Performance Optimizations

The benchmarking tool includes several optimizations for accurate measurements:

✅ **Implemented:**
- **Thread warm-up**: Excludes backend thread initialization overhead from measurements
- **JIT warm-up**: Pre-runs operations to ensure JIT compilation doesn't affect timing
- **Direct API access**: Uses NoirJS API directly for precise timing control
- **Separate timing phases**: Measures compilation, witness generation, proving, and verification independently

🔄 **Future improvements:**
- Parallel backend testing (currently sequential)
- Multiple runs with statistical analysis  
- Memory usage monitoring
- Automated performance regression detection

## References

- [Awesome Noir - Proving Backends](https://github.com/noir-lang/awesome-noir#proving-backends)
- [Noir Documentation](https://noir-lang.org/)
- [Barretenberg Documentation](https://docs.aztec.network/barretenberg)
