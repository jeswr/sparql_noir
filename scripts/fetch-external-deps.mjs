#!/usr/bin/env node
/**
 * Fetch external Noir git dependencies and save them locally.
 * 
 * This script downloads the external dependencies that noir/lib depends on
 * from GitHub and saves them to noir/lib/external-deps/ for bundling.
 * 
 * Usage: node scripts/fetch-external-deps.mjs
 */

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const EXTERNAL_DEPS_PATH = join(__dirname, '..', 'noir', 'lib', 'external-deps');

// External dependencies to fetch
const DEPS = [
  { name: 'sha256', repo: 'noir-lang/sha256', tag: 'v0.2.1' },
  { name: 'ec', repo: 'noir-lang/ec', tag: 'v0.1.2' },
  { name: 'sha512', repo: 'jeswr/sha512', tag: '0.1.0' },
  { name: 'mimc', repo: 'noir-lang/mimc', tag: 'v0.1.0' },
  { name: 'poseidon', repo: 'noir-lang/poseidon', tag: 'v0.1.1' },
  { name: 'keccak256', repo: 'noir-lang/keccak256', tag: 'v0.1.1' },
];

async function fetchDep(dep) {
  const { name, repo, tag } = dep;
  const url = `https://github.com/${repo}/archive/refs/tags/${tag}.zip`;
  const destDir = join(EXTERNAL_DEPS_PATH, name);
  
  console.log(`Fetching ${name}@${tag} from ${repo}...`);
  
  // Create temp directory for extraction
  const tempDir = join(EXTERNAL_DEPS_PATH, `${name}-temp`);
  const zipPath = join(EXTERNAL_DEPS_PATH, `${name}.zip`);
  
  try {
    // Download zip
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    writeFileSync(zipPath, Buffer.from(buffer));
    
    // Extract zip
    mkdirSync(tempDir, { recursive: true });
    execSync(`unzip -q "${zipPath}" -d "${tempDir}"`, { stdio: 'pipe' });
    
    // Find extracted directory (usually repo-name-tag)
    const extractedDir = execSync(`ls "${tempDir}"`, { encoding: 'utf-8' }).trim();
    const srcDir = join(tempDir, extractedDir);
    
    // Move to final location
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true });
    }
    execSync(`mv "${srcDir}" "${destDir}"`, { stdio: 'pipe' });
    
    // Cleanup
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(zipPath, { force: true });
    
    console.log(`  ✓ ${name}@${tag}`);
  } catch (err) {
    console.error(`  ✗ Failed to fetch ${name}: ${err.message}`);
    // Cleanup on error
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    if (existsSync(zipPath)) rmSync(zipPath, { force: true });
    throw err;
  }
}

async function main() {
  console.log('Fetching external Noir dependencies...\n');
  
  // Create external-deps directory
  mkdirSync(EXTERNAL_DEPS_PATH, { recursive: true });
  
  // Fetch all dependencies
  for (const dep of DEPS) {
    await fetchDep(dep);
  }
  
  console.log('\n✓ All external dependencies fetched successfully');
  console.log(`  Location: ${EXTERNAL_DEPS_PATH}`);
  console.log('\nRun "npm run bundle:noir-lib" to update the bundle.');
}

main().catch(err => {
  console.error('\nFailed to fetch dependencies:', err.message);
  process.exit(1);
});
