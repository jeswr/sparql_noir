#!/usr/bin/env node
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
}
declare class NoirBackendBenchmark {
    private circuitPath;
    private outputDir;
    private results;
    private backends;
    constructor(circuitPath: string, outputDir?: string);
    private checkBackendAvailability;
    private compileCircuit;
    private generateWitness;
    private benchmarkBackend;
    runBenchmarks(selectedBackends?: string[]): Promise<BenchmarkResult[]>;
    generateReport(): string;
    saveResults(filename?: string): void;
}
export { NoirBackendBenchmark, BenchmarkResult, BackendConfig };
//# sourceMappingURL=benchmark-backends.d.ts.map