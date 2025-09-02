import { generateCircuits, createCircuitFiles, compileCircuits } from './generate_circuits.js';
import { generateRecursivePathProof } from './generate_proofs.js';
import { Algebra, Factory } from 'sparqlalgebrajs';
import { iriToField } from './FIELD_MODULUS.js';

const factory = new Factory();

interface WorkflowResult {
  propertyPath: string;
  circuitsGenerated: number;
  circuitsCompiled: number;
  proofsGenerated: number;
  finalProofValid: boolean;
  outputDirectory: string;
}

async function runCompleteWorkflow(
  propertyPath: Algebra.PropertyPathSymbol,
  pathName: string,
  startNode: string,
  endNode: string,
  tripleData: any
): Promise<WorkflowResult> {
  console.log(`\n🚀 Starting complete workflow for: ${pathName}`);
  console.log('=' .repeat(60));
  
  // Step 1: Generate circuits
  console.log('\n📝 Step 1: Generating Noir circuits...');
  const circuits = await generateCircuits(propertyPath);
  console.log(`✓ Generated ${circuits.length} circuits`);
  
  // Step 2: Create circuit files
  console.log('\n📁 Step 2: Creating circuit files...');
        const outputDir = `../noir/generated/${pathName}`;
  await createCircuitFiles(circuits, outputDir);
  console.log(`✓ Created circuit files in ${outputDir}`);
  
  // Step 3: Compile circuits
  console.log('\n🔨 Step 3: Compiling circuits...');
  await compileCircuits(circuits, outputDir);
  console.log(`✓ Compiled circuits`);
  
  // Step 4: Generate recursive proofs
  console.log('\n🔐 Step 4: Generating recursive proofs...');
  const proofData = await generateRecursivePathProof(
    propertyPath,
    startNode,
    endNode,
    tripleData,
    outputDir
  );
  
  console.log(`✓ Generated ${proofData.proofs.length} proofs`);
  
  return {
    propertyPath: proofData.path,
    circuitsGenerated: circuits.length,
    circuitsCompiled: proofData.circuits.length,
    proofsGenerated: proofData.proofs.length,
    finalProofValid: proofData.finalProof?.isValid || false,
    outputDirectory: outputDir
  };
}

async function main() {
  try {
    console.log('🎯 SPARQL Property Path to Noir Recursive Proofs Workflow');
    console.log('=' .repeat(60));
    
    // Define test property paths
    const testCases = [
      {
        name: 'knows_plus',
        description: '(ex:knows)+ - One or more knows relationships',
        path: factory.createOneOrMorePath(
          factory.createLink(factory.createTerm('http://example.org/knows') as any)
        ),
        startNode: '0x1234567890abcdef',
        endNode: '0xfedcba0987654321'
      },
      {
        name: 'knows_works_at',
        description: 'ex:knows / ex:worksAt - Sequence of knows then worksAt',
        path: factory.createSeq([
          factory.createLink(factory.createTerm('http://example.org/knows') as any),
          factory.createLink(factory.createTerm('http://example.org/worksAt') as any)
        ]),
        startNode: '0x1111111111111111',
        endNode: '0x2222222222222222'
      },
      {
        name: 'knows_or_works_at_star',
        description: '(ex:knows | ex:worksAt)* - Zero or more knows or worksAt',
        path: factory.createZeroOrMorePath(
          factory.createAlt([
            factory.createLink(factory.createTerm('http://example.org/knows') as any),
            factory.createLink(factory.createTerm('http://example.org/worksAt') as any)
          ])
        ),
        startNode: '0x3333333333333333',
        endNode: '0x4444444444444444'
      },
      {
        name: 'complex_sequence',
        description: 'ex:knows / (ex:worksAt | ex:studiesAt) / ex:locatedIn',
        path: factory.createSeq([
          factory.createLink(factory.createTerm('http://example.org/knows') as any),
          factory.createAlt([
            factory.createLink(factory.createTerm('http://example.org/worksAt') as any),
            factory.createLink(factory.createTerm('http://example.org/studiesAt') as any)
          ]),
          factory.createLink(factory.createTerm('http://example.org/locatedIn') as any)
        ]),
        startNode: '0x5555555555555555',
        endNode: '0x6666666666666666'
      }
    ];
    
    const results: WorkflowResult[] = [];
    
    // Sample triple data for all tests
    const tripleData = {
      terms: [
        '0x1234567890abcdef', // subject
        iriToField('http://example.org/knows'), // predicate
        '0xfedcba0987654321', // object
        '0x0000000000000000'  // graph (optional)
      ],
      path: new Array(11).fill(0), // MERKLE_DEPTH
      directions: new Array(10).fill(0) // MERKLE_DEPTH - 1
    };
    
    // Run workflow for each test case
    for (const testCase of testCases) {
      console.log(`\n📋 Test Case: ${testCase.description}`);
      
      try {
        const result = await runCompleteWorkflow(
          testCase.path,
          testCase.name,
          testCase.startNode,
          testCase.endNode,
          tripleData
        );
        
        results.push(result);
        
        console.log(`\n✅ Completed: ${testCase.name}`);
        console.log(`   Circuits: ${result.circuitsGenerated} generated, ${result.circuitsCompiled} compiled`);
        console.log(`   Proofs: ${result.proofsGenerated} generated`);
        console.log(`   Final proof valid: ${result.finalProofValid}`);
        
      } catch (error) {
        console.error(`\n❌ Failed: ${testCase.name} - ${error}`);
      }
    }
    
    // Summary report
    console.log('\n📊 Workflow Summary Report');
    console.log('=' .repeat(60));
    
    results.forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.outputDirectory.split('/').pop()}`);
      console.log(`   Circuits: ${result.circuitsGenerated}/${result.circuitsCompiled}`);
      console.log(`   Proofs: ${result.proofsGenerated}`);
      console.log(`   Final proof: ${result.finalProofValid ? '✅ Valid' : '❌ Invalid'}`);
    });
    
    const totalCircuits = results.reduce((sum, r) => sum + r.circuitsGenerated, 0);
    const totalProofs = results.reduce((sum, r) => sum + r.proofsGenerated, 0);
    const validProofs = results.filter(r => r.finalProofValid).length;
    
    console.log(`\n📈 Totals:`);
    console.log(`   Circuits generated: ${totalCircuits}`);
    console.log(`   Proofs generated: ${totalProofs}`);
    console.log(`   Valid final proofs: ${validProofs}/${results.length}`);
    
    console.log('\n🎉 Workflow completed successfully!');
    
  } catch (error) {
    console.error('\n💥 Workflow failed:', error);
    process.exit(1);
  }
}

// Export for use in other modules
export {
  runCompleteWorkflow,
};

export type {
  WorkflowResult
};

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
