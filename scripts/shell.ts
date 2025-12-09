/**
 * Monk OS Interactive Shell
 *
 * Boots the OS and spawns an interactive shell. When the shell exits,
 * the OS shuts down cleanly.
 *
 * Usage:
 *   bun run shell                              # In-memory storage
 *   bun run shell --sqlite .data/monk.db       # SQLite storage
 *   bun run shell --postgres postgres://...    # PostgreSQL storage
 *   bun run shell --socket /tmp/custom.sock    # Custom gateway socket
 *   bun run shell --debug                      # Kernel debug logging
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
 */
function deriveSocketPath(storage: StorageConfig): string {
    let name = 'monk';

    if (storage.type === 'sqlite' && storage.path) {
        const filename = storage.path.split('/').pop() ?? 'monk';
        name = filename.replace(/\.[^.]+$/, '');
    }
    else if (storage.type === 'postgres' && storage.url) {
        try {
            const url = new URL(storage.url);
            const dbname = url.pathname.slice(1);
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

// Boot OS (init becomes PID 1 with console I/O)
await os.boot();

// Spawn shell as child of init - inherits console handles
const pid = await os.spawn('/bin/shell.ts');

// Wait for shell to exit
const status = await os.process<{ code: number }>('wait', pid);

// Shell exited, shutdown OS
await os.shutdown();

process.exit(status.code);
