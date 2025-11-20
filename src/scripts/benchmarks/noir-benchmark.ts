#!/usr/bin/env tsx

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { performance } from 'perf_hooks';
import chalk from 'chalk';

interface BenchmarkResult {
  circuitName: string;
  compilationTime: number;
  witnessGenerationTime: number;
  provingTime: number;
  verificationTime: number;
  totalTime: number;
  success: boolean;
  error?: string;
  circuitSize?: number;
  proofSize?: number;
  runs: number;
}

/**
 * Professional-grade Noir circuit benchmarking tool
 * Inspired by noir-benchmark-cli but tailored for this project
 */
class NoirBenchmarkRunner {
  private results: BenchmarkResult[] = [];

  async benchmarkCircuit(circuitPath: string, runs: number = 1): Promise<BenchmarkResult> {
    const circuitName = basename(circuitPath);
    
    console.log(chalk.cyan(`\n🔬 Benchmarking circuit: ${circuitName} (${runs} run${runs > 1 ? 's' : ''})`));
    console.log(chalk.gray('━'.repeat(80)));

    let totalCompilationTime = 0;
    let totalWitnessTime = 0;
    let totalProvingTime = 0;
    let totalVerificationTime = 0;
    let circuitSize = 0;
    let proofSize = 0;

    let cleanup: (() => void) | undefined;

    try {
      cleanup = await this.prepareCircuitSourceIfNeeded(circuitPath, circuitName);

      // 1. One-time compilation (not averaged across runs)
      console.log(chalk.yellow('📋 Compiling circuit...'));
      const compileStart = performance.now();
      execSync('nargo build', { 
        cwd: circuitPath,
        stdio: 'pipe'
      });
      totalCompilationTime = performance.now() - compileStart;

      // Get circuit size
      const circuitJsonPath = join(circuitPath, 'target', `${circuitName}.json`);
      if (existsSync(circuitJsonPath)) {
        const circuitData = JSON.parse(readFileSync(circuitJsonPath, 'utf8'));
        circuitSize = circuitData.bytecode ? circuitData.bytecode.length : 0;
      }

      // 2. Prepare inputs for circuits that need them
      await this.prepareInputsIfNeeded(circuitPath, circuitName);

      // 3. Run multiple benchmarks
      for (let run = 1; run <= runs; run++) {
        console.log(chalk.blue(`\n🏃 Run ${run}/${runs}`));

        // Witness generation
        console.log(chalk.yellow('⚡ Generating witness...'));
        const witnessStart = performance.now();
        execSync('nargo execute', {
          cwd: circuitPath,
          stdio: 'pipe'
        });
        totalWitnessTime += performance.now() - witnessStart;

        // Only do proof generation/verification for signature circuit for now
        if (circuitName === 'signature') {
          const benchmarkResults = await this.runProofBenchmark(circuitPath, circuitName);
          totalProvingTime += benchmarkResults.provingTime;
          totalVerificationTime += benchmarkResults.verificationTime;
          if (run === 1) proofSize = benchmarkResults.proofSize;
        }

        // Progress indicator
        const progress = (run / runs * 100).toFixed(0);
        process.stdout.write(chalk.green(`✓ ${progress}% complete\r`));
      }

      console.log('\n');

      const avgWitnessTime = totalWitnessTime / runs;
      const avgProvingTime = totalProvingTime / runs;
      const avgVerificationTime = totalVerificationTime / runs;
      const totalTime = totalCompilationTime + avgWitnessTime + avgProvingTime + avgVerificationTime;

      console.log(chalk.green('✅ Benchmark completed successfully'));
      console.log(chalk.gray('━'.repeat(80)));

      return {
        circuitName,
        compilationTime: totalCompilationTime,
        witnessGenerationTime: avgWitnessTime,
        provingTime: avgProvingTime,
        verificationTime: avgVerificationTime,
        totalTime,
        success: true,
        circuitSize,
        proofSize,
        runs
      };

    } catch (error) {
      console.log(chalk.red('❌ Benchmark failed'));
      return {
        circuitName,
        compilationTime: totalCompilationTime,
        witnessGenerationTime: 0,
        provingTime: 0,
        verificationTime: 0,
        totalTime: totalCompilationTime,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        runs
      };
    } finally {
      if (cleanup) {
        try {
          cleanup();
        } catch (cleanupError) {
          console.log(chalk.yellow(`⚠️  Failed to clean up temporary files for ${circuitName}: ${cleanupError}`));
        }
      }
    }
  }

