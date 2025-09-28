#!/usr/bin/env tsx

/**
 * Standalone Backend Installer for Noir Benchmarking
 * 
 * This script can be used to install Noir proving backends independently
 * of the main benchmarking tool.
 */

import { NoirBackendBenchmark } from './benchmark-backends.js';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('🔧 Noir Backend Installer\n');
    console.log('Usage:');
    console.log('  npx tsx install-backends.ts list                 # List all backends');
    console.log('  npx tsx install-backends.ts install <backend>    # Install specific backend');
    console.log('  npx tsx install-backends.ts install-all         # Install all backends');
    console.log('  npx tsx install-backends.ts help                # Show this help');
    console.log('\nExample:');
    console.log('  npx tsx install-backends.ts install barretenberg-ultrahonk');
    return;
  }

  const command = args[0];
  const benchmark = new NoirBackendBenchmark('.');

  switch (command) {
    case 'list':
      benchmark.listInstallableBackends();
      break;

    case 'install':
      if (args.length < 2) {
        console.error('❌ Backend name required for install command');
        console.log('💡 Usage: npx tsx install-backends.ts install <backend-name>');
        process.exit(1);
      }
      
      const backendName = args[1];
      if (!backendName) {
        console.error('❌ Backend name is required');
        process.exit(1);
      }
      console.log(`🚀 Installing backend: ${backendName}\n`);
      
      const success = await benchmark.installBackend(backendName);
      if (success) {
        console.log(`\n✅ Successfully installed ${backendName}!`);
        console.log('💡 You can now run benchmarks with this backend.');
      } else {
        console.log(`\n❌ Failed to install ${backendName}.`);
        process.exit(1);
      }
      break;

    case 'install-all':
      console.log('🔧 Installing all available backends...\n');
      await benchmark.installAllBackends();
      console.log('\n🎉 Installation process completed!');
      break;

    case 'help':
      benchmark.listInstallableBackends();
      console.log('\n🔧 Manual Installation Requirements:\n');
      console.log('• Rust: https://rustup.rs/ (required for Sonobe and Blocksense)');
      console.log('• Go: https://golang.org/ (required for Gnark backend)');
      console.log('• Node.js: https://nodejs.org/ (required for Barretenberg)');
      break;

    default:
      console.error(`❌ Unknown command: ${command}`);
      console.log('💡 Use "help" command to see available options');
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(`❌ Error: ${error}`);
    process.exit(1);
  });
}
