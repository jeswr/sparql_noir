#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Patch 1: Fix blakejs import in @zk-kit/eddsa-poseidon
const eddsaFile = join(__dirname, '..', 'node_modules', '@zk-kit', 'eddsa-poseidon', 'dist', 'index.js');

try {
  const content = readFileSync(eddsaFile, 'utf8');
  
  const patchedContent = content.replace(
    "import { blake2bInit, blake2bUpdate, blake2bFinal } from 'blakejs';",
    "import pkg from 'blakejs';\nconst { blake2bInit, blake2bUpdate, blake2bFinal } = pkg;"
  );
  
  if (content !== patchedContent) {
    writeFileSync(eddsaFile, patchedContent, 'utf8');
    console.log('✅ Successfully patched blakejs import in @zk-kit/eddsa-poseidon');
  } else {
    console.log('ℹ️  No patching needed - blakejs import already compatible');
  }
} catch (error) {
  console.error('❌ Failed to patch blakejs import:', error.message);
}

// Patch 2: Fix getSources nested submodule path resolution in @noir-lang/noir_wasm
// See: https://github.com/noir-lang/noir/pull/10893
const noirWasmFiles = [
  join(__dirname, '..', 'node_modules', '@noir-lang', 'noir_wasm', 'dist', 'node', 'main.js'),
  join(__dirname, '..', 'node_modules', '@noir-lang', 'noir_wasm', 'dist', 'web', 'main.mjs'),
];

// Patched getSources function with nested submodule handling
// Note: We use a function for the replacement to avoid $& being interpreted as a special replacement pattern
function getPatchedGetSources() {
  // Build the patched code as an array and join to avoid escaping nightmares
  const lines = [];
  lines.push('    async getSources(fm, alias) {');
  lines.push('        const handles = await fm.readdir(this.#srcPath, { recursive: true });');
  lines.push('        const sourceFiles = handles.filter((handle) => SOURCE_EXTENSIONS.find((ext) => handle.endsWith(ext)));');
  lines.push('');
  lines.push('        // Pre-compile regex pattern for efficiency (escaping special regex characters)');
  // The regex pattern /[.*+?^${}()|[\]\\]/g with the replacement '\\$&'
  lines.push("        const escapedSrcPath = this.#srcPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');");
  lines.push('        const srcPathRegex = new RegExp(`.*${escapedSrcPath}`);');
  lines.push('');
  lines.push("        // Check if there's a module file matching the package name with a corresponding directory");
  lines.push('        // For example, if we have src/foo.nr and src/foo/ in a package named "foo",');
  lines.push('        // then files in src/foo/ should be placed at the same level as src/foo.nr');
  lines.push('        let specialModuleDir = null;');
  lines.push("        if (this.getType() === 'lib') {");
  lines.push('            const packageName = alias ?? this.#config.package.name;');
  lines.push('            const moduleFile = sourceFiles.find((f) => {');
  lines.push("                const suffix = f.replace(srcPathRegex, '');");
  lines.push('                return suffix === `/${packageName}.nr`;');
  lines.push('            });');
  lines.push('            if (moduleFile) {');
  lines.push('                const hasMatchingDir = sourceFiles.some((f) => {');
  lines.push("                    const s = f.replace(srcPathRegex, '');");
  lines.push('                    return s.startsWith(`/${packageName}/`);');
  lines.push('                });');
  lines.push('                if (hasMatchingDir) {');
  lines.push('                    specialModuleDir = packageName;');
  lines.push('                }');
  lines.push('            }');
  lines.push('        }');
  lines.push('');
  lines.push('        return Promise.all(sourceFiles.map(async (file) => {');
  lines.push('            // Github deps are directly added to the file manager, which causes them to be missing the absolute path to the source file');
  lines.push('            // and only include the extraction directory relative to the fm root directory');
  lines.push('            // This regexp ensures we remove the "real" source path for all dependencies, providing the compiler with what it expects for each source file:');
  lines.push('            // <absoluteSourcePath> -> <sourceAsString> for bin/contract packages');
  lines.push('            // <depAlias/relativePathToSource> -> <sourceAsString> for libs');
  lines.push("            const suffix = file.replace(srcPathRegex, '');");
  lines.push('');
  lines.push('            let adjustedSuffix = suffix;');
  lines.push('            if (specialModuleDir) {');
  lines.push('                // If the file is in the special module directory (e.g., /foo/bar.nr where this package is named "foo"');
  lines.push("                // and foo.nr exists), remove the module directory prefix to match Noir's module resolution behavior.");
  lines.push('                // This handles the case where foo.nr declares "mod bar;" and expects to find bar.nr at the same level');
  lines.push('                // due to the should_check_siblings_for_module logic when filename matches parent directory.');
  lines.push('                const prefix = `/${specialModuleDir}/`;');
  lines.push('                if (suffix.startsWith(prefix)) {');
  lines.push('                    // Replace /foo/ with / to transform /foo/bar.nr into /bar.nr');
  lines.push("                    adjustedSuffix = suffix.replace(prefix, '/');");
  lines.push('                }');
  lines.push('            }');
  lines.push('');
  lines.push('            return {');
  lines.push("                path: this.getType() === 'lib' ? `${alias ? alias : this.#config.package.name}${adjustedSuffix}` : file,");
  lines.push("                source: (await fm.readFile(file, 'utf-8')).toString(),");
  lines.push('            };');
  lines.push('        }));');
  lines.push('    }');
  return lines.join('\n');
}

for (const targetFile of noirWasmFiles) {
  try {
    const content = readFileSync(targetFile, 'utf8');
    
    // Check if already patched
    if (content.includes('specialModuleDir')) {
      console.log(`ℹ️  No patching needed - getSources already patched in ${targetFile}`);
      continue;
    }
    
    // Try to find and replace the getSources function using regex
    // This regex matches the original getSources function
    const getSourcesRegex = /    async getSources\(fm, alias\) \{\s*const handles = await fm\.readdir\(this\.#srcPath, \{ recursive: true \}\);\s*return Promise\.all\(handles\s*\.filter\(\(handle\) => SOURCE_EXTENSIONS\.find\(\(ext\) => handle\.endsWith\(ext\)\)\)\s*\.map\(async \(file\) => \{[\s\S]*?const suffix = file\.replace\(new RegExp\(`\.\*\$\{this\.#srcPath\}`\), ''\);[\s\S]*?return \{[\s\S]*?path:[\s\S]*?source:[\s\S]*?\};\s*\}\)\);\s*\}/;
    
    if (getSourcesRegex.test(content)) {
      // Use a function replacement to avoid $& issues
      const patchedContent = content.replace(getSourcesRegex, () => getPatchedGetSources());
      writeFileSync(targetFile, patchedContent, 'utf8');
      console.log(`✅ Successfully patched getSources in ${targetFile}`);
    } else {
      console.warn(`⚠️  Could not find getSources function to patch in ${targetFile}`);
    }
  } catch (error) {
    console.error(`❌ Failed to patch noir_wasm (${targetFile}):`, error.message);
  }
}