  private async prepareInputsIfNeeded(circuitPath: string, circuitName: string) {
    if (circuitName === 'signature') {
      const proverTomlPath = join(circuitPath, 'Prover.toml');
      if (!existsSync(proverTomlPath)) {
        console.log(chalk.yellow('📝 Preparing signature inputs...'));
        const signedData = this.ensureSignedData();
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
        console.log(chalk.green('  ✓ Signature inputs prepared'));
      }
      return;
    }

    if (circuitName === 'verify_inclusion') {
      const proverTomlPath = join(circuitPath, 'Prover.toml');
      if (!existsSync(proverTomlPath)) {
        console.log(chalk.yellow('📝 Preparing verify_inclusion inputs...'));
        const signedData = this.ensureSignedData();
        const tripleTerms = signedData.triples?.[0];
        const triplePath = signedData.paths?.[0];
        const tripleDirections = signedData.direction?.[0];

        if (!tripleTerms || !triplePath || !tripleDirections || !signedData.root) {
          throw new Error('Sample data missing Merkle components required for verify_inclusion');
        }

        const { serializeProve } = await import('../../serializeProve.js');
        const inputs = {
          root_value: signedData.root,
          triple: {
            terms: tripleTerms,
            path: triplePath,
            directions: tripleDirections.map((value: number) => Number(value)),
          }
        };

        const tomlContent = '# Generated for benchmarking\n\n' + serializeProve(inputs);
        writeFileSync(proverTomlPath, tomlContent);
        console.log(chalk.green('  ✓ verify_inclusion inputs prepared'));
      }
    }
  }

  private ensureSignedData() {
    const mainJsonPath = join(process.cwd(), 'temp', 'main.json');
    if (!existsSync(mainJsonPath)) {
      console.log(chalk.gray('  Running example to generate canonical dataset...'));
      execSync('npm run example:sign', { stdio: 'pipe' });
    }
    return JSON.parse(readFileSync(mainJsonPath, 'utf8'));
  }

  private async prepareCircuitSourceIfNeeded(circuitPath: string, circuitName: string) {
    if (circuitName !== 'encode')
      return;

    const mainPath = join(circuitPath, 'src', 'main.nr');
    if (existsSync(mainPath))
      return;

    const templatePath = `${mainPath}.template`;
    if (!existsSync(templatePath)) {
      throw new Error(`Encode template not found at ${templatePath}`);
    }

    console.log(chalk.yellow('🛠️  Preparing encode circuit source...'));
    const template = readFileSync(templatePath, 'utf8');
    const populated = template.replace('{{fn}}', this.buildEncodeBenchmarkExpression());

    if (populated.includes('{{')) {
      throw new Error('Failed to populate encode benchmark template');
    }

    writeFileSync(mainPath, populated);
    console.log(chalk.green('  ✓ Temporary encode main.nr created'));

    return () => {
      if (existsSync(mainPath)) {
        rmSync(mainPath);
      }
    };
  }

  private buildEncodeBenchmarkExpression() {
    const triples = [
      '[1, 2, 3, 4]',
      '[5, 6, 7, 8]',
      '[9, 10, 11, 12]',
      '[13, 14, 15, 16]'
    ];
    return `utils::merkle::<consts::MERKLE_DEPTH, ${triples.length}>([${triples.join(', ')}])`;
  }

  private async runProofBenchmark(circuitPath: string, circuitName: string): Promise<{
    provingTime: number;
    verificationTime: number;
    proofSize: number;
  }> {
    console.log(chalk.yellow('🔐 Generating proof...'));
    
    const mainJsonPath = join(process.cwd(), 'temp', 'main.json');
    const circuitJsonPath = join(circuitPath, 'target', `${circuitName}.json`);
    
    const signedData = JSON.parse(readFileSync(mainJsonPath, 'utf8'));
    const circuitData = JSON.parse(readFileSync(circuitJsonPath, 'utf8'));
    
    const { Noir } = await import('@noir-lang/noir_js');
    const { UltraHonkBackend } = await import('@aztec/bb.js');
    
    const noir = new Noir(circuitData);
    const backend = new UltraHonkBackend(circuitData.bytecode, { threads: 6 });
    
    const inputs = {
      public_key: signedData.pubKey,
      root: {
        value: signedData.root,
        signature: signedData.signature,
      },
    };
    
    // Generate witness for proving
    const { witness } = await noir.execute(inputs);
    
    // Measure proof generation
    const proveStart = performance.now();
    const proof = await backend.generateProof(witness);
    const provingTime = performance.now() - proveStart;
    
    // Measure verification
    console.log(chalk.yellow('🔍 Verifying proof...'));
    const verifyStart = performance.now();
    const isValid = await backend.verifyProof(proof);
    const verificationTime = performance.now() - verifyStart;
    
    backend.destroy();
    
    if (!isValid) {
      throw new Error('Proof verification failed');
    }
    
    return {
      provingTime,
      verificationTime,
      proofSize: proof.proof ? proof.proof.length : 0
    };
  }

  async runBenchmarks(circuitPaths: string[], runs: number = 1): Promise<BenchmarkResult[]> {
    console.log(chalk.bold.cyan('\n╔═══════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║         NOIR CIRCUIT BENCHMARK       ║'));
    console.log(chalk.bold.cyan('║      Professional Performance Tool   ║'));
    console.log(chalk.bold.cyan('╚═══════════════════════════════════════╝'));
    
    console.log(chalk.gray(`\n🎯 Benchmarking ${circuitPaths.length} circuit(s) with ${runs} run(s) each\n`));

    for (const circuitPath of circuitPaths) {
      if (!existsSync(circuitPath)) {
        console.log(chalk.red(`❌ Circuit path does not exist: ${circuitPath}`));
        continue;
      }

      const result = await this.benchmarkCircuit(circuitPath, runs);
      this.results.push(result);
    }

    return this.results;
  }

