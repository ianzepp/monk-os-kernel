/**
 * Monk OS Startup
 *
 * Example application startup showing how to use Monk OS.
 * This is the equivalent of an app's index.ts.
 *
 * Usage:
 *   bun start              # In-memory storage
 *   bun start --sqlite     # SQLite storage in .data/
 *   bun start --debug      # Enable kernel debug logging
 */

import { OS } from '@src/index.js';

// Parse args
const args = process.argv.slice(2);
const useSqlite = args.includes('--sqlite');
const useDebug = args.includes('--debug');

async function startup(): Promise<void> {
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
            PORT: '8080',  // Default port for services
        },
    });

    // Install packages (queued for boot)
    os.install('@monk-api/httpd');

    // Mount a directory to serve (before boot)
    os.on('vfs', (os) => {
        // Mount ./public to /var/www (create ./public if you want to serve files)
        // os.fs.mount('./public', '/var/www');

        // For demo: mount the packages/httpd directory
        os.fs.mount('./packages/httpd', '/var/www');
    });

    console.log(`  Storage: ${useSqlite ? 'sqlite' : 'memory'}`);

    // Boot the OS
    await os.boot({
        debug: useDebug,
    });
    console.log('  Kernel: booted');

    // Start httpd serving from /var/www
    await os.service.start('httpd', { root: '/var/www' });

    // List running services
    const services = await os.service.list();

    if (services.length > 0) {
        console.log('  Services:');
        for (const svc of services) {
            console.log(`    - ${svc.name}: ${svc.status}`);
        }
    }

    console.log('\nMonk OS ready.');
    console.log('  HTTP server: http://localhost:8080 (serving /var/www)');
    console.log('  Health check: http://localhost:8080/health');
    console.log('  README: http://localhost:8080/README.md\n');

    // Handle shutdown
    const shutdown = async () => {
        console.log('\nShutting down...');

        // Stop services
        for (const svc of await os.service.list()) {
            await os.service.stop(svc.name);
        }

        await os.shutdown();
        console.log('Goodbye.');
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    await new Promise(() => {});
}

startup().catch((err) => {
    console.error('Boot failed:', err);
    process.exit(1);
});
