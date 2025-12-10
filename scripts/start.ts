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
 *   bun start --socket /tmp/custom.sock    # Custom gateway socket
 *   bun start --port 3000                  # Custom display port
 *   bun start --no-display                 # Headless mode
 *   bun start --debug                      # Kernel debug logging
 *
 * Socket auto-derivation (when --socket not specified):
 *   --sqlite .data/monk.db    → /tmp/monk.sock
 *   --sqlite .data/foo.db     → /tmp/foo.sock
 *   --postgres .../mydb       → /tmp/mydb.sock
 *   (memory)                  → /tmp/monk.sock
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
        socket: { type: 'string' },
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

/**
 * Derive socket path from database configuration.
 *
 * - SQLite: extract filename without extension
 * - PostgreSQL: extract database name from URL
 * - Memory: use default 'monk'
 */
function deriveSocketPath(storage: StorageConfig): string {
    let name = 'monk';

    if (storage.type === 'sqlite' && storage.path) {
        // Extract filename without extension: .data/foo.db → foo
        const filename = storage.path.split('/').pop() ?? 'monk';
        name = filename.replace(/\.[^.]+$/, '');
    }
    else if (storage.type === 'postgres' && storage.url) {
        // Extract database name from URL: postgres://user:pass@host:port/dbname → dbname
        try {
            const url = new URL(storage.url);
            const dbname = url.pathname.slice(1); // Remove leading /
            if (dbname) {
                name = dbname;
            }
        }
        catch {
            // Invalid URL, use default
        }
    }

    return `/tmp/${name}.sock`;
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

// Determine socket path
const socketPath = values.socket ?? deriveSocketPath(storage);

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
        MONK_SOCKET: socketPath,
    },
});

// Log startup info
console.log(`Storage: ${storage.type}${storage.path ? ` (${storage.path})` : ''}${storage.url ? ` (${storage.url})` : ''}`);
console.log(`Socket: ${socketPath}`);

// Run
const exitCode = await os.exec();
process.exit(exitCode);
