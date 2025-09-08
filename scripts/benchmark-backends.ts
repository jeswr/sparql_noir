#!/usr/bin/env node

import { program } from 'commander';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { execSync, spawn } from 'child_process';
import { performance } from 'perf_hooks';

interface BenchmarkResult {
  backend: string;
  compileTime: number;
  proveTime: number;
  verifyTime: number;
  proofSize?: number;
  success: boolean;
  error?: string;
  witnessGenTime?: number;
  setupTime?: number;
}

interface BackendConfig {
  name: string;
  command: string;
  proveCommand: (circuitPath: string, witnessPath: string) => string;
  verifyCommand: (proofPath: string, vkPath: string) => string;
  setupRequired: boolean;
  setupCommand?: (circuitPath: string) => string;
  installed: boolean;
  installInstructions: string;
  installable: boolean;
  installCommand?: () => Promise<boolean>;
  checkCommand?: () => boolean;
}

class NoirBackendBenchmark {
  private circuitPath: string;
  private outputDir: string;
  private results: BenchmarkResult[] = [];
  
  private backends: BackendConfig[] = [
    {
      name: 'barretenberg-ultrahonk',
      command: 'bb',
      proveCommand: (circuit, witness) => `mkdir -p bb_proof && bb prove --scheme ultra_honk --bytecode_path ${circuit} --witness_path ${witness} --output_path bb_proof`,
      verifyCommand: (proof, vk) => `bb verify --scheme ultra_honk --proof_path bb_proof/proof --vk_path bb_vk/vk --public_inputs_path bb_proof/public_inputs`,
      setupRequired: true,
      setupCommand: (circuit) => `mkdir -p bb_vk && bb write_vk --scheme ultra_honk --bytecode_path ${circuit} --output_path bb_vk`,
      installed: false,
      installInstructions: 'Install via: bbup (Barretenberg CLI)',
      installable: true,
      checkCommand: () => {
        try {
          execSync('bb --version', { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      },
      installCommand: async () => {
        try {
          console.log('🔧 Installing Barretenberg CLI...');
          
          // Install bbup
          console.log('📥 Downloading bbup installer...');
          execSync('curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/bbup/install | bash', { stdio: 'inherit' });
          
          // Install bb
          console.log('📦 Installing Barretenberg...');
          execSync('bbup', { stdio: 'inherit' });
          
          console.log('✅ Barretenberg CLI installed successfully');
          return true;
        } catch (error) {
          console.error('❌ Failed to install Barretenberg CLI:', error);
          return false;
        }
      }
    },
    {
      name: 'plonky2-blocksense',
      command: 'nargo',
      proveCommand: (circuit, witness) => `nargo prove`,
      verifyCommand: (proof, vk) => `nargo verify`,
      setupRequired: false,
      installed: false,
      installInstructions: 'Install Blocksense Noir fork with Plonky2 support',
      installable: true,
      checkCommand: () => {
        // Currently we have standard nargo, not the Blocksense fork
        // This would need the actual Blocksense fork to work properly
        return false;
      },
      installCommand: async () => {
        try {
          console.log('🔧 Installing Blocksense Noir with Plonky2 support...');
          console.log('⚠️  Note: This installation requires Rust and may take 10+ minutes');
          
          const tempDir = '/tmp/blocksense-noir-install';
          
          console.log('📥 Cloning Blocksense Noir repository...');
          execSync(`git clone https://github.com/blocksense-network/noir.git ${tempDir}`, { stdio: 'inherit' });
          
          console.log('🔨 Building Blocksense Noir (this may take several minutes)...');
          console.log('💡 Excluding fuzzer module to avoid compilation errors...');
          
          // First, try to build without the fuzzer package that causes errors
          try {
            console.log('🎯 Attempting build excluding fuzzer...');
            execSync('cargo build --release --bin nargo --exclude noir_fuzzer', { cwd: tempDir, stdio: 'inherit' });
          } catch {
            try {
              console.log('🎯 Trying with workspace exclusions...');
              execSync('cargo build --release --workspace --exclude noir_fuzzer --exclude noir_greybox_fuzzer --bin nargo', { cwd: tempDir, stdio: 'inherit' });
            } catch {
              console.log('🎯 Trying direct nargo_cli build...');
              execSync('cargo build --release --manifest-path tooling/nargo_cli/Cargo.toml', { cwd: tempDir, stdio: 'inherit' });
            }
          }
          
          console.log('📦 Installing nargo binary...');
          try {
            execSync(`cargo install --path tooling/nargo_cli --bin nargo --force`, { cwd: tempDir, stdio: 'inherit' });
          } catch {
            // If install fails, try copying the binary directly
            console.log('🔄 Trying alternative installation method...');
            const binaryPath = `${tempDir}/target/release/nargo`;
            const installPath = `${process.env.HOME}/.cargo/bin/nargo`;
            execSync(`cp ${binaryPath} ${installPath}`, { stdio: 'inherit' });
            execSync(`chmod +x ${installPath}`, { stdio: 'inherit' });
          }
          
          console.log('🧹 Cleaning up...');
          execSync(`rm -rf ${tempDir}`, { stdio: 'ignore' });
          
          console.log('✅ Blocksense Noir installed successfully');
          console.log('📝 Note: Use --backend plonky2 flag with nargo for Plonky2 proving');
          return true;
        } catch (error) {
          console.error('❌ Failed to install Blocksense Noir:', error);
          console.log('💡 You may need to install Rust first: https://rustup.rs/');
          return false;
        }
      }
    },
    {
      name: 'sonobe',
      command: 'solidity-verifiers-cli',
      proveCommand: (circuit, witness) => `echo "Sonobe requires custom integration - not a direct CLI tool"`,
      verifyCommand: (proof, vk) => `echo "Sonobe is for folding schemes, not direct verification"`,
      setupRequired: true,
      setupCommand: (circuit) => `echo "Sonobe setup requires custom circuit integration"`,
      installed: false,
      installInstructions: 'Sonobe is a library for folding schemes (Nova/HyperNova), not a direct CLI backend',
      installable: true,
      checkCommand: () => {
        try {
          execSync('solidity-verifiers-cli --version', { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      },
      installCommand: async () => {
        try {
          console.log('🔧 Installing Sonobe folding schemes...');
          console.log('⚠️  Note: This installation requires Rust and may take 10+ minutes');
          
          const tempDir = '/tmp/sonobe-install';
          
          console.log('📥 Cloning Sonobe repository...');
          execSync(`git clone https://github.com/privacy-scaling-explorations/sonobe.git ${tempDir}`, { stdio: 'inherit' });
          
          console.log('🔨 Building Sonobe (this may take several minutes)...');
          execSync('cargo build --release', { cwd: tempDir, stdio: 'inherit' });
          
          console.log('📦 Installing Sonobe CLI...');
          execSync(`cargo install --path cli --bin solidity-verifiers-cli --force`, { cwd: tempDir, stdio: 'inherit' });
          
          console.log('🧹 Cleaning up...');
          execSync(`rm -rf ${tempDir}`, { stdio: 'ignore' });
          
          console.log('✅ Sonobe installed successfully');
          return true;
        } catch (error) {
          console.error('❌ Failed to install Sonobe:', error);
          console.log('💡 You may need to install Rust first: https://rustup.rs/');
          return false;
        }
      }
    },
    {
      name: 'nargo-default',
      command: 'nargo',
      proveCommand: (circuit, witness) => `nargo prove`,
      verifyCommand: (proof, vk) => `nargo verify`,
      setupRequired: false,
      installed: false,
      installInstructions: 'Standard Noir installation with default backend',
      installable: false, // Usually comes with Noir installation
      checkCommand: () => {
        try {
          execSync('nargo --version', { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      }
    }
  ];

  constructor(circuitPath: string, outputDir: string = './benchmark-results') {
    this.circuitPath = circuitPath;
    this.outputDir = outputDir;
    this.checkBackendAvailability();
  }

  private checkBackendAvailability(): void {
    for (const backend of this.backends) {
      if (backend.checkCommand) {
        backend.installed = backend.checkCommand();
      } else {
        try {
          execSync(`which ${backend.command}`, { stdio: 'ignore' });
          backend.installed = true;
        } catch {
          backend.installed = false;
        }
      }
      
      if (backend.installed) {
        console.log(`✓ ${backend.name} is available`);
      } else {
        console.log(`✗ ${backend.name} is not installed`);
        if (backend.installable) {
          console.log(`  ${backend.installInstructions} (use --install to install)`);
        } else {
          console.log(`  ${backend.installInstructions}`);
        }
      }
    }
  }

  async installBackend(backendName: string): Promise<boolean> {
    const backend = this.backends.find(b => b.name === backendName);
    if (!backend) {
      console.error(`❌ Backend '${backendName}' not found`);
      return false;
    }

    if (!backend.installable || !backend.installCommand) {
      console.error(`❌ Backend '${backendName}' is not installable via this script`);
      console.log(`💡 Manual installation required: ${backend.installInstructions}`);
      return false;
    }

    if (backend.installed) {
      console.log(`✅ Backend '${backendName}' is already installed`);
      return true;
    }

    console.log(`🚀 Installing backend: ${backendName}`);
    const success = await backend.installCommand();
    
    if (success) {
      // Re-check availability after installation
      if (backend.checkCommand) {
        backend.installed = backend.checkCommand();
      } else {
        try {
          execSync(`which ${backend.command}`, { stdio: 'ignore' });
          backend.installed = true;
        } catch {
          backend.installed = false;
        }
      }
    }

    return success;
  }

  async installAllBackends(): Promise<void> {
    console.log('🔧 Installing all available backends...');
    
    for (const backend of this.backends) {
      if (backend.installable && !backend.installed) {
        console.log(`\n${'='.repeat(50)}`);
        await this.installBackend(backend.name);
      }
    }
    
    console.log(`\n${'='.repeat(50)}`);
    console.log('📋 Final backend status:');
    this.checkBackendAvailability();
  }

  listInstallableBackends(): void {
    console.log('📦 Available backends for installation:\n');
    
    for (const backend of this.backends) {
      const status = backend.installed ? '✅ Installed' : '❌ Not installed';
      const installable = backend.installable ? '🔧 Auto-installable' : '📝 Manual install required';
      
      console.log(`${backend.name}:`);
      console.log(`  Status: ${status}`);
      console.log(`  Installation: ${installable}`);
      console.log(`  Instructions: ${backend.installInstructions}`);
      console.log('');
    }
    
    console.log('💡 Usage:');
    console.log('  Install specific backend: npm run benchmark -- install <backend-name>');
    console.log('  Install all backends: npm run benchmark -- install-all');
    console.log('  List backends: npm run benchmark -- list-backends');
  }

  private async compileCircuit(): Promise<number> {
    console.log('Compiling Noir circuit...');
    const startTime = performance.now();
    
    try {
      // Use circuitPath as the directory if it's a directory, otherwise use its parent
      const circuitDir = existsSync(join(this.circuitPath, 'Nargo.toml')) ? this.circuitPath : dirname(this.circuitPath);
      execSync('nargo build', { 
        cwd: circuitDir,
        stdio: 'inherit'
      });
      const endTime = performance.now();
      return endTime - startTime;
    } catch (error) {
      throw new Error(`Failed to compile circuit: ${error}`);
    }
  }

  private async generateWitness(): Promise<{ witnessPath: string; time: number }> {
    console.log('Generating witness...');
    const startTime = performance.now();
    
    try {
      // Use circuitPath as the directory if it's a directory, otherwise use its parent
      const circuitDir = existsSync(join(this.circuitPath, 'Nargo.toml')) ? this.circuitPath : dirname(this.circuitPath);
      const witnessPath = join(circuitDir, 'target', 'witness.gz');
      
      // Check if this is the signature circuit and if Prover.toml exists
      const circuitName = basename(circuitDir);
      const proverTomlPath = join(circuitDir, 'Prover.toml');
      
      if (circuitName === 'signature' && !existsSync(proverTomlPath)) {
        console.log('Creating valid inputs for signature circuit...');
        
        // Check if temp/main.json exists with valid data
        const mainJsonPath = join(process.cwd(), 'temp', 'main.json');
        let signedData: any;
        
        if (existsSync(mainJsonPath)) {
          // Use existing valid data from main.json
          signedData = JSON.parse(readFileSync(mainJsonPath, 'utf8'));
          console.log('Using existing signature data from temp/main.json');
        } else {
          // Generate new signature data
          console.log('Generating new signature data...');
          const tempDataPath = join(circuitDir, 'temp_data.ttl');
          const tempOutputPath = join(circuitDir, 'temp_output.json');
          
          // Create minimal RDF data
          writeFileSync(tempDataPath, '@prefix ex: <http://example.org/> .\nex:subject ex:predicate "test" .\n');
          
          // Run the sign script to generate valid inputs
          execSync(`npm run build:tsc`, { stdio: 'pipe' });
          execSync(`node dist/scripts/sign.js -i ${tempDataPath} -o ${tempOutputPath}`, { stdio: 'pipe' });
          
          // Read the generated data
          signedData = JSON.parse(readFileSync(tempOutputPath, 'utf8'));
          
          // Clean up temp files
          try {
            if (existsSync(tempDataPath)) unlinkSync(tempDataPath);
            if (existsSync(tempOutputPath)) unlinkSync(tempOutputPath);
          } catch {
            // Ignore cleanup errors
          }
        }
        
        // Use serializeProve to create the Prover.toml
        const { serializeProve } = await import('../src/serializeProve.js');
        
        const inputs = {
          public_key: signedData.pubKey,
          root: {
            value: signedData.root,
            signature: signedData.signature
          }
        };
        
        const tomlContent = '# Valid inputs generated for benchmarking\n# Using serializeProve.ts\n\n' + 
                           serializeProve(inputs);
        
        writeFileSync(proverTomlPath, tomlContent);
        console.log(`✓ Created valid Prover.toml using serializeProve`);
      }
      
      // Generate witness using nargo
      execSync('nargo execute', {
        cwd: circuitDir,
        stdio: 'inherit'
      });
      
      const endTime = performance.now();
      return {
        witnessPath,
        time: endTime - startTime
      };
    } catch (error) {
      throw new Error(`Failed to generate witness: ${error}`);
    }
  }

  private async warmupBackend(backend: BackendConfig, circuitDir: string, circuitBinary: string, witnessPath: string): Promise<void> {
    if (backend.name === 'barretenberg-ultrahonk') {
      console.log('🔧 Warming up Barretenberg threads...');
      
      try {
        // Import NoirJS modules for direct API access
        const { Noir } = await import('@noir-lang/noir_js');
        const { UltraHonkBackend } = await import('@aztec/bb.js');
        
        const circuitData = JSON.parse(readFileSync(circuitBinary, 'utf8'));
        const noir = new Noir(circuitData);
        const bbBackend = new UltraHonkBackend(circuitData.bytecode, { threads: 6 });
        
        // Check if we have valid inputs for warm-up
        const mainJsonPath = join(process.cwd(), 'temp', 'main.json');
        if (existsSync(mainJsonPath)) {
          const signedData = JSON.parse(readFileSync(mainJsonPath, 'utf8'));
          const warmupInputs = {
            public_key: signedData.pubKey,
            root: {
              value: signedData.root,
              signature: signedData.signature,
            },
          };
          
          // Quick warm-up operations (not timed)
          const { witness } = await noir.execute(warmupInputs);
          await bbBackend.generateProof(witness);
          
          console.log('✓ Backend threads warmed up');
        }
        
        bbBackend.destroy();
      } catch (error) {
        console.log('⚠️  Could not warm up backend, proceeding with cold start');
      }
    }
  }

  private async benchmarkBackend(backend: BackendConfig): Promise<BenchmarkResult> {
    console.log(`\n🔬 Benchmarking ${backend.name}...`);
    
    if (!backend.installed) {
      return {
        backend: backend.name,
        compileTime: 0,
        proveTime: 0,
        verifyTime: 0,
        success: false,
        error: 'Backend not installed'
      };
    }

    try {
      // Compile circuit (this is the same for all backends)
      const compileTime = await this.compileCircuit();
      
      // Generate witness
      const { witnessPath, time: witnessGenTime } = await this.generateWitness();
      
      // Use circuitPath as the directory if it's a directory, otherwise use its parent
      const circuitDir = existsSync(join(this.circuitPath, 'Nargo.toml')) ? this.circuitPath : dirname(this.circuitPath);
      const circuitBinary = join(circuitDir, 'target', `${basename(circuitDir)}.json`);
      const relativeBinary = `target/${basename(circuitDir)}.json`;
      const relativeWitness = `target/${basename(circuitDir)}.gz`;
      
      // Warm up the backend before timing (not included in measurements)
      await this.warmupBackend(backend, circuitDir, circuitBinary, witnessPath);
      
      let setupTime = 0;
      if (backend.setupRequired && backend.setupCommand) {
        console.log(`Setting up ${backend.name}...`);
        const setupStart = performance.now();
        execSync(backend.setupCommand(relativeBinary), { 
          stdio: 'inherit',
          cwd: circuitDir
        });
        setupTime = performance.now() - setupStart;
      }

      // Prove
      console.log(`Proving with ${backend.name}...`);
      const proveStart = performance.now();
      execSync(backend.proveCommand(relativeBinary, relativeWitness), { 
        stdio: 'inherit',
        cwd: circuitDir
      });
      const proveTime = performance.now() - proveStart;

      // Verify
      console.log(`Verifying with ${backend.name}...`);
      const verifyStart = performance.now();
      execSync(backend.verifyCommand('', ''), { 
        stdio: 'inherit',
        cwd: circuitDir
      });
      const verifyTime = performance.now() - verifyStart;

      // Get proof size if proof file exists
      let proofSize: number | undefined;
      try {
        const proofData = readFileSync(join(circuitDir, 'bb_proof', 'proof'));
        proofSize = proofData.length;
      } catch {
        // Proof size not available - try fallback locations
        try {
          const proofData = readFileSync(join(circuitDir, 'proof'));
          proofSize = proofData.length;
        } catch {
          // Proof size not available
        }
      }

      return {
        backend: backend.name,
        compileTime,
        proveTime,
        verifyTime,
        proofSize: proofSize || 0,
        success: true,
        witnessGenTime,
        setupTime
      };

    } catch (error) {
      return {
        backend: backend.name,
        compileTime: 0,
        proveTime: 0,
        verifyTime: 0,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async runBenchmarks(selectedBackends?: string[]): Promise<BenchmarkResult[]> {
    const backendsToTest = selectedBackends 
      ? this.backends.filter(b => selectedBackends.includes(b.name))
      : this.backends.filter(b => b.installed);

    if (backendsToTest.length === 0) {
      console.log('❌ No backends available for testing');
      return [];
    }

    console.log(`\n🚀 Starting benchmark for ${backendsToTest.length} backend(s)...`);
    console.log(`Circuit: ${this.circuitPath}`);

    for (const backend of backendsToTest) {
      const result = await this.benchmarkBackend(backend);
      this.results.push(result);
    }

    return this.results;
  }

  generateReport(): string {
    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);

    let report = '\n📊 BENCHMARK RESULTS\n';
    report += '='.repeat(100) + '\n\n';

    if (successful.length > 0) {
      report += '✅ Successful Runs:\n';
      report += '| Backend                | Compile (ms) | Witness (ms) | Setup (ms) | Prove (ms) | Verify (ms) | Proof Size (bytes) |\n';
      report += '|------------------------|--------------|--------------|------------|------------|-------------|--------------------|\n';
      
      for (const result of successful) {
        const setup = result.setupTime ? result.setupTime.toFixed(2) : 'N/A';
        const witness = result.witnessGenTime ? result.witnessGenTime.toFixed(2) : 'N/A';
        const proof = result.proofSize ? result.proofSize.toString() : 'N/A';
        const backend = result.backend.length > 22 ? result.backend.substring(0, 19) + '...' : result.backend;
        
        report += `| ${backend.padEnd(22)} | ${result.compileTime.toFixed(2).padStart(12)} | ${witness.padStart(12)} | ${setup.padStart(10)} | ${result.proveTime.toFixed(2).padStart(10)} | ${result.verifyTime.toFixed(2).padStart(11)} | ${proof.padStart(18)} |\n`;
      }
      
      // Performance comparison
      if (successful.length > 1) {
        report += '\n🏆 Performance Ranking:\n';
        const sortedByProve = [...successful].sort((a, b) => a.proveTime - b.proveTime);
        const sortedByVerify = [...successful].sort((a, b) => a.verifyTime - b.verifyTime);
        
        report += '\nFastest Proving:\n';
        sortedByProve.forEach((result, index) => {
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
          report += `${medal} ${result.backend}: ${result.proveTime.toFixed(2)}ms\n`;
        });
        
        report += '\nFastest Verification:\n';
        sortedByVerify.forEach((result, index) => {
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
          report += `${medal} ${result.backend}: ${result.verifyTime.toFixed(2)}ms\n`;
        });
      }
    }

    if (failed.length > 0) {
      report += '\n❌ Failed Runs:\n';
      for (const result of failed) {
        report += `• ${result.backend}: ${result.error}\n`;
      }
    }

    report += '\n📝 Notes:\n';
    report += '• Times are in milliseconds\n';
    report += '• Setup time is only applicable for backends that require it\n';
    report += '• Proof size may not be available for all backends\n';
    report += '• Results may vary between runs due to system load\n';

    return report;
  }

  saveResults(filename?: string): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = filename || join(this.outputDir, `benchmark-${timestamp}.json`);
    
    const data = {
      timestamp: new Date().toISOString(),
      circuit: this.circuitPath,
      results: this.results,
      summary: {
        totalBackends: this.backends.length,
        availableBackends: this.backends.filter(b => b.installed).length,
        successfulRuns: this.results.filter(r => r.success).length,
        failedRuns: this.results.filter(r => !r.success).length
      }
    };

    try {
      // Ensure output directory exists
      execSync(`mkdir -p ${dirname(outputFile)}`);
      writeFileSync(outputFile, JSON.stringify(data, null, 2));
      console.log(`\n💾 Results saved to: ${outputFile}`);
    } catch (error) {
      console.error(`Failed to save results: ${error}`);
    }
  }
}

// CLI Interface
program
  .name('noir-backend-benchmark')
  .description('Benchmark different Noir proving backends')
  .version('1.0.0');

program
  .argument('<circuit-path>', 'Path to the Noir circuit directory')
  .option('-b, --backends <backends...>', 'Specific backends to test (space-separated)')
  .option('-o, --output <path>', 'Output directory for results', './benchmark-results')
  .option('-s, --save <filename>', 'Save results to specific file')
  .option('--no-report', 'Skip generating text report')
  .action(async (circuitPath: string, options) => {
    if (!existsSync(circuitPath)) {
      console.error(`❌ Circuit path does not exist: ${circuitPath}`);
      process.exit(1);
    }

    const benchmark = new NoirBackendBenchmark(circuitPath, options.output);
    
    try {
      const results = await benchmark.runBenchmarks(options.backends);
      
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

program
  .command('list-backends')
  .description('List all available backends and their installation status')
  .action(() => {
    const benchmark = new NoirBackendBenchmark('.');
    benchmark.listInstallableBackends();
  });

program
  .command('install <backend>')
  .description('Install a specific backend')
  .action(async (backend: string) => {
    try {
      const benchmark = new NoirBackendBenchmark('.');
      const success = await benchmark.installBackend(backend);
      
      if (success) {
        console.log(`\n✅ Successfully installed ${backend}!`);
        console.log('💡 You can now run benchmarks with this backend.');
      } else {
        console.log(`\n❌ Failed to install ${backend}.`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`❌ Installation failed: ${error}`);
      process.exit(1);
    }
  });

program
  .command('install-all')
  .description('Install all available backends')
  .action(async () => {
    try {
      const benchmark = new NoirBackendBenchmark('.');
      await benchmark.installAllBackends();
      console.log('\n🎉 Installation process completed!');
    } catch (error) {
      console.error(`❌ Installation failed: ${error}`);
      process.exit(1);
    }
  });

program
  .command('install-help')
  .description('Show installation instructions for all backends')
  .action(() => {
    const benchmark = new NoirBackendBenchmark('.');
    benchmark.listInstallableBackends();
    
    console.log('\n🔧 Manual Installation Requirements:\n');
    console.log('• Rust: https://rustup.rs/ (required for Sonobe and Blocksense)');
    console.log('• Go: https://golang.org/ (required for Gnark backend)');
    console.log('• Node.js: https://nodejs.org/ (required for Barretenberg)');
    console.log('\n💡 Most backends can be auto-installed using the install commands above.');
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}

export { NoirBackendBenchmark };
export type { BenchmarkResult, BackendConfig };
