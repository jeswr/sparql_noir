#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the file that needs patching
const targetFile = join(__dirname, '..', 'node_modules', '@zk-kit', 'eddsa-poseidon', 'dist', 'index.js');

try {
  // Read the current content
  const content = readFileSync(targetFile, 'utf8');
  
  // Replace the named import with default import and destructuring
  const patchedContent = content.replace(
    "import { blake2bInit, blake2bUpdate, blake2bFinal } from 'blakejs';",
    "import pkg from 'blakejs';\nconst { blake2bInit, blake2bUpdate, blake2bFinal } = pkg;"
  );
  
  // Only write if there was a change
  if (content !== patchedContent) {
    writeFileSync(targetFile, patchedContent, 'utf8');
    console.log('✅ Successfully patched blakejs import in @zk-kit/eddsa-poseidon');
  } else {
    console.log('ℹ️  No patching needed - blakejs import already compatible');
  }
} catch (error) {
  console.error('❌ Failed to patch blakejs import:', error.message);
  // Don't exit with error code as this shouldn't break the install process
}
