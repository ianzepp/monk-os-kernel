/**
 * Shell Integration Tests
 *
 * Tests the shell command execution through the kernel using createOsStack().
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { poll } from '@src/kernel/poll.js';
import { createOsStack, type OsStack } from '@src/os/stack.js';
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
    BunCompressionDevice,
    BunFileDevice,
} from '@src/hal/index.js';
import type { Kernel } from '@src/kernel/kernel.js';

/**
 * Create a test HAL with memory backends and buffer console.
 * This HAL is compatible with createOsStack() when passed as hal option.
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
        compression: new BunCompressionDevice(),
        file: new BunFileDevice(),

        async init(): Promise<void> {
            // No-op for test HAL
        },

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
    const exited = await poll(() => {
        const init = kernel.getProcessTable().getInit();
        return !init || init.state === 'zombie';
    }, { timeout });
    if (!exited) throw new Error('Timeout waiting for init to exit');
}

describe('Shell', () => {
    let hal: HAL & { console: BufferConsoleDevice };
    let stack: OsStack;

    beforeEach(async () => {
        // Create HAL with BufferConsoleDevice first
        hal = createTestHAL();
        await hal.init();

        // Pass HAL to createOsStack - it will create EMS, VFS, Kernel using this HAL
        stack = await createOsStack({ hal, kernel: true });
    });

    afterEach(async () => {
        await stack.shutdown();
        // Note: stack.shutdown() doesn't shutdown HAL we passed in (ownsHal=false)
        await hal.shutdown();
    });

    it('should execute shell -c "echo hello"', async () => {
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo hello world'],
            env: {},
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        expect(output).toContain('hello world');
    });

    it('should execute shell --version', async () => {
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '--version'],
            env: {},
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        expect(output).toContain('Monk Shell');
        expect(output).toContain('0.1.0');
    });

    it('should execute pwd command', async () => {
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'pwd'],
            env: {},
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        expect(output).toContain('/');
    });

    it('should handle command chaining with &&', async () => {
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo first && echo second'],
            env: {},
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        expect(output).toContain('first');
        expect(output).toContain('second');
    });

    it('should expand variables', async () => {
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo $HOME'],
            env: { HOME: '/home/test' },
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        expect(output).toContain('/home/test');
    });

    it('should handle output redirect (>)', async () => {
        const kernel = stack.kernel!;
        const vfs = stack.vfs!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo hello > /test.txt'],
            env: {},
        });

        await waitForInitExit(kernel);

        // Read the file from VFS
        const handle = await vfs.open('/test.txt', { read: true }, 'kernel');
        const content = await handle.read();
        await handle.close();

        const text = new TextDecoder().decode(content);
        expect(text.trim()).toBe('hello');
    });

    it('should handle append redirect (>>)', async () => {
        const kernel = stack.kernel!;
        const vfs = stack.vfs!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo first > /append.txt && echo second >> /append.txt'],
            env: {},
        });

        await waitForInitExit(kernel);

        // Read the file from VFS
        const handle = await vfs.open('/append.txt', { read: true }, 'kernel');
        const content = await handle.read();
        await handle.close();

        const text = new TextDecoder().decode(content);
        expect(text).toContain('first');
        expect(text).toContain('second');
    });

    it('should spawn child that writes to stdout', async () => {
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo test123 > /test.txt && cat /test.txt'],
            env: {},
        });

        await waitForInitExit(kernel);

        const output = hal.console.getOutput();
        expect(output).toContain('test123');
    });

    it('should handle simple pipe (echo | cat)', async () => {
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo hello | cat'],
            env: {},
        });

        await waitForInitExit(kernel, 10000);

        const output = hal.console.getOutput();
        expect(output).toContain('hello');
    });

    it('should pipe true output to cat', async () => {
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'true | cat'],
            env: {},
        });

        await waitForInitExit(kernel, 10000);

        // true outputs nothing, so cat should get EOF immediately and exit
        // If cat exited cleanly, shell should exit with 0
        const init = kernel.getProcessTable().getInit();
        expect(init?.state).toBe('zombie');
    });

    it('should pipe cat from file through more cats', async () => {
        const kernel = stack.kernel!;

        await kernel.boot({
            initPath: '/bin/shell.ts',
            initArgs: ['shell', '-c', 'echo "file content" > /pipetest.txt && cat /pipetest.txt | cat'],
            env: {},
        });

        await waitForInitExit(kernel, 10000);

        const output = hal.console.getOutput();
        expect(output).toContain('file content');
    });
});
