/**
 * Monk OS Boot
 *
 * Minimal boot sequence for the Monk OS kernel.
 * Creates HAL, VFS, and Kernel, then boots with init process.
 *
 * Usage:
 *   bun run boot              # In-memory storage
 *   bun run boot --sqlite     # SQLite storage in .data/
 */

import { createBunHAL } from '@src/hal/index.js';
import { VFS } from '@src/vfs/vfs.js';
import { Kernel } from '@src/kernel/kernel.js';

// Parse args
const args = process.argv.slice(2);
const useSqlite = args.includes('--sqlite');

async function boot(): Promise<void> {
    console.log('Monk OS booting...');

    // Create HAL
    const hal = await createBunHAL({
        storage: useSqlite
            ? { type: 'sqlite', path: '.data/monk.db' }
            : { type: 'memory' },
    });
    console.log(`  HAL: ${useSqlite ? 'sqlite' : 'memory'} storage`);

    // Create VFS
    const vfs = new VFS(hal);
    console.log('  VFS: initialized');

    // Create Kernel
    const kernel = new Kernel(hal, vfs);
    console.log('  Kernel: created');

    // Boot kernel with init process
    await kernel.boot({
        initPath: '/bin/init.ts',
        initArgs: ['init'],
        env: {
            HOME: '/',
            USER: 'root',
            SHELL: '/bin/shell',
            TERM: 'xterm-256color',
            HOSTNAME: 'monk',
        },
    });
    console.log('  Kernel: booted');

    // Show active services
    const services = kernel.getServices();
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
        await kernel.shutdown();
        await hal.shutdown();
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
