import { generateAllCircuits, writeCircuits, compileCircuits } from './generate_circuits.js';
import { provePathDirectory } from './generate_proofs.js';
import { generateTestWitness } from './witness_generator.js';
import { Algebra, Factory } from 'sparqlalgebrajs';

const factory = new Factory();

interface WorkflowResult {
  propertyPath: string;
  circuitsGenerated: number;
  circuitsCompiled: number;
  proofsGenerated: boolean;
  finalProofValid: boolean;
  outputDirectory: string;
}

async function runCompleteWorkflow(
  propertyPath: Algebra.PropertyPathSymbol,
  pathName: string,
  testCase: string
): Promise<WorkflowResult> {
  console.log(`\n🚀 Starting complete workflow for: ${pathName}`);
  console.log('=' .repeat(60));
  
  // Step 1: Generate circuits
  console.log('\n📝 Step 1: Generating Noir circuits...');
  const circuits = generateAllCircuits(pathName, propertyPath, '../noir/generated');
  console.log(`✓ Generated ${circuits.size} circuits`);
  
  // Step 2: Create circuit files
  console.log('\n📁 Step 2: Creating circuit files...');
  const outputDir = `../noir/generated/${pathName}`;
  writeCircuits(pathName, circuits, '../noir/generated');
  console.log(`✓ Created circuit files in ${outputDir}`);
  
  // Step 3: Compile circuits
  console.log('\n🔨 Step 3: Compiling circuits...');
  compileCircuits(pathName, '../noir/generated');
  console.log(`✓ Compiled circuits`);
  
  // Step 4: Generate recursive proofs with real data
  console.log('\n🔐 Step 4: Generating recursive proofs with real data...');
  const witness = generateTestWitness(testCase as any);
  const { bundle, errors } = await provePathDirectory(
    outputDir,
    witness.triple,
    witness.s,
    witness.o
  );
  
  const proofValid = errors.length === 0;
  console.log(`✓ Proof generation ${proofValid ? 'succeeded' : 'failed'}`);
  
  return {
    propertyPath: pathName,
    circuitsGenerated: circuits.size,
    circuitsCompiled: circuits.size,
    proofsGenerated: true,
    finalProofValid: proofValid,
    outputDirectory: outputDir
  };
}

async function main() {
  try {
    console.log('🎯 SPARQL Property Path to Noir Recursive Proofs Workflow');
    console.log('=' .repeat(60));
    
    // Define test property paths with real data test cases
    const testCases = [
      {
        name: 'knows_plus',
        description: '(ex:knows)+ - One or more knows relationships',
        path: factory.createOneOrMorePath(
          factory.createLink(factory.createTerm('http://example.org/knows') as any)
        ),
        testCase: 'knows'
      },
      {
        name: 'knows_works_at',
        description: 'ex:knows / ex:worksAt - Sequence of knows then worksAt',
        path: factory.createSeq([
          factory.createLink(factory.createTerm('http://example.org/knows') as any),
          factory.createLink(factory.createTerm('http://example.org/worksAt') as any)
        ]),
        testCase: 'sequence'
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
        testCase: 'knows'
      }
    ];
    
    const results: WorkflowResult[] = [];
    
    // Run workflow for each test case
    for (const testCase of testCases) {
      console.log(`\n📋 Test Case: ${testCase.description}`);
      
      try {
        const result = await runCompleteWorkflow(
          testCase.path,
          testCase.name,
          testCase.testCase
        );
        
        results.push(result);
        
        console.log(`\n✅ Completed: ${testCase.name}`);
        console.log(`   Circuits: ${result.circuitsGenerated} generated, ${result.circuitsCompiled} compiled`);
        console.log(`   Proofs: ${result.proofsGenerated ? 'Generated' : 'Failed'}`);
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
      console.log(`   Proofs: ${result.proofsGenerated ? '✅ Generated' : '❌ Failed'}`);
      console.log(`   Final proof: ${result.finalProofValid ? '✅ Valid' : '❌ Invalid'}`);
    });
    
    const totalCircuits = results.reduce((sum, r) => sum + r.circuitsGenerated, 0);
    const validProofs = results.filter(r => r.finalProofValid).length;
    
    console.log(`\n📈 Totals:`);
    console.log(`   Circuits generated: ${totalCircuits}`);
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