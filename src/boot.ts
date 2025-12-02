/**
 * Monk OS Boot
 *
 * Minimal boot sequence for the Monk OS kernel.
 * Uses the OS class for unified HAL, VFS, and Kernel management.
 *
 * Usage:
 *   bun run boot              # In-memory storage
 *   bun run boot --sqlite     # SQLite storage in .data/
 *   bun run boot --debug      # Enable kernel debug logging (printk)
 */

import { OS } from '@src/os.js';

// Parse args
const args = process.argv.slice(2);
const useSqlite = args.includes('--sqlite');
const useDebug = args.includes('--debug');

async function boot(): Promise<void> {
    console.log('Monk OS booting...');

    // Create OS with configured storage
    const os = new OS({
        storage: useSqlite
            ? { type: 'sqlite', path: '.data/monk.db' }
            : { type: 'memory' },
        env: {
            HOME: '/',
            USER: 'root',
            SHELL: '/bin/shell',
            TERM: 'xterm-256color',
            HOSTNAME: 'monk',
        },
    });
    console.log(`  Storage: ${useSqlite ? 'sqlite' : 'memory'}`);

    // Boot with init process
    await os.boot({
        main: '/bin/init.ts',
        debug: useDebug,
    });
    console.log('  Kernel: booted');

    // Show active services
    const services = os.getServices();
    if (services.size > 0) {
        console.log('  Services:');
        for (const [name, def] of services) {
            const act = def.activate;
            const desc = act.type === 'tcp:listen'
                ? `tcp:${act.port}`
                : act.type === 'boot'
                    ? 'boot'
                    : act.type;
            console.log(`    - ${name}: ${desc}`);
        }
    }

    console.log('\nMonk OS ready.');
    console.log('Connect with: nc localhost 2323 (if telnetd service is enabled)\n');

    // Handle shutdown
    const shutdown = async () => {
        console.log('\nShutting down...');
        await os.shutdown();
        console.log('Goodbye.');
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    await new Promise(() => {});
}

boot().catch((err) => {
    console.error('Boot failed:', err);
    process.exit(1);
});
