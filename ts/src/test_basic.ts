import { generateCircuits } from './generate_circuits.js';
import { Algebra, Factory } from 'sparqlalgebrajs';

const factory = new Factory();

async function testBasicFunctionality() {
  try {
    console.log('🧪 Testing Basic SPARQL Property Path Functionality\n');
    
    // Test 1: Simple link
    console.log('=== Test 1: Simple Link ===');
    const simpleLink = factory.createLink(factory.createTerm('http://example.org/knows') as any);
    console.log('Simple link created:', simpleLink.type);
    
    // Test 2: Sequence
    console.log('\n=== Test 2: Sequence ===');
    const sequence = factory.createSeq([
      factory.createLink(factory.createTerm('http://example.org/knows') as any),
      factory.createLink(factory.createTerm('http://example.org/worksAt') as any)
    ]);
    console.log('Sequence created:', sequence.type, 'with', sequence.input.length, 'inputs');
    
    // Test 3: Alternation
    console.log('\n=== Test 3: Alternation ===');
    const alternation = factory.createAlt([
      factory.createLink(factory.createTerm('http://example.org/knows') as any),
      factory.createLink(factory.createTerm('http://example.org/worksAt') as any)
    ]);
    console.log('Alternation created:', alternation.type, 'with', alternation.input.length, 'inputs');
    
    // Test 4: One or more
    console.log('\n=== Test 4: One or More ===');
    const oneOrMore = factory.createOneOrMorePath(
      factory.createLink(factory.createTerm('http://example.org/knows') as any)
    );
    console.log('One or more created:', oneOrMore.type);
    
    // Test 5: Zero or more
    console.log('\n=== Test 5: Zero or More ===');
    const zeroOrMore = factory.createZeroOrMorePath(
      factory.createLink(factory.createTerm('http://example.org/knows') as any)
    );
    console.log('Zero or more created:', zeroOrMore.type);
    
    // Test 6: Circuit generation (without compilation)
    console.log('\n=== Test 6: Circuit Generation ===');
    const circuits = await generateCircuits(sequence);
    console.log(`Generated ${circuits.length} circuits for sequence path`);
    
    circuits.forEach((circuit, index) => {
      console.log(`  Circuit ${index + 1}: ${circuit.name}`);
      console.log(`    Path: ${circuit.path}`);
      console.log(`    Imports: ${circuit.imports.size}`);
    });
    
    console.log('\n✅ All basic functionality tests passed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testBasicFunctionality();

