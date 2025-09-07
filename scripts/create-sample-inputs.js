#!/usr/bin/env node
/**
 * Creates sample Prover.toml files for benchmarking purposes
 */
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
// Sample inputs for different circuits
const sampleInputs = [
    {
        circuitName: 'signature',
        inputs: {
            // Sample BabyJubJub public key structure (babyjubjubOpt format)
            // Using smaller values that are within the BN254 field modulus
            public_key: {
                value: {
                    x: "0x123456789abcdef123456789abcdef123456789abcdef123456789abcdef123",
                    y: "0x234567890abcdef234567890abcdef234567890abcdef234567890abcdef234"
                },
                k8: {
                    x: "0x345678901bcdef345678901bcdef345678901bcdef345678901bcdef345678",
                    y: "0x456789012cdef456789012cdef456789012cdef456789012cdef456789012"
                }
            },
            // Sample root structure with signature  
            root: {
                value: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abc",
                signature: {
                    r: {
                        x: "0x111111111111111111111111111111111111111111111111111111111111",
                        y: "0x222222222222222222222222222222222222222222222222222222222222"
                    },
                    left: {
                        x: "0x333333333333333333333333333333333333333333333333333333333333",
                        y: "0x444444444444444444444444444444444444444444444444444444444444"
                    },
                    s: "0x555555555555555555555555555555555555555555555555555555555555"
                }
            }
        }
    },
    {
        circuitName: 'encode',
        inputs: {
            // Sample inputs for encode circuit (you'll need to adjust based on actual requirements)
            input_data: "0x1234567890abcdef"
        }
    },
    {
        circuitName: 'verify_inclusion',
        inputs: {
            // Sample inputs for verify_inclusion circuit (you'll need to adjust based on actual requirements)
            merkle_proof: ["0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"],
            leaf: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            root: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }
    }
];
function createProverToml(circuitPath, circuitName) {
    const sampleInput = sampleInputs.find(input => input.circuitName === circuitName);
    if (!sampleInput) {
        console.log(`⚠️  No sample inputs defined for circuit: ${circuitName}`);
        return;
    }
    const proverTomlPath = join(circuitPath, 'Prover.toml');
    // Convert inputs to TOML format
    let tomlContent = '# Sample inputs for benchmarking\n# Generated automatically by create-sample-inputs.ts\n\n';
    function addTomlValue(key, value, parentPath = '') {
        const fullKey = parentPath ? `${parentPath}.${key}` : key;
        if (Array.isArray(value)) {
            if (typeof value[0] === 'string') {
                // Array of strings
                tomlContent += `${fullKey} = [${value.map(v => `"${v}"`).join(', ')}]\n`;
            }
            else {
                // Array of numbers or other types
                tomlContent += `${fullKey} = [${value.join(', ')}]\n`;
            }
        }
        else if (typeof value === 'object' && value !== null) {
            // Nested object - use dotted notation
            for (const [subKey, subValue] of Object.entries(value)) {
                addTomlValue(subKey, subValue, fullKey);
            }
        }
        else if (typeof value === 'string') {
            tomlContent += `${fullKey} = "${value}"\n`;
        }
        else {
            tomlContent += `${fullKey} = ${value}\n`;
        }
    }
    for (const [key, value] of Object.entries(sampleInput.inputs)) {
        addTomlValue(key, value);
    }
    writeFileSync(proverTomlPath, tomlContent);
    console.log(`✓ Created sample Prover.toml for ${circuitName}: ${proverTomlPath}`);
}
function createAllSampleInputs(baseDir) {
    console.log('🔧 Creating sample input files for benchmarking...\n');
    for (const sample of sampleInputs) {
        const circuitPath = join(baseDir, 'noir', 'bin', sample.circuitName);
        if (existsSync(circuitPath)) {
            createProverToml(circuitPath, sample.circuitName);
        }
        else {
            console.log(`⚠️  Circuit directory not found: ${circuitPath}`);
        }
    }
    console.log('\n✅ Sample input creation complete!');
    console.log('💡 Note: These are minimal sample inputs for benchmarking only.');
    console.log('   For real usage, use proper inputs from your sign.ts script.');
}
// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
    const baseDir = process.argv[2] || '.';
    createAllSampleInputs(baseDir);
}
export { createAllSampleInputs, createProverToml };
//# sourceMappingURL=create-sample-inputs.js.map