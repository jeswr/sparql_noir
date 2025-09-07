#!/usr/bin/env node
import { program } from 'commander';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { execSync, spawn } from 'child_process';
import { performance } from 'perf_hooks';
class NoirBackendBenchmark {
    circuitPath;
    outputDir;
    results = [];
    backends = [
        {
            name: 'barretenberg',
            command: 'bb',
            proveCommand: (circuit, witness) => `bb prove -b ${circuit} -w ${witness} -o proof`,
            verifyCommand: (proof, vk) => `bb verify -k ${vk} -p ${proof}`,
            setupRequired: true,
            setupCommand: (circuit) => `bb write_vk -b ${circuit} -o vk`,
            installed: false,
            installInstructions: 'Install via: npm install -g @aztec/bb.js'
        },
        {
            name: 'plonky2-blocksense',
            command: 'plonky2',
            proveCommand: (circuit, witness) => `plonky2 prove ${circuit} ${witness}`,
            verifyCommand: (proof, vk) => `plonky2 verify ${proof} ${vk}`,
            setupRequired: false,
            installed: false,
            installInstructions: 'Install from: https://github.com/blocksense-network/noir-plonky2'
        },
        {
            name: 'sonobe',
            command: 'sonobe',
            proveCommand: (circuit, witness) => `sonobe prove --circuit ${circuit} --witness ${witness}`,
            verifyCommand: (proof, vk) => `sonobe verify --proof ${proof} --vk ${vk}`,
            setupRequired: true,
            setupCommand: (circuit) => `sonobe setup --circuit ${circuit}`,
            installed: false,
            installInstructions: 'Install from: https://github.com/privacy-scaling-explorations/sonobe'
        }
    ];
    constructor(circuitPath, outputDir = './benchmark-results') {
        this.circuitPath = circuitPath;
        this.outputDir = outputDir;
        this.checkBackendAvailability();
    }
    checkBackendAvailability() {
        for (const backend of this.backends) {
            try {
                execSync(`which ${backend.command}`, { stdio: 'ignore' });
                backend.installed = true;
                console.log(`✓ ${backend.name} is available`);
            }
            catch {
                console.log(`✗ ${backend.name} is not installed`);
                console.log(`  ${backend.installInstructions}`);
            }
        }
    }
    async compileCircuit() {
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
        }
        catch (error) {
            throw new Error(`Failed to compile circuit: ${error}`);
        }
    }
    async generateWitness() {
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
                // Generate a real signature using the sign.ts script
                const tempDataPath = join(circuitDir, 'temp_data.ttl');
                const tempOutputPath = join(circuitDir, 'temp_output.json');
                // Create minimal RDF data
                writeFileSync(tempDataPath, '@prefix ex: <http://example.org/> .\nex:subject ex:predicate "test" .\n');
                // Run the sign script to generate valid inputs
                execSync(`npm run build:tsc`, { stdio: 'pipe' });
                execSync(`node dist/scripts/sign.js -i ${tempDataPath} -o ${tempOutputPath}`, { stdio: 'pipe' });
                // Read the generated data and create Prover.toml
                const signedData = JSON.parse(readFileSync(tempOutputPath, 'utf8'));
                let tomlContent = '# Valid inputs generated for benchmarking\n\n';
                // Convert the signed data to TOML format
                function addTomlValue(key, value, parentPath = '') {
                    const fullKey = parentPath ? `${parentPath}.${key}` : key;
                    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                        // Nested object - use dotted notation
                        for (const [subKey, subValue] of Object.entries(value)) {
                            addTomlValue(subKey, subValue, fullKey);
                        }
                    }
                    else if (typeof value === 'string') {
                        tomlContent += `${fullKey} = "${value}"\n`;
                    }
                    else {
                        tomlContent += `${fullKey} = ${JSON.stringify(value)}\n`;
                    }
                }
                addTomlValue('public_key', signedData.pubKey);
                addTomlValue('root', { value: signedData.root, signature: signedData.signature });
                writeFileSync(proverTomlPath, tomlContent);
                // Clean up temp files
                try {
                    if (existsSync(tempDataPath))
                        unlinkSync(tempDataPath);
                    if (existsSync(tempOutputPath))
                        unlinkSync(tempOutputPath);
                }
                catch {
                    // Ignore cleanup errors
                }
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
        }
        catch (error) {
            throw new Error(`Failed to generate witness: ${error}`);
        }
    }
    async benchmarkBackend(backend) {
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
            let setupTime = 0;
            if (backend.setupRequired && backend.setupCommand) {
                console.log(`Setting up ${backend.name}...`);
                const setupStart = performance.now();
                execSync(backend.setupCommand(circuitBinary), { stdio: 'inherit' });
                setupTime = performance.now() - setupStart;
            }
            // Prove
            console.log(`Proving with ${backend.name}...`);
            const proveStart = performance.now();
            execSync(backend.proveCommand(circuitBinary, witnessPath), { stdio: 'inherit' });
            const proveTime = performance.now() - proveStart;
            // Verify
            console.log(`Verifying with ${backend.name}...`);
            const verifyStart = performance.now();
            const vkPath = backend.setupRequired ? 'vk' : '';
            execSync(backend.verifyCommand('proof', vkPath), { stdio: 'inherit' });
            const verifyTime = performance.now() - verifyStart;
            // Get proof size if proof file exists
            let proofSize;
            try {
                const proofData = readFileSync('proof');
                proofSize = proofData.length;
            }
            catch {
                // Proof size not available
            }
            return {
                backend: backend.name,
                compileTime,
                proveTime,
                verifyTime,
                proofSize,
                success: true,
                witnessGenTime,
                setupTime
            };
        }
        catch (error) {
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
    async runBenchmarks(selectedBackends) {
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
    generateReport() {
        const successful = this.results.filter(r => r.success);
        const failed = this.results.filter(r => !r.success);
        let report = '\n📊 BENCHMARK RESULTS\n';
        report += '='.repeat(50) + '\n\n';
        if (successful.length > 0) {
            report += '✅ Successful Runs:\n';
            report += '| Backend | Compile (ms) | Witness (ms) | Setup (ms) | Prove (ms) | Verify (ms) | Proof Size (bytes) |\n';
            report += '|---------|--------------|--------------|------------|------------|-------------|-------------------|\n';
            for (const result of successful) {
                const setup = result.setupTime ? result.setupTime.toFixed(2) : 'N/A';
                const witness = result.witnessGenTime ? result.witnessGenTime.toFixed(2) : 'N/A';
                const proof = result.proofSize ? result.proofSize.toString() : 'N/A';
                report += `| ${result.backend.padEnd(7)} | ${result.compileTime.toFixed(2).padStart(10)} | ${witness.padStart(10)} | ${setup.padStart(8)} | ${result.proveTime.toFixed(2).padStart(8)} | ${result.verifyTime.toFixed(2).padStart(9)} | ${proof.padStart(15)} |\n`;
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
    saveResults(filename) {
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
        }
        catch (error) {
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
    .action(async (circuitPath, options) => {
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
    }
    catch (error) {
        console.error(`❌ Benchmark failed: ${error}`);
        process.exit(1);
    }
});
program
    .command('list-backends')
    .description('List all available backends and their installation status')
    .action(() => {
    const benchmark = new NoirBackendBenchmark('.');
    console.log('\n📋 Available Backends:\n');
    // This will trigger the availability check in the constructor
});
program
    .command('install-help')
    .description('Show installation instructions for all backends')
    .action(() => {
    console.log('\n🔧 Backend Installation Guide:\n');
    const installGuide = [
        {
            name: 'Barretenberg (Current)',
            instructions: [
                'npm install -g @aztec/bb.js',
                'Or use the bb binary directly from Aztec'
            ]
        },
        {
            name: 'Plonky2 (Blocksense)',
            instructions: [
                'git clone https://github.com/blocksense-network/noir-plonky2',
                'cd noir-plonky2',
                'cargo install --path .'
            ]
        },
        {
            name: 'Sonobe',
            instructions: [
                'git clone https://github.com/privacy-scaling-explorations/sonobe',
                'cd sonobe',
                'cargo install --path .'
            ]
        }
    ];
    installGuide.forEach(backend => {
        console.log(`${backend.name}:`);
        backend.instructions.forEach(cmd => console.log(`  ${cmd}`));
        console.log();
    });
});
if (import.meta.url === `file://${process.argv[1]}`) {
    program.parse();
}
export { NoirBackendBenchmark, BenchmarkResult, BackendConfig };
//# sourceMappingURL=benchmark-backends.js.map