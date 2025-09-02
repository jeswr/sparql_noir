import { generateCircuits, createCircuitFiles } from './generate_circuits.js';
import { Algebra, Factory } from 'sparqlalgebrajs';

const factory = new Factory();

async function testMinimalFunctionality() {
  try {
    console.log('🧪 Testing Minimal Circuit Generation (No Compilation)\n');
    
    // Test 1: Simple sequence path
    console.log('=== Test 1: Simple Sequence Path ===');
    const sequencePath = factory.createSeq([
      factory.createLink(factory.createTerm('http://example.org/knows') as any),
      factory.createLink(factory.createTerm('http://example.org/worksAt') as any)
    ]);
    
    console.log('Generated sequence path:', sequencePath.type);
    console.log('Number of inputs:', sequencePath.input.length);
    
    // Generate circuits
    const circuits = await generateCircuits(sequencePath);
    console.log(`Generated ${circuits.length} circuits`);
    
    // Display circuit information
    circuits.forEach((circuit, index) => {
      console.log(`\nCircuit ${index + 1}: ${circuit.name}`);
      console.log(`Path logic: ${circuit.path}`);
      console.log(`Number of imports: ${circuit.imports.size}`);
      
      if (circuit.imports.size > 0) {
        console.log('Imports:');
        circuit.imports.forEach((importPath, importName) => {
          console.log(`  ${importName}: ${importPath.path}`);
        });
      }
    });
    
    // Test 2: Create circuit files (without compilation)
    console.log('\n=== Test 2: Creating Circuit Files ===');
    const outputDir = `../noir/generated/test_minimal`;
    await createCircuitFiles(circuits, outputDir);
    console.log(`✓ Created circuit files in ${outputDir}`);
    
    // Test 3: Verify file structure
    console.log('\n=== Test 3: Verifying File Structure ===');
    const fs = await import('fs');
    const path = await import('path');
    
    for (const circuit of circuits) {
      const circuitDir = path.join(outputDir, circuit.name);
      const mainFile = path.join(circuitDir, 'src', 'main.nr');
      const nargoFile = path.join(circuitDir, 'Nargo.toml');
      
      if (fs.existsSync(mainFile)) {
        console.log(`✓ ${circuit.name}/src/main.nr exists`);
      } else {
        console.log(`✗ ${circuit.name}/src/main.nr missing`);
      }
      
      if (fs.existsSync(nargoFile)) {
        console.log(`✓ ${circuit.name}/Nargo.toml exists`);
      } else {
        console.log(`✗ ${circuit.name}/Nargo.toml missing`);
      }
    }
    
    console.log('\n✅ Minimal functionality test completed successfully!');
    console.log('\nNote: This test only verifies circuit generation and file creation.');
    console.log('Circuit compilation requires resolving the noir_stdlib dependency issue.');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testMinimalFunctionality();
