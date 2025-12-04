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
    BunChannelDevice,
} from '@src/hal/index.js';
import { createTestVfs } from '../helpers/test-mocks.js';

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
        channel: new BunChannelDevice(),

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
        vfs = await createTestVfs(hal);
        kernel = new Kernel(hal, vfs);
    });

    afterEach(async () => {
        if (kernel.isBooted()) {
            await kernel.shutdown();
        }
        await hal.shutdown();
    });

    // TODO: Create proper test fixtures for boot integration tests
    it.skip('should boot kernel and run test-echo process', async () => {
        // Requires test fixture: rom/bin/test-echo.ts
    });

    it('should create /dev/console during VFS init', async () => {
        // VFS already initialized by createTestVfs

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
        // VFS already initialized by createTestVfs

        // Open console for writing
        const writeHandle = await vfs.open('/dev/console', { write: true }, 'kernel');
        const testData = new TextEncoder().encode('Hello from test!\n');
        await writeHandle.write(testData);
        await writeHandle.close();

        // Check it went to the buffer console
        const output = hal.console.getOutput();
        expect(output).toBe('Hello from test!\n');
    });

    // TODO: Create proper test fixtures for boot integration tests
    it.skip('should handle process that exits immediately', async () => {
        // Requires test fixture: rom/bin/test-echo.ts
    });
});

describe('VFS Device Initialization', () => {
    let hal: HAL;
    let vfs: VFS;

    beforeEach(async () => {
        hal = createTestHAL();
        vfs = await createTestVfs(hal);
    });

    afterEach(async () => {
        await hal.shutdown();
    });

    it('should create standard devices', async () => {
        // VFS already initialized by createTestVfs

        const devices = ['null', 'zero', 'random', 'urandom', 'console', 'clock'];

        for (const device of devices) {
            const stat = await vfs.stat(`/dev/${device}`, 'kernel');
            expect(stat).toBeDefined();
            expect(stat.model).toBe('device');
            expect(stat.name).toBe(device);
        }
    });

    it('should read zeros from /dev/zero', async () => {
        // VFS already initialized by createTestVfs

        const handle = await vfs.open('/dev/zero', { read: true }, 'kernel');
        const data = await handle.read(16);
        await handle.close();

        expect(data.length).toBe(16);
        expect(data.every(b => b === 0)).toBe(true);
    });

    it('should discard writes to /dev/null', async () => {
        // VFS already initialized by createTestVfs

        const handle = await vfs.open('/dev/null', { write: true }, 'kernel');
        const written = await handle.write(new Uint8Array([1, 2, 3, 4, 5]));
        await handle.close();

        expect(written).toBe(5);
    });

    it('should return random bytes from /dev/random', async () => {
        // VFS already initialized by createTestVfs

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
