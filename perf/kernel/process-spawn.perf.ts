/**
 * Process Spawn/Kill Performance Tests
 *
 * Validates process lifecycle under high-volume conditions.
 * Focus: correctness of spawn/exit, not timing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kernel } from '@src/kernel/kernel.js';
import { poll } from '@src/kernel/poll.js';
import { VFS } from '@src/vfs/vfs.js';
import type { HAL } from '@src/hal/index.js';
import {
    MemoryStorageEngine,
    MemoryBlockDevice,
    BunNetworkDevice,
    BunTimerDevice,
    BunClockDevice,
    BunEntropyDevice,
    BunCryptoDevice,
    BufferConsoleDevice,
    BunDNSDevice,
    BunHostDevice,
    MockIPCDevice,
    BunChannelDevice,
} from '@src/hal/index.js';

const TIMEOUT_LONG = 60_000;

/**
 * Create a test HAL with memory backends
 */
function createTestHAL(): HAL & { console: BufferConsoleDevice } {
    const timer = new BunTimerDevice();
    const storage = new MemoryStorageEngine();
    const console = new BufferConsoleDevice();

    return {
        block: new MemoryBlockDevice(),
        storage,
        network: new BunNetworkDevice(),
        timer,
        clock: new BunClockDevice(),
        entropy: new BunEntropyDevice(),
        crypto: new BunCryptoDevice(),
        console,
        dns: new BunDNSDevice(),
        host: new BunHostDevice(),
        ipc: new MockIPCDevice(),
        channel: new BunChannelDevice(),

        async shutdown(): Promise<void> {
            timer.cancelAll();
            await storage.close();
        },
    };
}

/**
 * Wait for the init process to exit (become zombie).
 */
async function waitForInitExit(kernel: Kernel, timeout = 5000): Promise<boolean> {
    return await poll(() => {
        const init = kernel.getProcessTable().getInit();
        return !init || init.state === 'zombie';
    }, { timeout });
}

describe('Process Spawn: Sequential Boot Cycles', () => {
    it('should complete 10 boot/shutdown cycles', async () => {
        let successCount = 0;

        for (let i = 0; i < 10; i++) {
            const hal = createTestHAL();
            const vfs = new VFS(hal);
            const kernel = new Kernel(hal, vfs);

            await vfs.init();
            await kernel.boot({
                initPath: '/bin/true.ts',
                initArgs: ['true'],
                env: {},
            });

            const exited = await waitForInitExit(kernel, 5000);
            if (exited) successCount++;

            await kernel.shutdown();
            await hal.shutdown();
        }

        expect(successCount).toBe(10);
    });

    it('should complete 50 boot/shutdown cycles', { timeout: TIMEOUT_LONG }, async () => {
        let successCount = 0;

        for (let i = 0; i < 50; i++) {
            const hal = createTestHAL();
            const vfs = new VFS(hal);
            const kernel = new Kernel(hal, vfs);

            await vfs.init();
            await kernel.boot({
                initPath: '/bin/true.ts',
                initArgs: ['true'],
                env: {},
            });

            const exited = await waitForInitExit(kernel, 5000);
            if (exited) successCount++;

            await kernel.shutdown();
            await hal.shutdown();
        }

        expect(successCount).toBe(50);
    });
});

