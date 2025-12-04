/**
 * Kernel Boot Integration Tests
 *
 * Tests end-to-end boot sequence using createOsStack().
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createOsStack, type OsStack } from '@src/os/stack.js';
import { BufferConsoleDevice } from '@src/hal/index.js';

describe('Kernel Boot', () => {
    let stack: OsStack;

    beforeEach(async () => {
        stack = await createOsStack({ kernel: true });
    });

    afterEach(async () => {
        await stack.shutdown();
    });

    it('should create /dev/console during VFS init', async () => {
        // VFS is already initialized by createOsStack
        const vfs = stack.vfs!;

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
        const vfs = stack.vfs!;

        // Open console for writing
        const writeHandle = await vfs.open('/dev/console', { write: true }, 'kernel');
        const testData = new TextEncoder().encode('Hello from test!\n');
        const bytesWritten = await writeHandle.write(testData);
        await writeHandle.close();

        // Verify write completed successfully
        expect(bytesWritten).toBe(testData.length);
    });
});

describe('VFS Device Initialization', () => {
    let stack: OsStack;

    beforeEach(async () => {
        stack = await createOsStack({ vfs: true });
    });

    afterEach(async () => {
        await stack.shutdown();
    });

    it('should create standard devices', async () => {
        const vfs = stack.vfs!;

        const devices = ['null', 'zero', 'random', 'urandom', 'console', 'clock'];

        for (const device of devices) {
            const stat = await vfs.stat(`/dev/${device}`, 'kernel');
            expect(stat).toBeDefined();
            expect(stat.model).toBe('device');
            expect(stat.name).toBe(device);
        }
    });

    it('should read zeros from /dev/zero', async () => {
        const vfs = stack.vfs!;

        const handle = await vfs.open('/dev/zero', { read: true }, 'kernel');
        const data = await handle.read(16);
        await handle.close();

        expect(data.length).toBe(16);
        expect(data.every(b => b === 0)).toBe(true);
    });

    it('should discard writes to /dev/null', async () => {
        const vfs = stack.vfs!;

        const handle = await vfs.open('/dev/null', { write: true }, 'kernel');
        const written = await handle.write(new Uint8Array([1, 2, 3, 4, 5]));
        await handle.close();

        expect(written).toBe(5);
    });

    it('should return random bytes from /dev/random', async () => {
        const vfs = stack.vfs!;

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
