/**
 * Shell Integration Tests
 *
 * Tests the shell command execution through the kernel.
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

/**
 * Wait for the init process to exit (become zombie).
 * Much faster than fixed timeouts since we poll every 10ms.
 */
async function waitForInitExit(kernel: Kernel, timeout = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const init = kernel.getProcessTable().getInit();
        if (!init || init.state === 'zombie') return;
        await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('Timeout waiting for init to exit');
}

describe('Shell', () => {
    let hal: HAL & { console: BufferConsoleDevice };
    let vfs: VFS;
    let kernel: Kernel;

    beforeEach(async () => {
        hal = createTestHAL();
        vfs = new VFS(hal);
        kernel = new Kernel(hal, vfs);

        // Initialize VFS
        await vfs.init();
    });

    afterEach(async () => {
        if (kernel.isBooted()) {
            await kernel.shutdown();
        }
        await hal.shutdown();
    });

    it('should execute shell -c "echo hello"', async () => {
        const shellPath = '/bin/shell.ts';

        await kernel.boot({
            initPath: shellPath,
            initArgs: ['shell', '-c', 'echo hello world'],
            env: {},
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        expect(output).toContain('hello world');
    });

    it('should execute shell --version', async () => {
        const shellPath = '/bin/shell.ts';

        await kernel.boot({
            initPath: shellPath,
            initArgs: ['shell', '--version'],
            env: {},
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        expect(output).toContain('Monk Shell');
        expect(output).toContain('0.1.0');
    });

    it('should execute pwd command', async () => {
        const shellPath = '/bin/shell.ts';

        await kernel.boot({
            initPath: shellPath,
            initArgs: ['shell', '-c', 'pwd'],
            env: {},
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        console.log('Output:', output);

        // pwd should output /
        expect(output).toContain('/');
    });

    it('should handle command chaining with &&', async () => {
        const shellPath = '/bin/shell.ts';

        await kernel.boot({
            initPath: shellPath,
            initArgs: ['shell', '-c', 'echo first && echo second'],
            env: {},
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        console.log('Output:', output);

        expect(output).toContain('first');
        expect(output).toContain('second');
    });

    it('should expand variables', async () => {
        const shellPath = '/bin/shell.ts';

        await kernel.boot({
            initPath: shellPath,
            initArgs: ['shell', '-c', 'echo $HOME'],
            env: { HOME: '/home/test' },
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        console.log('Output:', output);

        expect(output).toContain('/home/test');
    });

    it('should handle output redirect (>)', async () => {
        const shellPath = '/bin/shell.ts';

        await kernel.boot({
            initPath: shellPath,
            initArgs: ['shell', '-c', 'echo hello > /test.txt'],
            env: {},
        });

        await waitForInitExit(kernel);

        // Read the file from VFS
        const handle = await vfs.open('/test.txt', { read: true }, 'kernel');
        const content = await handle.read();
        await handle.close();

        const text = new TextDecoder().decode(content);
        console.log('File content:', text);

        expect(text.trim()).toBe('hello');
    });

    it('should handle append redirect (>>)', async () => {
        const shellPath = '/bin/shell.ts';

        // Create file and append in same shell process (same owner, same ACL)
        await kernel.boot({
            initPath: shellPath,
            initArgs: ['shell', '-c', 'echo first > /append.txt && echo second >> /append.txt'],
            env: {},
        });

        await waitForInitExit(kernel);

        // Read the file from VFS
        const handle = await vfs.open('/append.txt', { read: true }, 'kernel');
        const content = await handle.read();
        await handle.close();

        const text = new TextDecoder().decode(content);
        console.log('File content:', text);

        expect(text).toContain('first');
        expect(text).toContain('second');
    });

    // Note: Input redirect (<) is implemented but not tested here because
    // it requires an external command that reads from stdin (e.g., cat).
    // The redirect() syscall correctly redirects fd 0, but no builtin reads stdin.
});
