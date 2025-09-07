#!/usr/bin/env node

/**
 * Simple wrapper script to run the TypeScript benchmark tool
 * This allows running benchmarks without needing to compile TypeScript first
 */

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptPath = join(__dirname, 'benchmark-backends.ts');

try {
  // Use ts-node to run the TypeScript file directly
  const args = process.argv.slice(2).join(' ');
  execSync(`npx tsx ${scriptPath} ${args}`, { 
    stdio: 'inherit',
    cwd: process.cwd()
  });
} catch (error) {
  console.error('Failed to run benchmark script:', error.message);
  process.exit(1);
}