  generateReport(): string {
    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);

    let report = chalk.bold.green('\n📊 BENCHMARK RESULTS SUMMARY\n');
    report += chalk.gray('='.repeat(100) + '\n\n');

    if (successful.length > 0) {
      report += chalk.green('✅ Successful Benchmarks:\n\n');
      report += '| Circuit       | Runs | Compile (ms) | Witness (ms) | Prove (ms) | Verify (ms) | Total (ms) | Size (bytes) |\n';
      report += '|---------------|------|--------------|--------------|------------|-------------|------------|---------------|\n';
      
      for (const result of successful) {
        const circuit = result.circuitName.padEnd(13);
        const runs = result.runs.toString().padStart(4);
        const compile = result.compilationTime.toFixed(2).padStart(10);
        const witness = result.witnessGenerationTime.toFixed(2).padStart(10);
        const prove = result.provingTime.toFixed(2).padStart(8);
        const verify = result.verificationTime.toFixed(2).padStart(9);
        const total = result.totalTime.toFixed(2).padStart(8);
        const size = (result.proofSize || 0).toString().padStart(11);
        
        report += `| ${circuit} | ${runs} | ${compile} | ${witness} | ${prove} | ${verify} | ${total} | ${size} |\n`;
      }
      
      if (successful.length > 1) {
        report += chalk.yellow('\n🏆 Performance Ranking:\n');
        const sorted = [...successful].sort((a, b) => a.totalTime - b.totalTime);
        sorted.forEach((result, index) => {
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
          report += `${medal} ${result.circuitName}: ${result.totalTime.toFixed(2)}ms total\n`;
        });
      }
    }

    if (failed.length > 0) {
      report += chalk.red('\n❌ Failed Benchmarks:\n');
      for (const result of failed) {
        report += chalk.red(`• ${result.circuitName}: ${result.error}\n`);
      }
    }

    report += chalk.gray('\n📝 Notes:\n');
    report += chalk.gray('• All times are in milliseconds\n');
    report += chalk.gray('• Compilation time is measured once, other metrics are averaged across runs\n');
    report += chalk.gray('• Proof generation/verification currently only supported for signature circuit\n');
    report += chalk.gray('• Results may vary between runs due to system load\n');

    return report;
  }

  saveResults(filename?: string): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = filename || `benchmark-results-${timestamp}.json`;
    
    const data = {
      timestamp: new Date().toISOString(),
      tool: 'noir-circuit-benchmark',
      version: '1.0.0',
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
      console.log(chalk.green(`\n💾 Results saved to: ${outputFile}`));
    } catch (error) {
      console.error(chalk.red(`Failed to save results: ${error}`));
    }
  }
}

// CLI Interface
const program = new Command();

program
  .name('noir-benchmark')
  .description('Professional-grade benchmarking tool for Noir circuits')
  .version('1.0.0');

program
  .command('benchmark')
  .description('Run benchmark on Noir circuits')
  .argument('[circuit-paths...]', 'Paths to Noir circuit directories')
  .option('-r, --runs <number>', 'Number of benchmark runs to average', '1')
  .option('-s, --save <filename>', 'Save results to specific file')
  .option('--no-report', 'Skip generating text report')
  .action(async (circuitPaths: string[], options) => {
    const runs = parseInt(options.runs, 10);
    if (isNaN(runs) || runs < 1) {
      console.error(chalk.red('❌ Runs must be a positive number'));
      process.exit(1);
    }

    // Default to all circuits if none specified
    if (circuitPaths.length === 0) {
      circuitPaths = [
        'noir/bin/signature',
        'noir/bin/encode', 
        'noir/bin/verify_inclusion'
      ];
    }

    const benchmark = new NoirBenchmarkRunner();
    
    try {
      const results = await benchmark.runBenchmarks(circuitPaths, runs);
      
      if (options.report !== false) {
        const report = benchmark.generateReport();
        console.log(report);
      }
      
      if (options.save || results.length > 0) {
        benchmark.saveResults(options.save);
      }
      
    } catch (error) {
      console.error(chalk.red(`❌ Benchmark failed: ${error}`));
      process.exit(1);
    }
  });

program
  .command('list-circuits')
  .description('List available circuits for benchmarking')
  .action(() => {
    console.log(chalk.cyan('📋 Available Circuits:\n'));
    const circuits = [
      'noir/bin/signature - Digital signature verification circuit',
      'noir/bin/encode - RDF term encoding circuit', 
      'noir/bin/verify_inclusion - Merkle tree inclusion proof circuit'
    ];
    
    circuits.forEach(circuit => {
      console.log(chalk.green(`  • ${circuit}`));
    });
    
    console.log(chalk.gray('\n💡 Usage: npx tsx noir-benchmark.ts benchmark [circuit-paths...]'));
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}

export { NoirBenchmarkRunner };