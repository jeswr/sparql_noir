#!/usr/bin/env node

import { program } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { performance } from 'perf_hooks';

interface SimpleBenchmarkResult {
  circuitName: string;
  compilationTime: number;
  witnessGenerationTime: number;
  provingTime: number;
  verificationTime: number;
  totalTime: number;
  success: boolean;
  error?: string;
  circuitSize?: number;
}

class SimpleNoirBenchmark {
  private results: SimpleBenchmarkResult[] = [];

  async benchmarkCircuit(circuitPath: string): Promise<SimpleBenchmarkResult> {
    const circuitName = basename(circuitPath);
    console.log(`\n🔬 Benchmarking circuit: ${circuitName}`);
    
    try {
      // 1. Compilation benchmark
      console.log('📋 Compiling circuit...');
      const compileStart = performance.now();
      execSync('nargo build', { 
        cwd: circuitPath,
        stdio: 'inherit'
      });
      const compilationTime = performance.now() - compileStart;
      
      // Get circuit size from the compiled json
      const circuitJsonPath = join(circuitPath, 'target', `${circuitName}.json`);
      let circuitSize: number | undefined;
      if (existsSync(circuitJsonPath)) {
        try {
          const circuitData = JSON.parse(readFileSync(circuitJsonPath, 'utf8'));
          // Estimate circuit size from bytecode length
          circuitSize = circuitData.bytecode ? circuitData.bytecode.length : undefined;
        } catch {
          // Circuit size not available
        }
      }

      // 2. Check if we have a Prover.toml or need to generate inputs
      const proverTomlPath = join(circuitPath, 'Prover.toml');
      if (circuitName === 'signature' && !existsSync(proverTomlPath)) {
        console.log('📝 Generating valid inputs for signature circuit...');
        
        // Use the existing temp/main.json if available
        const mainJsonPath = join(process.cwd(), 'temp', 'main.json');
        if (existsSync(mainJsonPath)) {
          const signedData = JSON.parse(readFileSync(mainJsonPath, 'utf8'));
          
          // Import serializeProve to create proper TOML
          const { serializeProve } = await import('../../serializeProve.js');
          
          const inputs = {
            public_key: signedData.pubKey,
            root: {
              value: signedData.root,
              signature: signedData.signature
            }
          };
          
          const tomlContent = '# Generated for benchmarking\n\n' + serializeProve(inputs);
          writeFileSync(proverTomlPath, tomlContent);
          console.log('✓ Created valid Prover.toml');
        } else {
          throw new Error('No valid signature data found. Run npm run example:sign first.');
        }
      }

      // 3. Witness generation benchmark
      console.log('⚡ Generating witness...');
      const witnessStart = performance.now();
      execSync('nargo execute', {
        cwd: circuitPath,
        stdio: 'inherit'
      });
      const witnessGenerationTime = performance.now() - witnessStart;

      // 4. Proving and verification benchmark using direct NoirJS API
      if (circuitName === 'signature') {
        console.log('🔐 Running proof generation and verification...');
        
        // Use NoirJS directly for more precise timing
        const mainJsonPath = join(process.cwd(), 'temp', 'main.json');
        const circuitJsonPath = join(circuitPath, 'target', `${circuitName}.json`);
        
        if (!existsSync(mainJsonPath) || !existsSync(circuitJsonPath)) {
          throw new Error('Required files not found. Run npm run example:sign first.');
        }
        
        const signedData = JSON.parse(readFileSync(mainJsonPath, 'utf8'));
        const circuitData = JSON.parse(readFileSync(circuitJsonPath, 'utf8'));
        
        // Import NoirJS modules
        const { Noir } = await import('@noir-lang/noir_js');
        const { UltraHonkBackend } = await import('@aztec/bb.js');
        
        const noir = new Noir(circuitData);
        
        // Initialize backend and warm up threads (this is not timed)
        console.log('🔧 Initializing backend and warming up threads...');
        const backend = new UltraHonkBackend(circuitData.bytecode, { threads: 6 });
        
        // Warm-up: generate witness once to initialize everything
        const warmupInputs = {
          public_key: signedData.pubKey,
          root: {
            value: signedData.root,
            signature: signedData.signature,
          },
        };
        
        const { witness: warmupWitness } = await noir.execute(warmupInputs);
        
        // Small warm-up proof to initialize the backend fully
        await backend.generateProof(warmupWitness);
        console.log('✓ Backend initialized and threads warmed up');
        
        // Now run the actual benchmarks
        console.log('📏 Measuring witness generation...');
        const witnessStart = performance.now();
        const { witness } = await noir.execute(warmupInputs);
        const actualWitnessTime = performance.now() - witnessStart;
        
        console.log('📏 Measuring proof generation...');
        const proveStart = performance.now();
        const proof = await backend.generateProof(witness);
        const provingTime = performance.now() - proveStart;
        
        console.log('📏 Measuring proof verification...');
        const verifyStart = performance.now();
        const isValid = await backend.verifyProof(proof);
        const verificationTime = performance.now() - verifyStart;
        
        // Clean up
        backend.destroy();
        
        if (!isValid) {
          throw new Error('Proof verification failed');
        }
        
        console.log(`✓ Witness: ${actualWitnessTime.toFixed(2)}ms`);
        console.log(`✓ Proving: ${provingTime.toFixed(2)}ms`);
        console.log(`✓ Verification: ${verificationTime.toFixed(2)}ms`);
        
        const totalTime = compilationTime + actualWitnessTime + provingTime + verificationTime;

        return {
          circuitName,
          compilationTime,
          witnessGenerationTime: actualWitnessTime,
          provingTime,
          verificationTime,
          totalTime,
          success: true,
          circuitSize: circuitSize || 0
        };
      } else {
        // For other circuits, we can only do compilation and witness generation
        const totalTime = compilationTime + witnessGenerationTime;
        
        return {
          circuitName,
          compilationTime,
          witnessGenerationTime,
          provingTime: 0,
          verificationTime: 0,
          totalTime,
          success: true,
          circuitSize: circuitSize || 0,
          error: 'Proving/verification only available for signature circuit'
        };
      }

    } catch (error) {
      return {
        circuitName,
        compilationTime: 0,
        witnessGenerationTime: 0,
        provingTime: 0,
        verificationTime: 0,
        totalTime: 0,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async benchmarkAll(circuitPaths: string[]): Promise<SimpleBenchmarkResult[]> {
    console.log(`🚀 Starting benchmark for ${circuitPaths.length} circuit(s)...\n`);

    for (const circuitPath of circuitPaths) {
      if (!existsSync(circuitPath)) {
        console.log(`❌ Circuit path does not exist: ${circuitPath}`);
        continue;
      }

      const result = await this.benchmarkCircuit(circuitPath);
      this.results.push(result);
    }

    return this.results;
  }

  generateReport(): string {
    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);

    let report = '\n📊 NOIR CIRCUIT BENCHMARK RESULTS\n';
    report += '='.repeat(80) + '\n\n';

    if (successful.length > 0) {
      report += '✅ Successful Benchmarks:\n\n';
      report += '| Circuit     | Compile (ms) | Witness (ms) | Prove (ms) | Verify (ms) | Total (ms) | Size   |\n';
      report += '|-------------|--------------|--------------|------------|-------------|------------|--------|\n';
      
      for (const result of successful) {
        const size = result.circuitSize ? result.circuitSize.toString() : 'N/A';
        const circuit = result.circuitName.length > 11 ? result.circuitName.substring(0, 8) + '...' : result.circuitName;
        report += `| ${circuit.padEnd(11)} | ${result.compilationTime.toFixed(2).padStart(12)} | ${result.witnessGenerationTime.toFixed(2).padStart(12)} | ${result.provingTime.toFixed(2).padStart(10)} | ${result.verificationTime.toFixed(2).padStart(11)} | ${result.totalTime.toFixed(2).padStart(10)} | ${size.padStart(6)} |\n`;
      }
      
      if (successful.length > 1) {
        report += '\n🏆 Performance Summary:\n';
        const fastest = successful.reduce((min, curr) => 
          curr.totalTime < min.totalTime ? curr : min);
        const slowest = successful.reduce((max, curr) => 
          curr.totalTime > max.totalTime ? curr : max);
        
        report += `• Fastest: ${fastest.circuitName} (${fastest.totalTime.toFixed(2)}ms)\n`;
        report += `• Slowest: ${slowest.circuitName} (${slowest.totalTime.toFixed(2)}ms)\n`;
        
        const avgTime = successful.reduce((sum, r) => sum + r.totalTime, 0) / successful.length;
        report += `• Average: ${avgTime.toFixed(2)}ms\n`;
      }
    }

    if (failed.length > 0) {
      report += '\n❌ Failed Benchmarks:\n';
      for (const result of failed) {
        report += `• ${result.circuitName}: ${result.error}\n`;
      }
    }

    report += '\n📝 Notes:\n';
    report += '• Times are in milliseconds\n';
    report += '• Proving/verification only available for signature circuit\n';
    report += '• Size represents bytecode length (approximate)\n';
    report += '• Results may vary between runs\n';

    return report;
  }

  saveResults(filename?: string): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = filename || `simple-benchmark-${timestamp}.json`;
    
    const data = {
      timestamp: new Date().toISOString(),
      results: this.results,
      summary: {
        totalCircuits: this.results.length,
        successfulBenchmarks: this.results.filter(r => r.success).length,
        failedBenchmarks: this.results.filter(r => !r.success).length,
        averageTime: this.results.filter(r => r.success).reduce((sum, r) => sum + r.totalTime, 0) / 
                     Math.max(this.results.filter(r => r.success).length, 1)
      }
    };

    try {
      writeFileSync(outputFile, JSON.stringify(data, null, 2));
      console.log(`\n💾 Results saved to: ${outputFile}`);
    } catch (error) {
      console.error(`Failed to save results: ${error}`);
    }
  }
}

// CLI Interface
program
  .name('simple-noir-benchmark')
  .description('Simple benchmark tool for Noir circuits')
  .version('1.0.0');

program
  .argument('[circuit-paths...]', 'Paths to Noir circuit directories')
  .option('-s, --save <filename>', 'Save results to specific file')
  .option('--no-report', 'Skip generating text report')
  .action(async (circuitPaths: string[], options) => {
    // Default to all circuits if none specified
    if (circuitPaths.length === 0) {
      circuitPaths = [
        'noir/bin/signature',
        'noir/bin/encode', 
        'noir/bin/verify_inclusion'
      ];
    }

    const benchmark = new SimpleNoirBenchmark();
    
    try {
      const results = await benchmark.benchmarkAll(circuitPaths);
      
      if (options.report !== false) {
        const report = benchmark.generateReport();
        console.log(report);
      }
      
      if (options.save || results.length > 0) {
        benchmark.saveResults(options.save);
      }
      
    } catch (error) {
      console.error(`❌ Benchmark failed: ${error}`);
      process.exit(1);
    }
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}

export { SimpleNoirBenchmark };
