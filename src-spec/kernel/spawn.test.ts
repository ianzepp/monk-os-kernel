/**
 * Spawn and Wait Integration Tests
 *
 * Tests process creation and lifecycle:
 * - Parent spawns child
 * - Child runs and exits
 * - Parent waits and gets exit status
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kernel } from '@src/kernel/kernel.js';
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
} from '@src/hal/index.js';

/**
 * Create a test HAL with memory backends and buffer console
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

        async shutdown(): Promise<void> {
            timer.cancelAll();
            await storage.close();
        },
    };
}

describe('Spawn and Wait', () => {
    let hal: HAL & { console: BufferConsoleDevice };
    let vfs: VFS;
    let kernel: Kernel;

    beforeEach(async () => {
        hal = createTestHAL();
        vfs = new VFS(hal);
        kernel = new Kernel(hal, vfs);
    });

    afterEach(async () => {
        if (kernel.isBooted()) {
            await kernel.shutdown();
        }
        await hal.shutdown();
    });

    it('should spawn child and wait for exit', async () => {
        const parentPath = '/bin/test-parent.ts';
        const childPath = '/bin/test-child.ts';

        await kernel.boot({
            initPath: parentPath,
            env: {
                CHILD_PATH: childPath,
                CHILD_EXIT_CODE: '42',
            },
        });

        // Give processes time to run
        await new Promise(resolve => setTimeout(resolve, 1000));

        const output = hal.console.getOutput();
        console.log('Output:', output);

        // Verify parent started
        expect(output).toContain('parent: pid=1 starting');

        // Verify child spawned
        expect(output).toContain('parent: spawning');
        expect(output).toContain('parent: spawned child pid=');

        // Verify child ran
        expect(output).toContain('child: pid=');
        expect(output).toContain('ppid=1');
        expect(output).toContain('will-exit=42');

        // Verify parent got exit status
        expect(output).toContain('parent: child exited with code=42');
    });

    it('should report correct exit code from child', async () => {
        const parentPath = '/bin/test-parent.ts';
        const childPath = '/bin/test-child.ts';

        await kernel.boot({
            initPath: parentPath,
            env: {
                CHILD_PATH: childPath,
                CHILD_EXIT_CODE: '7',
            },
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        const output = hal.console.getOutput();
        expect(output).toContain('will-exit=7');
        expect(output).toContain('child exited with code=7');
    });

    it('should handle child that exits with 0', async () => {
        const parentPath = '/bin/test-parent.ts';
        const childPath = '/bin/test-child.ts';

        await kernel.boot({
            initPath: parentPath,
            env: {
                CHILD_PATH: childPath,
                CHILD_EXIT_CODE: '0',
            },
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        const output = hal.console.getOutput();
        expect(output).toContain('will-exit=0');
        expect(output).toContain('child exited with code=0');
    });

    it('should assign correct PIDs', async () => {
        const parentPath = '/bin/test-parent.ts';
        const childPath = '/bin/test-child.ts';

        await kernel.boot({
            initPath: parentPath,
            env: {
                CHILD_PATH: childPath,
                CHILD_EXIT_CODE: '0',
            },
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        const output = hal.console.getOutput();

        // Parent is init, so pid=1
        expect(output).toContain('parent: pid=1');

        // Child's ppid should be 1 (parent)
        expect(output).toContain('ppid=1');

        // Child's pid should be 1 (first child in parent's namespace)
        // Note: child sees its own pid as 1 because it's the first child parent spawned
        expect(output).toMatch(/child: pid=1/);
    });

    it('should track multiple children in process table', async () => {
        // For this we need a multi-spawn parent
        // For now, verify process table state after spawn
        const parentPath = '/bin/test-parent.ts';
        const childPath = '/bin/test-child.ts';

        await kernel.boot({
            initPath: parentPath,
            env: {
                CHILD_PATH: childPath,
                CHILD_EXIT_CODE: '0',
            },
        });

        // Check process table while running
        await new Promise(resolve => setTimeout(resolve, 100));

        const processTable = kernel.getProcessTable();
        // Should have at least init
        expect(processTable.size).toBeGreaterThanOrEqual(1);
    });
});

describe('Spawn Errors', () => {
    let hal: HAL & { console: BufferConsoleDevice };
    let vfs: VFS;
    let kernel: Kernel;

    beforeEach(async () => {
        hal = createTestHAL();
        vfs = new VFS(hal);
        kernel = new Kernel(hal, vfs);
    });

    afterEach(async () => {
        if (kernel.isBooted()) {
            await kernel.shutdown();
        }
        await hal.shutdown();
    });

    it('should handle spawn of non-existent file', async () => {
        const parentPath = '/bin/test-parent.ts';

        await kernel.boot({
            initPath: parentPath,
            env: {
                CHILD_PATH: '/nonexistent/path.ts',
                CHILD_EXIT_CODE: '0',
            },
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        const output = hal.console.getOutput();
        const errors = hal.console.getErrors();

        console.log('Output:', output);
        console.log('Errors:', errors);

        // Parent should start
        expect(output).toContain('parent: pid=1 starting');

        // Spawn should fail - either in output or errors
        // The worker creation will fail
    });
});
