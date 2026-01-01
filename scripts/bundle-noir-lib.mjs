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
 * Check if a file or directory is test-related
 */
function isTestFile(name, relativePath) {
  // Skip test files and directories
  if (name === 'tests' || name === 'tests.nr' || name === 'test.nr') return true;
  if (name.startsWith('test_') || name.endsWith('_test.nr')) return true;
  if (relativePath.includes('/tests/')) return true;
  // Skip benchmark files
  if (name === 'bench.nr' || name.startsWith('bench_')) return true;
  return false;
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
      // Skip target directories (build artifacts) and test directories
      if (entry === 'target' || entry === 'tests') continue;
      Object.assign(files, readDirRecursive(fullPath, basePath));
    } else if (entry.endsWith('.nr') || entry === 'Nargo.toml') {
      // Skip test files
      if (isTestFile(entry, relativePath)) continue;
      
      let content = readFileSync(fullPath, 'utf-8');
      // Strip comments and tests from Noir files to reduce bundle size
      if (entry.endsWith('.nr')) {
        content = stripComments(content);
        content = stripTestCode(content);
      }
      files[relativePath] = content;
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

/**
 * Strip comments from Noir source code.
 * Handles single-line comments (//) and multi-line comments.
 */
function stripComments(content) {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  
  while (i < content.length) {
    // Handle string literals (don't strip comments inside strings)
    if (!inString && (content[i] === '"' || content[i] === "'")) {
      inString = true;
      stringChar = content[i];
      result += content[i];
      i++;
      continue;
    }
    
    if (inString) {
      // Check for escape sequences
      if (content[i] === '\\' && i + 1 < content.length) {
        result += content[i] + content[i + 1];
        i += 2;
        continue;
      }
      // Check for end of string
      if (content[i] === stringChar) {
        inString = false;
      }
      result += content[i];
      i++;
      continue;
    }
    
    // Check for single-line comment
    if (content[i] === '/' && i + 1 < content.length && content[i + 1] === '/') {
      // Skip until end of line
      while (i < content.length && content[i] !== '\n') {
        i++;
      }
      continue;
    }
    
    // Check for multi-line comment
    if (content[i] === '/' && i + 1 < content.length && content[i + 1] === '*') {
      i += 2;
      // Skip until closing */
      while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) {
        i++;
      }
      i += 2; // Skip the closing */
      continue;
    }
    
    result += content[i];
    i++;
  }
  
  // Clean up: remove all empty lines and trailing whitespace
  return result
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')  // Remove all empty lines
    .join('\n')
    .trim() + '\n';
}

/**
 * Strip test code from Noir source.
 * Removes #[test] functions, mod tests blocks, and mod tests/bench declarations.
 */
function stripTestCode(content) {
  let result = '';
  let i = 0;
  
  while (i < content.length) {
    // Check for #[test] annotation
    if (content.slice(i, i + 7) === '#[test]') {
      // Skip the #[test] and any whitespace
      i += 7;
      while (i < content.length && /\s/.test(content[i])) i++;
      
      // Check if followed by 'fn'
      if (content.slice(i, i + 2) === 'fn') {
        // Skip the entire function including its body
        // Find the opening brace
        while (i < content.length && content[i] !== '{') i++;
        if (i < content.length) {
          // Skip the matched braces
          let braceCount = 1;
          i++; // Skip opening brace
          while (i < content.length && braceCount > 0) {
            if (content[i] === '{') braceCount++;
            else if (content[i] === '}') braceCount--;
            i++;
          }
        }
        continue;
      }
    }
    
    // Check for 'mod tests' or 'mod bench' declarations (both inline blocks and file references)
    if (content.slice(i, i + 3) === 'mod' && /\s/.test(content[i + 3])) {
      let j = i + 4;
      while (j < content.length && /\s/.test(content[j])) j++;
      
      // Check for tests or bench module
      const isTests = content.slice(j, j + 5) === 'tests' && (j + 5 >= content.length || /[\s{;]/.test(content[j + 5]));
      const isBench = content.slice(j, j + 5) === 'bench' && (j + 5 >= content.length || /[\s{;]/.test(content[j + 5]));
      
      if (isTests || isBench) {
        j += 5;
        // Skip whitespace after module name
        while (j < content.length && /\s/.test(content[j])) j++;
        
        if (content[j] === ';') {
          // mod tests; or mod bench; declaration - skip the whole thing
          i = j + 1;
          continue;
        } else if (content[j] === '{') {
          // mod tests { ... } block - skip the matched braces
          let braceCount = 1;
          j++; // Skip opening brace
          while (j < content.length && braceCount > 0) {
            if (content[j] === '{') braceCount++;
            else if (content[j] === '}') braceCount--;
            j++;
          }
          i = j;
          continue;
        }
      }
    }
    
    result += content[i];
    i++;
  }
  
  // Remove any remaining empty lines created by removal
  return result
    .split('\n')
    .filter(line => line.trim() !== '')
    .join('\n');
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
