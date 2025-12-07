/**
 * Kernel Shutdown Tests
 *
 * Tests that kernel shutdown properly terminates processes blocked on syscalls.
 *
 * WHY: Processes blocked in syscalls like recv() or sleep() cannot process signals
 * delivered via postMessage. The kernel must interrupt these syscalls before
 * delivering SIGTERM to allow graceful shutdown.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { OS } from '@src/index.js';

describe('Kernel Shutdown', () => {
    let os: OS | null = null;

    afterEach(async () => {
        if (os?.isBooted()) {
            await os.shutdown();
        }

        os = null;
    });

    it('should shutdown cleanly with no running processes', async () => {
        os = new OS({ storage: { type: 'memory' } });
        await os.boot();

        const start = Date.now();
        await os.shutdown();
        const elapsed = Date.now() - start;

        expect(os.isBooted()).toBe(false);
        // Should be fast - no processes to terminate
        expect(elapsed).toBeLessThan(1000);
    });

    it('should terminate process blocked on sleep()', async () => {
        os = new OS({ storage: { type: 'memory' } });
        await os.boot();

        // Write a script that sleeps for a long time
        const vfs = os.getVFS();
        const script = `
            import { sleep } from '@rom/lib/process/index.js';

            async function main() {
                // Sleep for 60 seconds - should be interrupted by shutdown
                await sleep(60000);
            }

            main();
        `;

        const handle = await vfs.open('/tmp/sleeper.ts', { write: true, create: true }, 'kernel');
        await handle.write(new TextEncoder().encode(script));
        await handle.close();

        // Spawn the sleeping process
        const pid = await os.spawn('/tmp/sleeper.ts');
        expect(pid).toBeGreaterThan(0);

        // Give it time to start and enter sleep
        await Bun.sleep(100);

        // Verify there are running processes (init + sleeper)
        const kernel = os.getKernel();
        const runningCount = Array.from(kernel.processes.all()).filter(p => p.state === 'running').length;
        expect(runningCount).toBeGreaterThanOrEqual(2);

        // Shutdown should complete quickly despite blocked process
        const start = Date.now();
        await os.shutdown();
        const elapsed = Date.now() - start;

        expect(os.isBooted()).toBe(false);
        // Should complete within grace period, not wait for full 60s sleep
        expect(elapsed).toBeLessThan(6000);
    }, 10000);

    it('should terminate process blocked on port recv()', async () => {
        os = new OS({ storage: { type: 'memory' } });
        await os.boot();

        // Write a script that listens on a port and blocks on recv
        const vfs = os.getVFS();
        const script = `
            import { listen, recv } from '@rom/lib/process/index.js';

            async function main() {
                // Create a listener port
                const portFd = await listen({ port: 0, unix: '/tmp/test-shutdown.sock' });

                // Block waiting for connection - should be interrupted by shutdown
                await recv(portFd);
            }

            main();
        `;

        const handle = await vfs.open('/tmp/listener.ts', { write: true, create: true }, 'kernel');
        await handle.write(new TextEncoder().encode(script));
        await handle.close();

        // Spawn the listening process
        const pid = await os.spawn('/tmp/listener.ts');
        expect(pid).toBeGreaterThan(0);

        // Give it time to start and enter recv
        await Bun.sleep(200);

        // Verify there are running processes (init + listener)
        const kernel = os.getKernel();
        const runningCount = Array.from(kernel.processes.all()).filter(p => p.state === 'running').length;
        expect(runningCount).toBeGreaterThanOrEqual(2);

        // Shutdown should complete quickly despite blocked recv
        const start = Date.now();
        await os.shutdown();
        const elapsed = Date.now() - start;

        expect(os.isBooted()).toBe(false);
        // Should complete within grace period
        expect(elapsed).toBeLessThan(6000);
    }, 10000);
});
