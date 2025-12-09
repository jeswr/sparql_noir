#!/usr/bin/env node
/**
 * SPARQL 1.1 Test Suite Runner for sparql_noir
 *
 * This script runs the W3C SPARQL 1.1 test suite against our ZK proof system
 * to measure coverage and identify supported/unsupported features.
 *
 * Usage:
 *   npm run test:sparql            # Run all tests
 *   npm run test:sparql -- -t bgp  # Run only BGP tests
 *   npm run test:sparql -- -o summary  # Summarized output
 */
import { Command } from 'commander';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const program = new Command();
program
    .name('test-sparql')
    .description('Run SPARQL 1.1 test suite against sparql_noir')
    .option('-t, --test <regex>', 'Filter tests by regex')
    .option('--skip <regex>', 'Skip tests matching regex')
    .option('-o, --output <format>', 'Output format: verbose, summary, earl', 'verbose')
    .option('-c, --cache <path>', 'HTTP cache directory', '.rdf-test-suite-cache')
    .option('-d, --timeout <ms>', 'Test timeout in ms', '60000')
    .option('-e, --exit-zero', 'Always exit with code 0')
    .option('--spec <uri>', 'Only run tests for specific specification')
    .option('--manifest <url>', 'Custom manifest URL', 'https://w3c.github.io/rdf-tests/sparql/sparql11/manifest-all.ttl')
    .option('--dry-run', 'List tests without running them')
    .option('--features', 'Show supported SPARQL features summary')
    .parse();
const opts = program.opts();
// Supported SPARQL features based on transform/src/main.rs
const SUPPORTED_FEATURES = {
    'Basic Graph Pattern (BGP)': true,
    'SELECT': true,
    'JOIN': true,
    'UNION': true,
    'OPTIONAL': 'partial', // Needs Rust port
    'FILTER (equality)': true,
    'FILTER (comparison)': true,
    'BIND/EXTEND': true,
    'Property Paths (+)': true,
    'Property Paths (*)': true,
    'Property Paths (?)': true,
    'Property Paths (/)': true,
    'Property Paths (|)': true,
    'Property Paths (^)': true,
    'DISTINCT': 'post-processing',
    'LIMIT': 'post-processing',
    'OFFSET': 'post-processing',
    'ORDER BY': 'post-processing',
    'GROUP BY': false,
    'HAVING': false,
    'Aggregates (COUNT, SUM, etc.)': false,
    'Subqueries': false,
    'VALUES': false,
    'MINUS': false,
    'EXISTS': false,
    'NOT EXISTS': false,
    'SERVICE': false,
    'CONSTRUCT': false,
    'DESCRIBE': false,
    'ASK': 'partial'
};
// Test categories from SPARQL 1.1 test suite
const TEST_CATEGORIES = [
    'aggregates',
    'basic-update',
    'bind',
    'bindings',
    'cast',
    'construct',
    'csv-tsv-res',
    'delete-data',
    'delete-insert',
    'delete-where',
    'delete',
    'drop',
    'entailment',
    'exists',
    'functions',
    'grouping',
    'json-res',
    'negation',
    'project-expression',
    'property-path',
    'service',
    'subquery',
    'syntax-fed',
    'syntax-query',
    'syntax-update-1',
    'syntax-update-2',
    'update-silent'
];
// Categories we expect to pass (based on our implementation)
const EXPECTED_PASSING_CATEGORIES = [
    'syntax-query', // Syntax parsing
    'bind', // BIND expressions
    'property-path' // Property paths (partial)
];
async function main() {
    if (opts.features) {
        showFeaturesSummary();
        return;
    }
    console.log('='.repeat(60));
    console.log('SPARQL 1.1 Test Suite - sparql_noir Coverage Test');
    console.log('='.repeat(60));
    console.log();
    // Build engine if needed
    const enginePath = path.resolve(__dirname, 'sparql-engine.ts');
    const engineJsPath = path.resolve(__dirname, '../dist/test/sparql-engine.js');
    if (!fs.existsSync(engineJsPath)) {
        console.log('Building test engine...');
        try {
            execSync('npm run build', {
                cwd: path.resolve(__dirname, '..'),
                stdio: 'inherit'
            });
        }
        catch (err) {
            console.error('Failed to build test engine');
            process.exit(1);
        }
    }
    // Build the Rust transform if needed
    const transformPath = path.resolve(__dirname, '../transform/target/release/transform');
    if (!fs.existsSync(transformPath)) {
        console.log('Building Rust transform...');
        try {
            execSync('cargo build --release', {
                cwd: path.resolve(__dirname, '../transform'),
                stdio: 'inherit'
            });
        }
        catch (err) {
            console.error('Failed to build Rust transform');
            process.exit(1);
        }
    }
    // Construct rdf-test-suite command
    const args = [
        engineJsPath,
        opts.manifest,
        '-c', opts.cache,
        '-d', opts.timeout,
        '-o', opts.output
    ];
    if (opts.test) {
        args.push('-t', opts.test);
    }
    if (opts.skip) {
        args.push('--skip', opts.skip);
    }
    if (opts.exitZero) {
        args.push('-e');
    }
    if (opts.spec) {
        args.push('-s', opts.spec);
    }
    console.log('Running rdf-test-suite...');
    console.log(`Manifest: ${opts.manifest}`);
    console.log(`Timeout: ${opts.timeout}ms`);
    console.log();
    if (opts.dryRun) {
        console.log('DRY RUN - would execute:');
        console.log(`  npx rdf-test-suite ${args.join(' ')}`);
        return;
    }
    try {
        const result = execSync(`npx rdf-test-suite ${args.join(' ')}`, {
            cwd: path.resolve(__dirname, '..'),
            stdio: 'inherit',
            timeout: 600000 // 10 minute total timeout
        });
    }
    catch (err) {
        // rdf-test-suite exits with code 1 if any tests fail
        if (!opts.exitZero) {
            process.exit(1);
        }
    }
}
function showFeaturesSummary() {
    console.log('='.repeat(60));
    console.log('SPARQL Features Support Summary');
    console.log('='.repeat(60));
    console.log();
    console.log('Legend:');
    console.log('  ✓ = Fully supported');
    console.log('  ~ = Partial support / needs work');
    console.log('  ✗ = Not supported');
    console.log();
    for (const [feature, status] of Object.entries(SUPPORTED_FEATURES)) {
        let symbol;
        let note = '';
        if (status === true) {
            symbol = '✓';
        }
        else if (status === false) {
            symbol = '✗';
        }
        else {
            symbol = '~';
            note = ` (${status})`;
        }
        console.log(`  ${symbol} ${feature}${note}`);
    }
    console.log();
    console.log('Test Categories Expected to Pass:');
    for (const cat of EXPECTED_PASSING_CATEGORIES) {
        console.log(`  • ${cat}`);
    }
    console.log();
    console.log('Note: ZK proof system validates that SPARQL results are correct');
    console.log('without revealing the underlying dataset. Some features require');
    console.log('post-processing outside the circuit (DISTINCT, ORDER BY, etc.).');
}
main().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
//# sourceMappingURL=run-sparql-tests.js.map