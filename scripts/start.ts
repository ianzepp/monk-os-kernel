/**
 * Monk OS Startup
 *
 * Standalone mode entry point. Boots the OS with display server
 * and blocks until shutdown signal.
 *
 * Usage:
 *   bun start                    # In-memory, display on :8080
 *   bun start --sqlite           # SQLite storage
 *   bun start --port 3000        # Custom display port
 *   bun start --no-display       # Headless mode
 *   bun start --debug            # Kernel debug logging
 */

import { parseArgs } from 'util';
import { OS } from '@src/index.js';

// Parse command line arguments
const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        sqlite: { type: 'boolean', default: false },
        debug: { type: 'boolean', default: false },
        port: { type: 'string', default: '8080' },
        'no-display': { type: 'boolean', default: false },
    },
    strict: true,
});

// Build OS configuration
const os = new OS({
    storage: values.sqlite
        ? { type: 'sqlite', path: '.data/monk.db' }
        : { type: 'memory' },
    display: values['no-display']
        ? undefined
        : { enabled: true, port: parseInt(values.port, 10) },
    debug: values.debug,
    env: {
        HOME: '/',
        USER: 'root',
        SHELL: '/bin/shell',
        TERM: 'xterm-256color',
        HOSTNAME: 'monk',
    },
});

// Run
const exitCode = await os.exec();
process.exit(exitCode);
