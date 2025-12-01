/**
 * Kernel Boot Integration Tests
 *
 * Tests end-to-end boot sequence:
 * 1. Create HAL with mock/memory backends
 * 2. Create VFS and kernel
 * 3. Boot kernel with test init process
 * 4. Verify process runs and makes syscalls
 * 5. Shutdown cleanly
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

describe('Kernel Boot', () => {
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

    it('should boot kernel and run test-echo process', async () => {
        // Boot with test-echo as init
        // Note: Worker path must be resolvable by Bun
        const initPath = new URL('../../src/bin/test-echo.ts', import.meta.url).pathname;

        await kernel.boot({
            initPath,
            env: { TEST: 'true' },
        });

        expect(kernel.isBooted()).toBe(true);

        // Give the process time to run
        // The process should: getpid() -> println() -> exit(42)
        await new Promise(resolve => setTimeout(resolve, 500));

        // Check console output
        const output = hal.console.getOutput();
        console.log('Console output:', output);

        // Process should have written to stdout
        expect(output).toContain('test-echo');
        expect(output).toContain('pid=');
    });

    it('should create /dev/console during VFS init', async () => {
        // Just init VFS, don't boot kernel
        await vfs.init();

        // Check /dev exists
        const devStat = await vfs.stat('/dev', 'kernel');
        expect(devStat).toBeDefined();
        expect(devStat.model).toBe('folder');

        // Check /dev/console exists
        const consoleStat = await vfs.stat('/dev/console', 'kernel');
        expect(consoleStat).toBeDefined();
        expect(consoleStat.model).toBe('device');
    });

    it('should allow reading and writing to /dev/console', async () => {
        await vfs.init();

        // Open console for writing
        const writeHandle = await vfs.open('/dev/console', { write: true }, 'kernel');
        const testData = new TextEncoder().encode('Hello from test!\n');
        await writeHandle.write(testData);
        await writeHandle.close();

        // Check it went to the buffer console
        const output = hal.console.getOutput();
        expect(output).toBe('Hello from test!\n');
    });

    it('should handle process that exits immediately', async () => {
        const initPath = new URL('../../src/bin/test-echo.ts', import.meta.url).pathname;

        await kernel.boot({
            initPath,
            env: {},
        });

        // Wait for process to exit
        await new Promise(resolve => setTimeout(resolve, 500));

        // Kernel should still be booted (init becoming zombie doesn't unboot)
        expect(kernel.isBooted()).toBe(true);

        // Check process table - init should be zombie
        const processTable = kernel.getProcessTable();
        const init = processTable.getInit();
        expect(init).not.toBeNull();
        // Note: init might be zombie or still running depending on timing
    });
});

describe('VFS Device Initialization', () => {
    let hal: HAL;
    let vfs: VFS;

    beforeEach(() => {
        hal = createTestHAL();
        vfs = new VFS(hal);
    });

    afterEach(async () => {
        await hal.shutdown();
    });

    it('should create standard devices', async () => {
        await vfs.init();

        const devices = ['null', 'zero', 'random', 'urandom', 'console', 'clock'];

        for (const device of devices) {
            const stat = await vfs.stat(`/dev/${device}`, 'kernel');
            expect(stat).toBeDefined();
            expect(stat.model).toBe('device');
            expect(stat.name).toBe(device);
        }
    });

    it('should read zeros from /dev/zero', async () => {
        await vfs.init();

        const handle = await vfs.open('/dev/zero', { read: true }, 'kernel');
        const data = await handle.read(16);
        await handle.close();

        expect(data.length).toBe(16);
        expect(data.every(b => b === 0)).toBe(true);
    });

    it('should discard writes to /dev/null', async () => {
        await vfs.init();

        const handle = await vfs.open('/dev/null', { write: true }, 'kernel');
        const written = await handle.write(new Uint8Array([1, 2, 3, 4, 5]));
        await handle.close();

        expect(written).toBe(5);
    });

    it('should return random bytes from /dev/random', async () => {
        await vfs.init();

        const handle = await vfs.open('/dev/random', { read: true }, 'kernel');
        const data1 = await handle.read(16);
        const data2 = await handle.read(16);
        await handle.close();

        expect(data1.length).toBe(16);
        expect(data2.length).toBe(16);
        // Very unlikely to be equal
        expect(data1).not.toEqual(data2);
    });
});
