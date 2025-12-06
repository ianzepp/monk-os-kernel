/**
 * Process Spawn/Kill Performance Tests
 *
 * Validates process lifecycle under high-volume conditions.
 * Focus: correctness of spawn/exit, not timing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { poll } from '@src/kernel/poll.js';
import { createOsStack, type OsStack } from '@src/os/stack.js';
import type { Kernel } from '@src/kernel/kernel.js';

const TIMEOUT_LONG = 60_000;

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
            const stack = await createOsStack({ kernel: true });
            const kernel = stack.kernel!;

            await kernel.boot({
                initPath: '/bin/true.ts',
                initArgs: ['true'],
                env: {},
            });

            const exited = await waitForInitExit(kernel, 5000);
            if (exited) successCount++;

            await stack.shutdown();
        }

        expect(successCount).toBe(10);
    });

    it('should complete 50 boot/shutdown cycles', async () => {
        let successCount = 0;

        for (let i = 0; i < 50; i++) {
            const stack = await createOsStack({ kernel: true });
            const kernel = stack.kernel!;

            await kernel.boot({
                initPath: '/bin/true.ts',
                initArgs: ['true'],
                env: {},
            });

            const exited = await waitForInitExit(kernel, 5000);
            if (exited) successCount++;

            await stack.shutdown();
        }

        expect(successCount).toBe(50);
    }, { timeout: TIMEOUT_LONG });
});

// SKIP: Requires /bin/shell.ts which is not yet implemented
describe.skip('Process Spawn: Child Processes via Shell', () => {
    let stack: OsStack;
    let kernel: Kernel;

    beforeEach(async () => {
        stack = await createOsStack({ kernel: true });
        kernel = stack.kernel!;
    });

    afterEach(async () => {
        await stack.shutdown();
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
    }, { timeout: TIMEOUT_LONG });
});

describe('Process Spawn: Rapid Exit Codes', () => {
    it('should correctly report exit code 0 (true)', async () => {
        const stack = await createOsStack({ kernel: true });
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/true.ts',
            initArgs: ['true'],
            env: {},
        });

        await waitForInitExit(kernel, 5000);

        const init = kernel.getProcessTable().getInit();
        expect(init?.exitCode).toBe(0);

        await stack.shutdown();
    });

    it('should correctly report exit code 1 (false)', async () => {
        const stack = await createOsStack({ kernel: true });
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/false.ts',
            initArgs: ['false'],
            env: {},
        });

        await waitForInitExit(kernel, 5000);

        const init = kernel.getProcessTable().getInit();
        expect(init?.exitCode).toBe(1);

        await stack.shutdown();
    });

    it('should handle 10 alternating true/false exits', async () => {
        const results: number[] = [];

        for (let i = 0; i < 10; i++) {
            const stack = await createOsStack({ kernel: true });
            const kernel = stack.kernel!;

            const cmd = i % 2 === 0 ? '/bin/true.ts' : '/bin/false.ts';
            const expectedCode = i % 2 === 0 ? 0 : 1;

            await kernel.boot({
                initPath: cmd,
                initArgs: [cmd.includes('true') ? 'true' : 'false'],
                env: {},
            });

            await waitForInitExit(kernel, 5000);

            const init = kernel.getProcessTable().getInit();
            results.push(init?.exitCode ?? -1);

            await stack.shutdown();

            expect(init?.exitCode).toBe(expectedCode);
        }

        expect(results).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    });
});

// SKIP: Requires /bin/shell.ts which is not yet implemented
// Pipe chain tests - validates the CAT_LOOP bug fix
describe.skip('Process Spawn: Pipe Chains', () => {
    let stack: OsStack;
    let kernel: Kernel;

    beforeEach(async () => {
        stack = await createOsStack({ kernel: true });
        kernel = stack.kernel!;
    });

    afterEach(async () => {
        await stack.shutdown();
    });

    it('should pipe through 3 cats (short string)', async () => {
        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo hello | cat | cat | cat'],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 10000);
        expect(exited).toBe(true);
    });

    it('should pipe through 5 cats (short string)', async () => {
        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo hello | cat | cat | cat | cat | cat'],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 15000);
        expect(exited).toBe(true);
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
    }, { timeout: TIMEOUT_LONG });

    it('should pipe 10 lines through 5 cats', async () => {
        const cats = Array(5).fill('cat').join(' | ');

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', `echo "line1\nline2\nline3\nline4\nline5" | ${cats}`],
            env: {},
        });

        const exited = await waitForInitExit(kernel, 15000);
        expect(exited).toBe(true);
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
    });
});

describe('Process Table: Cleanup After Exit', () => {
    it('should have empty process table after init exits and cleanup', async () => {
        const stack = await createOsStack({ kernel: true });
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/true.ts',
            initArgs: ['true'],
            env: {},
        });

        await waitForInitExit(kernel, 5000);
        await stack.shutdown();

        // After shutdown, process table should be empty
        expect(kernel.getProcessTable().size).toBe(0);
    });

    it('should clean up 20 sequential boot cycles without leaking processes', async () => {
        for (let i = 0; i < 20; i++) {
            const stack = await createOsStack({ kernel: true });
            const kernel = stack.kernel!;

            await kernel.boot({
                initPath: '/bin/true.ts',
                initArgs: ['true'],
                env: {},
            });

            await waitForInitExit(kernel, 5000);
            await stack.shutdown();

            // Verify cleanup
            expect(kernel.getProcessTable().size).toBe(0);
        }
    }, { timeout: TIMEOUT_LONG });
});
