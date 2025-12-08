/**
 * Monk OS Interactive Shell
 *
 * Boots the OS and spawns an interactive shell. When the shell exits,
 * the OS shuts down cleanly.
 *
 * Usage:
 *   bun run shell              # In-memory storage
 *   bun run shell --sqlite     # SQLite storage
 *   bun run shell --debug      # Kernel debug logging
 */

import { parseArgs } from 'util';
import { OS } from '@src/index.js';

// Parse command line arguments
const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        sqlite: { type: 'boolean', default: false },
        debug: { type: 'boolean', default: false },
    },
    strict: true,
});

// Build OS configuration
const os = new OS({
    storage: values.sqlite
        ? { type: 'sqlite', path: '.data/monk.db' }
        : { type: 'memory' },
    debug: values.debug,
    env: {
        HOME: '/',
        USER: 'root',
        SHELL: '/bin/shell',
        TERM: 'xterm-256color',
        HOSTNAME: 'monk',
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
