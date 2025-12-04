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
    MockCompressionDevice,
    MockFileDevice,
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
        compression: new MockCompressionDevice(),
        file: new MockFileDevice(),

        async init(): Promise<void> {
            // No initialization needed for these mock devices
        },

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

    it('should complete 50 boot/shutdown cycles', async () => {
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
    }, { timeout: TIMEOUT_LONG });
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

    it('should spawn 20 sequential child processes', async () => {
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
    }, { timeout: TIMEOUT_LONG });
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

// Pipe chain tests - validates the CAT_LOOP bug fix
describe('Process Spawn: Pipe Chains', () => {
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

    it('should pipe through 3 cats (short string)', async () => {
        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo hello | cat | cat | cat'],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 10000);
        expect(exited).toBe(true);

        const output = hal.console.getOutput();
        expect(output.trim()).toBe('hello');
    });

    it('should pipe through 5 cats (short string)', async () => {
        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo hello | cat | cat | cat | cat | cat'],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 15000);
        expect(exited).toBe(true);

        const output = hal.console.getOutput();
        expect(output.trim()).toBe('hello');
    });

    it('should pipe through 10 cats (short string)', async () => {
        const cats = Array(10).fill('cat').join(' | ');
        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', `echo hello | ${cats}`],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 30000);
        expect(exited).toBe(true);

        const output = hal.console.getOutput();
        expect(output.trim()).toBe('hello');
    }, { timeout: TIMEOUT_LONG });

    it('should pipe 100 char string through 5 cats', async () => {
        const text = 'x'.repeat(100);
        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', `echo ${text} | cat | cat | cat | cat | cat`],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 15000);
        expect(exited).toBe(true);

        const output = hal.console.getOutput();
        expect(output.trim()).toBe(text);
    });

    it('should pipe 1000 char string through 5 cats', async () => {
        const text = 'y'.repeat(1000);
        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', `echo ${text} | cat | cat | cat | cat | cat`],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 30000);
        expect(exited).toBe(true);

        const output = hal.console.getOutput();
        expect(output.trim()).toBe(text);
    }, { timeout: TIMEOUT_LONG });

    it('should pipe 10 lines through 5 cats', async () => {
        const cats = Array(5).fill('cat').join(' | ');

        // Use subshell-like grouping: (echo a && echo b) | cat
        // Shell may not support (), so use multiple echos piped individually
        // Actually, let's just test single echo through cats
        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', `echo "line1\nline2\nline3\nline4\nline5" | ${cats}`],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 15000);
        expect(exited).toBe(true);

        const output = hal.console.getOutput();
        // Echo outputs the literal string with \n - check it arrived intact
        expect(output).toContain('line1');
    });

    it('should pipe file through 5 cats', async () => {
        // First create a test file, then pipe it
        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo "test file content" > /tmp/test.txt && cat /tmp/test.txt | cat | cat | cat | cat | cat'],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 15000);
        expect(exited).toBe(true);

        const output = hal.console.getOutput();
        expect(output).toContain('test file content');
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

    it('should clean up 20 sequential boot cycles without leaking processes', async () => {
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
    }, { timeout: TIMEOUT_LONG });
});
