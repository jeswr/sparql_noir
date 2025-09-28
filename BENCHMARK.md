# Noir Circuit Benchmarking

This project includes a professional-grade benchmarking tool for measuring the performance of Noir circuits. The benchmarking tool is inspired by [noir-benchmark-cli](https://github.com/francoperez03/noir-benchmark-cli) but tailored specifically for this project's circuits.

## Overview

The benchmarking tool measures various aspects of circuit performance:
- **Compilation time**: Time to compile the Noir circuit
- **Witness generation**: Time to generate the witness
- **Proving time**: Time to generate a proof (signature circuit only)
- **Verification time**: Time to verify a proof (signature circuit only)
- **Circuit size**: Size of the compiled circuit bytecode
- **Proof size**: Size of the generated proof (when available)

## Available Circuits

The following circuits are available for benchmarking:

- **noir/bin/signature** - Digital signature verification circuit (supports full proving/verification)
- **noir/bin/encode** - RDF term encoding circuit (compilation and witness generation only)  
- **noir/bin/verify_inclusion** - Merkle tree inclusion proof circuit (compilation and witness generation only)

## Usage

### Prerequisites

```bash
# Install dependencies
npm install

# Install Noir (if not already installed)
bash noir_install.sh
source ~/.bashrc
noirup
```

### Quick Start

```bash
# Benchmark signature circuit (default)
npm run benchmark

# Benchmark specific circuit
npm run benchmark:signature
npm run benchmark:encode
npm run benchmark:verify

# List available circuits
npm run benchmark:list

# Get help
npm run benchmark:help
```

### Advanced Usage

```bash
# Run multiple benchmark runs for more accurate averages
npx tsx src/scripts/benchmarks/noir-benchmark.ts benchmark --runs 3

# Benchmark specific circuits with multiple runs
npx tsx src/scripts/benchmarks/noir-benchmark.ts benchmark noir/bin/signature --runs 5

# Save results to custom file
npx tsx src/scripts/benchmarks/noir-benchmark.ts benchmark --save my-results.json

# Skip text report (only save JSON)
npx tsx src/scripts/benchmarks/noir-benchmark.ts benchmark --no-report
```

## Output Format

### Console Output

The tool provides a professional visual experience with:
- Progress indicators during benchmarking
- Colored output for better readability
- Performance summaries and rankings
- Error reporting with helpful messages

Example output:
```
╔═══════════════════════════════════════╗
║         NOIR CIRCUIT BENCHMARK       ║
║      Professional Performance Tool   ║
╚═══════════════════════════════════════╝

🎯 Benchmarking 1 circuit(s) with 1 run(s) each

🔬 Benchmarking circuit: signature (1 run)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Compiling circuit...
📝 Preparing signature inputs...
🏃 Run 1/1
⚡ Generating witness...
🔐 Generating proof...
🔍 Verifying proof...
✓ 100% complete

✅ Benchmark completed successfully
```

### JSON Results

Results are automatically saved to timestamped JSON files with detailed metrics:

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "tool": "noir-circuit-benchmark",
  "version": "1.0.0",
  "results": [
    {
      "circuitName": "signature",
      "compilationTime": 1234.56,
      "witnessGenerationTime": 234.78,
      "provingTime": 2345.67,
      "verificationTime": 123.45,
      "totalTime": 3938.46,
      "success": true,
      "circuitSize": 12345,
      "proofSize": 2048,
      "runs": 1
    }
  ],
  "summary": {
    "totalCircuits": 1,
    "successfulBenchmarks": 1,
    "failedBenchmarks": 0,
    "averageTime": 3938.46
  }
}
```

## Continuous Integration

Benchmarks are automatically run in CI/CD pipelines to:
- Monitor performance regressions
- Compare performance between branches
- Store benchmark results as artifacts
- Generate performance reports

See `.github/workflows/benchmark.yml` for the CI configuration.

## Technical Details

### Architecture

The benchmarking tool follows clean architecture principles:
- **Professional visual experience** with progress indicators and colored output
- **Multiple run support** for statistical accuracy
- **Modular design** for easy extension to new circuits
- **Error handling** with detailed error messages
- **JSON output** for integration with CI/CD systems

### Performance Optimization

The tool includes several optimizations for accurate measurements:
- **Thread warm-up**: Excludes backend thread initialization from measurements
- **JIT warm-up**: Pre-runs operations to ensure JIT compilation doesn't affect timing
- **Direct NoirJS API**: Uses NoirJS API directly for precise timing control
- **Separate timing phases**: Measures compilation, witness generation, proving, and verification independently

### Limitations

- Full proof generation/verification is currently only supported for the signature circuit
- Other circuits only measure compilation and witness generation times
- Results may vary between runs due to system load and JIT compilation
- Requires Noir to be installed and available in PATH

## Contributing

To add support for new circuits:

1. Ensure the circuit compiles with `nargo build`
2. Add any required input preparation logic to `prepareInputsIfNeeded()`
3. For circuits requiring proof generation, extend `runProofBenchmark()`
4. Update the circuit list in the `list-circuits` command

The tool is designed to be easily extensible while maintaining professional-grade performance measurement capabilities.