describe('Process Spawn: Child Processes via Shell', () => {
    let hal: HAL & { console: BufferConsoleDevice };
    let vfs: VFS;
    let kernel: Kernel;

    beforeEach(async () => {
        hal = createTestHAL();
        vfs = new VFS(hal);
        kernel = new Kernel(hal, vfs);
        await vfs.init();
    });

    afterEach(async () => {
        if (kernel.isBooted()) {
            await kernel.shutdown();
        }
        await hal.shutdown();
    });

    it('should spawn 5 sequential child processes', async () => {
        // Shell spawns echo 5 times sequentially
        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo 1 && echo 2 && echo 3 && echo 4 && echo 5'],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 10000);
        expect(exited).toBe(true);

        const output = hal.console.getOutput();
        expect(output).toContain('1');
        expect(output).toContain('2');
        expect(output).toContain('3');
        expect(output).toContain('4');
        expect(output).toContain('5');
    });

    it('should spawn 10 sequential child processes', async () => {
        const cmds = Array.from({ length: 10 }, (_, i) => `echo ${i + 1}`).join(' && ');

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', cmds],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 15000);
        expect(exited).toBe(true);

        const output = hal.console.getOutput();
        for (let i = 1; i <= 10; i++) {
            expect(output).toContain(String(i));
        }
    });

    it('should spawn 20 sequential child processes', { timeout: TIMEOUT_LONG }, async () => {
        const cmds = Array.from({ length: 20 }, (_, i) => `echo ${i + 1}`).join(' && ');

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', cmds],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 30000);
        expect(exited).toBe(true);

        const output = hal.console.getOutput();
        for (let i = 1; i <= 20; i++) {
            expect(output).toContain(String(i));
        }
    });
});

describe('Process Spawn: Rapid Exit Codes', () => {
    it('should correctly report exit code 0 (true)', async () => {
        const hal = createTestHAL();
        const vfs = new VFS(hal);
        const kernel = new Kernel(hal, vfs);

        await vfs.init();
        await kernel.boot({
            initPath: '/bin/true.ts',
            initArgs: ['true'],
            env: {},
        });

        await waitForInitExit(kernel, 5000);

        const init = kernel.getProcessTable().getInit();
        expect(init?.exitCode).toBe(0);

        await kernel.shutdown();
        await hal.shutdown();
    });

    it('should correctly report exit code 1 (false)', async () => {
        const hal = createTestHAL();
        const vfs = new VFS(hal);
        const kernel = new Kernel(hal, vfs);

        await vfs.init();
        await kernel.boot({
            initPath: '/bin/false.ts',
            initArgs: ['false'],
            env: {},
        });

        await waitForInitExit(kernel, 5000);

        const init = kernel.getProcessTable().getInit();
        expect(init?.exitCode).toBe(1);

        await kernel.shutdown();
        await hal.shutdown();
    });

    it('should handle 10 alternating true/false exits', async () => {
        const results: number[] = [];

        for (let i = 0; i < 10; i++) {
            const hal = createTestHAL();
            const vfs = new VFS(hal);
            const kernel = new Kernel(hal, vfs);

            const cmd = i % 2 === 0 ? '/bin/true.ts' : '/bin/false.ts';
            const expectedCode = i % 2 === 0 ? 0 : 1;

            await vfs.init();
            await kernel.boot({
                initPath: cmd,
                initArgs: [cmd.includes('true') ? 'true' : 'false'],
                env: {},
            });

            await waitForInitExit(kernel, 5000);

            const init = kernel.getProcessTable().getInit();
            results.push(init?.exitCode ?? -1);

            await kernel.shutdown();
            await hal.shutdown();

            expect(init?.exitCode).toBe(expectedCode);
        }

        expect(results).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    });
});

describe('Process Table: Cleanup After Exit', () => {
    it('should have empty process table after init exits and cleanup', async () => {
        const hal = createTestHAL();
        const vfs = new VFS(hal);
        const kernel = new Kernel(hal, vfs);

        await vfs.init();
        await kernel.boot({
            initPath: '/bin/true.ts',
            initArgs: ['true'],
            env: {},
        });

        await waitForInitExit(kernel, 5000);
        await kernel.shutdown();

        // After shutdown, process table should be empty
        expect(kernel.getProcessTable().size).toBe(0);

        await hal.shutdown();
    });

    it('should clean up 20 sequential boot cycles without leaking processes', { timeout: TIMEOUT_LONG }, async () => {
        for (let i = 0; i < 20; i++) {
            const hal = createTestHAL();
            const vfs = new VFS(hal);
            const kernel = new Kernel(hal, vfs);

            await vfs.init();
            await kernel.boot({
                initPath: '/bin/true.ts',
                initArgs: ['true'],
                env: {},
            });

            await waitForInitExit(kernel, 5000);
            await kernel.shutdown();

            // Verify cleanup
            expect(kernel.getProcessTable().size).toBe(0);

            await hal.shutdown();
        }
    });
});
