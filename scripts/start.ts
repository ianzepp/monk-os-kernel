/**
 * Monk OS Startup
 *
 * Standalone mode entry point. Boots the OS with display server
 * and blocks until shutdown signal.
 *
 * Usage:
 *   bun start                              # In-memory storage
 *   bun start --sqlite .data/monk.db       # SQLite storage
 *   bun start --postgres postgres://...    # PostgreSQL storage
 *   bun start --port 3000                  # Custom display port
 *   bun start --no-display                 # Headless mode
 *   bun start --debug                      # Kernel debug logging
 */

import { parseArgs } from 'util';
import { OS } from '@src/index.js';
import type { StorageConfig } from '@src/os/types.js';

// Parse command line arguments
const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        sqlite: { type: 'string' },
        postgres: { type: 'string' },
        debug: { type: 'boolean', default: false },
        port: { type: 'string', default: '8080' },
        'no-display': { type: 'boolean', default: false },
    },
    strict: true,
});

// Validate mutually exclusive storage options
if (values.sqlite && values.postgres) {
    console.error('Error: --sqlite and --postgres are mutually exclusive');
    process.exit(1);
}

// Build storage configuration
let storage: StorageConfig;

if (values.postgres) {
    storage = { type: 'postgres', url: values.postgres };
}
else if (values.sqlite) {
    storage = { type: 'sqlite', path: values.sqlite };
}
else {
    storage = { type: 'memory' };
}

// Build OS configuration
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

// Run
const exitCode = await os.exec();
process.exit(exitCode);
