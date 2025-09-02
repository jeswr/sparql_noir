# SPARQL Property Path to Noir Recursive Proofs

This project demonstrates how to convert SPARQL property paths into Noir circuits and generate recursive proofs using the Noir TypeScript interface.

## Overview

The system works by:
1. **Parsing SPARQL property paths** using `sparqlalgebrajs`
2. **Generating Noir circuits** that implement the path logic with recursive proof verification
3. **Compiling circuits** using Nargo
4. **Generating recursive proofs** using the Noir TypeScript interface

## How Noir Recursion Works

Noir supports recursive proof verification through:
- `std::verify_proof_with_type()` function calls
- Verification keys (`vk`) and proofs (`proof`) as inputs
- Recursive circuit structures where child circuits verify sub-paths
- UltraHonk backend for recursive proof generation

### Recursive Circuit Structure

```noir
fn main(
    triple: pub Triple,
    vk: [Field; HONK_VK_SIZE],      // Verification keys for sub-circuits
    proof: [Field; HONK_PROOF_SIZE], // Proofs for sub-circuits
    s: pub Field,                    // Start node
    o: pub Field,                    // End node
) -> pub [Field; 2] {
    // Verify sub-circuit proofs recursively
    assert(sub_circuit_function(vk, proof, [s, o], 0x0, HONK_IDENTIFIER));
    
    [s, o]
}
```

## Installation

1. Install dependencies:
```bash
cd ts
npm install
```

2. Ensure you have Noir installed:
```bash
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
source ~/.bashrc
noirup
```

3. Build the TypeScript code:
```bash
npm run build
```

## Usage

### 1. Generate Circuits Only

```bash
node dist/generate_circuits.js
```

This will:
- Generate Noir circuit files for example SPARQL property paths
- Create the circuit structure in `noir/generated/` folder
- Compile circuits using Nargo

### 2. Generate Proofs Only

```bash
node dist/generate_proofs.js
```

This will:
- Load compiled circuits from the generated folder
- Generate recursive proofs using the Noir TypeScript interface
- Demonstrate proof verification

### 3. Complete Workflow

```bash
node dist/main.js
```

This runs the complete workflow:
1. Circuit generation
2. Circuit compilation
3. Proof generation
4. Proof verification

## Supported SPARQL Property Paths

### Basic Paths
- **Link**: `ex:knows` - Direct relationship
- **Sequence**: `ex:knows / ex:worksAt` - Path following
- **Alternation**: `ex:knows | ex:worksAt` - Either/or relationship

### Complex Paths
- **One or More**: `(ex:knows)+` - One or more knows relationships
- **Zero or More**: `(ex:knows)*` - Zero or more knows relationships
- **Nested**: `ex:knows / (ex:worksAt | ex:studiesAt) / ex:locatedIn`

## Generated Circuit Structure

Each generated circuit includes:
- `src/main.nr` - Main circuit logic
- `Nargo.toml` - Package configuration
- `Prover.toml` - Prover configuration
- `target/` - Compiled circuit binaries

## Example Output

```
🚀 Starting complete workflow for: knows_plus
============================================================

📝 Step 1: Generating Noir circuits...
✓ Generated 2 circuits

📁 Step 2: Creating circuit files...
✓ Created circuit files in ../../noir/generated/knows_plus

🔨 Step 3: Compiling circuits...
Compiling circuit_abc123...
✓ Compiled circuit_abc123
Compiling circuit_def456...
✓ Compiled circuit_def456

🔐 Step 4: Generating recursive proofs...
Found circuits: circuit_abc123, circuit_def456
Generating proof for circuit: circuit_def456
✓ Generated proof for circuit_def456, valid: true
Generating proof for circuit: circuit_abc123
✓ Generated proof for circuit_abc123, valid: true

Generating final recursive proof using main circuit: circuit_abc123
✓ Generated final recursive proof, valid: true

✅ Completed: knows_plus
   Circuits: 2 generated, 2 compiled
   Proofs: 2 generated
   Final proof valid: true
```

## Custom Property Paths

To use your own SPARQL property paths:

```typescript
import { Factory } from 'sparqlalgebrajs';
import { runCompleteWorkflow } from './main.js';

const factory = new Factory();

// Create your property path
const customPath = factory.createSeq([
  factory.createLink({ value: 'http://example.org/follows' }),
  factory.createOneOrMorePath(
    factory.createLink({ value: 'http://example.org/friendOf' })
  )
]);

// Run the workflow
const result = await runCompleteWorkflow(
  customPath,
  'custom_follows_friends',
  '0xstart_node',
  '0xend_node',
  tripleData
);
```

## Architecture

### Circuit Generation (`generate_circuits.ts`)
- Converts SPARQL algebra to Noir circuit code
- Handles recursive dependencies between sub-circuits
- Generates proper Noir package structure

### Proof Generation (`generate_proofs.ts`)
- Loads compiled circuits
- Generates proofs using UltraHonk backend
- Implements recursive proof verification

### Main Workflow (`main.ts`)
- Orchestrates the complete process
- Provides comprehensive testing and reporting
- Handles multiple property path types

## Dependencies

- `@noir-lang/noir_js` - Noir TypeScript interface
- `@aztec/bb.js` - Barretenberg backend for proof generation
- `sparqlalgebrajs` - SPARQL algebra parsing
- `typescript` - TypeScript compilation

## Troubleshooting

### Common Issues

1. **Nargo not found**: Ensure Noir is properly installed and in PATH
2. **Circuit compilation fails**: Check Noir version compatibility
3. **Proof generation errors**: Verify circuit compilation succeeded
4. **Memory issues**: Large circuits may require more memory

### Debug Mode

Enable verbose logging by modifying the scripts to include more detailed error reporting.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

ISC License - see package.json for details.

