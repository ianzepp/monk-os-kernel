/**
 * Monk OS Startup
 *
 * Standalone mode entry point. Boots the OS and blocks until shutdown signal.
 *
 * Usage:
 *   bun start                              # PostgreSQL (monk_os database)
 *   bun start --memory                     # In-memory storage
 *   bun start --sqlite .data/monk.db       # SQLite storage
 *   bun start --postgres postgres://...    # Custom PostgreSQL URL
 *   bun start --debug                      # Kernel debug logging
 */

import { parseArgs } from 'util';
import { OS } from '@src/index.js';
import type { StorageConfig } from '@src/os/types.js';

// Parse command line arguments
const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        memory: { type: 'boolean', default: false },
        sqlite: { type: 'string' },
        postgres: { type: 'string' },
        debug: { type: 'boolean', default: false },
    },
    strict: true,
});

// Validate mutually exclusive storage options
if (values.sqlite && values.postgres) {
    console.error('Error: --sqlite and --postgres are mutually exclusive');
    process.exit(1);
}

// Default PostgreSQL connection
const DEFAULT_POSTGRES_URL = 'postgres://localhost/monk_os';

// Build storage configuration
let storage: StorageConfig;

if (values.memory) {
    storage = { type: 'memory' };
}
else if (values.postgres) {
    storage = { type: 'postgres', url: values.postgres };
}
else if (values.sqlite) {
    storage = { type: 'sqlite', path: values.sqlite };
}
else {
    // Default to PostgreSQL
    storage = { type: 'postgres', url: DEFAULT_POSTGRES_URL };
}

// Build OS instance
const os = new OS({
    storage,
    debug: values.debug,
    env: {
        HOME: '/',
        USER: 'root',
        SHELL: '/bin/shell',
        TERM: 'xterm-256color',
        HOSTNAME: 'monk',
    },
});

// Log startup info
console.log(`Storage: ${storage.type}${storage.path ? ` (${storage.path})` : ''}${storage.url ? ` (${storage.url})` : ''}`);

// Initialize subsystems
await os.init();
console.log('Initialized');

// Boot kernel and services
await os.boot();
console.log('Booted');

// Block until shutdown signal
console.log('Monk OS running. Press Ctrl+C to stop.');

const handleShutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await os.shutdown();
    process.exit(0);
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Keep process alive
await new Promise(() => {});
