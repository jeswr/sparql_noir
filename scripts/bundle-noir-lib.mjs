#!/usr/bin/env node
/**
 * Bundle noir/lib files into a TypeScript module for in-memory compilation.
 * 
 * This script reads all .nr and Nargo.toml files from noir/lib/ and generates
 * a TypeScript file with the content as string literals.
 * 
 * It also patches Nargo.toml files to use local paths for external dependencies
 * instead of git URLs (if external-deps have been fetched).
 * 
 * Usage: node scripts/bundle-noir-lib.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const NOIR_LIB_PATH = join(__dirname, '..', 'noir', 'lib');
const EXTERNAL_DEPS_PATH = join(NOIR_LIB_PATH, 'external-deps');
const OUTPUT_PATH = join(__dirname, '..', 'src', 'noir-lib-bundle.ts');

// External dependencies that should be redirected to local paths
const EXTERNAL_DEPS = {
  'sha256': { git: 'https://github.com/noir-lang/sha256', localPath: '../external-deps/sha256' },
  'ec': { git: 'https://github.com/noir-lang/ec', localPath: '../external-deps/ec' },
  'sha512': { git: 'https://github.com/jeswr/sha512', localPath: '../external-deps/sha512' },
  'mimc': { git: 'https://github.com/noir-lang/mimc', localPath: '../external-deps/mimc' },
  'poseidon': { git: 'https://github.com/noir-lang/poseidon', localPath: '../external-deps/poseidon' },
  'keccak256': { git: 'https://github.com/noir-lang/keccak256', localPath: '../external-deps/keccak256' },
};

/**
 * Check if external dependencies have been fetched
 */
function hasExternalDeps() {
  return existsSync(EXTERNAL_DEPS_PATH) && readdirSync(EXTERNAL_DEPS_PATH).length > 0;
}

/**
 * Patch a Nargo.toml to use local paths for external dependencies
 */
function patchNargoToml(content, relativeTo = '') {
  if (!hasExternalDeps()) return content;
  
  let patched = content;
  for (const [name, { git, localPath }] of Object.entries(EXTERNAL_DEPS)) {
    // Match patterns like: name = { tag = "...", git = "..." }
    const gitPattern = new RegExp(
      `${name}\\s*=\\s*\\{[^}]*git\\s*=\\s*"[^"]*${git.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"[^}]*\\}`,
      'g'
    );
    
    // Calculate relative path from the Nargo.toml location
    const adjustedPath = relativeTo 
      ? localPath.replace('../external-deps/', `../${relativeTo}external-deps/`)
      : localPath;
    
    patched = patched.replace(gitPattern, `${name} = { path = "${adjustedPath}" }`);
  }
  return patched;
}

/**
 * Recursively read all files in a directory
 */
function readDirRecursive(dir, basePath = dir) {
  const files = {};
  
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relativePath = relative(basePath, fullPath);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory()) {
      // Skip target directories (build artifacts)
      if (entry === 'target') continue;
      Object.assign(files, readDirRecursive(fullPath, basePath));
    } else if (entry.endsWith('.nr') || entry === 'Nargo.toml') {
      files[relativePath] = readFileSync(fullPath, 'utf-8');
    }
  }
  
  return files;
}

/**
 * Escape a string for use in a TypeScript template literal
 */
function escapeForTemplateLiteral(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

// Read all noir/lib files
console.log('Reading noir/lib files...');
const files = readDirRecursive(NOIR_LIB_PATH);

// Check for external dependencies
const hasExtDeps = hasExternalDeps();
if (hasExtDeps) {
  console.log('External dependencies found - will use local paths');
} else {
  console.log('Warning: External dependencies not found. Run "npm run fetch:external-deps" to bundle them.');
}

// Patch Nargo.toml files to use local paths for external dependencies
for (const [path, content] of Object.entries(files)) {
  if (path.endsWith('Nargo.toml')) {
    // Calculate depth from noir/lib to determine relative path adjustment
    const depth = path.split('/').length - 1;
    const relativeTo = '../'.repeat(depth);
    files[path] = patchNargoToml(content, relativeTo.slice(3)); // Remove first '../'
  }
}

const fileCount = Object.keys(files).length;
console.log(`Found ${fileCount} files`);

// Generate TypeScript content
const filesContent = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, content]) => {
    // Use forward slashes for consistency
    const normalizedPath = path.replace(/\\/g, '/');
    return `  "${normalizedPath}": \`${escapeForTemplateLiteral(content)}\``;
  })
  .join(',\n');

const externalDepsNote = hasExtDeps 
  ? 'External git dependencies (sha256, ec, sha512, mimc, poseidon, keccak256) are BUNDLED.\n * No network access required for compilation.'
  : 'External git dependencies are NOT bundled.\n * The Noir compiler will need network access to fetch these on first use.';

const output = `/**
 * Bundled Noir library files for in-memory compilation.
 * 
 * AUTO-GENERATED by scripts/bundle-noir-lib.mjs - DO NOT EDIT MANUALLY
 * Generated at: ${new Date().toISOString()}
 * 
 * This module provides all the noir/lib sources as strings that can be
 * loaded into an in-memory filesystem for compilation without disk access.
 * 
 * ${externalDepsNote}
 */

/**
 * Map of relative path -> file content (e.g., "consts/Nargo.toml" -> "...")
 * Paths are relative to noir/lib/
 */
export const NOIR_LIB_FILES: Record<string, string> = {
${filesContent}
};

/**
 * Whether external dependencies are bundled
 */
export const HAS_EXTERNAL_DEPS = ${hasExtDeps};

/**
 * Get all noir/lib files for in-memory compilation
 */
export function getNoirLibFiles(): Record<string, string> {
  return NOIR_LIB_FILES;
}
`;

// Write output
writeFileSync(OUTPUT_PATH, output);
console.log(`Generated ${OUTPUT_PATH}`);
console.log(`Bundled ${fileCount} files`);

// List the files for verification
console.log('\nBundled files:');
for (const path of Object.keys(files).sort()) {
  console.log(`  - ${path}`);
}
