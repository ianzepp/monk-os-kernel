/**
 * VFS Storage Performance Tests
 *
 * Tests for file I/O performance on /tmp (memory-backed VFS).
 * Measures write, read, list, and delete operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

/**
 * Create a test HAL with memory backends
 */
function createTestHAL(): HAL {
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

const TIMEOUT_MEDIUM = 30_000;
const TIMEOUT_LONG = 60_000;

describe('VFS Storage: Write Performance', () => {
    let hal: HAL;
    let vfs: VFS;
    const caller = 'perf-test';

    beforeEach(async () => {
        hal = createTestHAL();
        vfs = new VFS(hal);
        await vfs.init();

        // Create /tmp with world-writable permissions
        await vfs.mkdir('/tmp', 'kernel');
        await vfs.setAccess('/tmp', 'kernel', {
            grants: [
                { to: 'kernel', ops: ['*'] },
                { to: '*', ops: ['read', 'write', 'create', 'delete', 'list', 'stat'] },
            ],
            deny: [],
        });
    });

    afterEach(async () => {
        await hal.shutdown();
    });

    it('should write 1KB file', async () => {
        const data = new Uint8Array(1024).fill(65); // 1KB of 'A'
        const path = `/tmp/${crypto.randomUUID()}.bin`;

        const start = performance.now();
        const handle = await vfs.open(path, { write: true, create: true }, caller);
        await handle.write(data);
        await handle.close();
        const elapsed = performance.now() - start;

        console.log(`Write 1KB: ${elapsed.toFixed(2)}ms`);
        expect(elapsed).toBeLessThan(100);
    });

    it('should write 100KB file', async () => {
        const data = new Uint8Array(100 * 1024).fill(65);
        const path = `/tmp/${crypto.randomUUID()}.bin`;

        const start = performance.now();
        const handle = await vfs.open(path, { write: true, create: true }, caller);
        await handle.write(data);
        await handle.close();
        const elapsed = performance.now() - start;

        console.log(`Write 100KB: ${elapsed.toFixed(2)}ms`);
        expect(elapsed).toBeLessThan(200);
    });

    it('should write 1MB file', async () => {
        const data = new Uint8Array(1024 * 1024).fill(65);
        const path = `/tmp/${crypto.randomUUID()}.bin`;

        const start = performance.now();
        const handle = await vfs.open(path, { write: true, create: true }, caller);
        await handle.write(data);
        await handle.close();
        const elapsed = performance.now() - start;

        console.log(`Write 1MB: ${elapsed.toFixed(2)}ms`);
        expect(elapsed).toBeLessThan(500);
    });

    it('should write 10MB file', async () => {
        const data = new Uint8Array(10 * 1024 * 1024).fill(65);
        const path = `/tmp/${crypto.randomUUID()}.bin`;

        const start = performance.now();
        const handle = await vfs.open(path, { write: true, create: true }, caller);
        await handle.write(data);
        await handle.close();
        const elapsed = performance.now() - start;

        console.log(`Write 10MB: ${elapsed.toFixed(2)}ms`);
        expect(elapsed).toBeLessThan(2000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('should write 100 small files (1KB each)', async () => {
        const data = new Uint8Array(1024).fill(65);
        const files: string[] = [];

        const start = performance.now();
        for (let i = 0; i < 100; i++) {
            const path = `/tmp/${crypto.randomUUID()}.bin`;
            files.push(path);
            const handle = await vfs.open(path, { write: true, create: true }, caller);
            await handle.write(data);
            await handle.close();
        }
        const elapsed = performance.now() - start;

        console.log(`Write 100 x 1KB files: ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(2)}ms/file)`);
        expect(elapsed).toBeLessThan(5000);
    });

    it('should write 1000 small files (1KB each)', async () => {
        const data = new Uint8Array(1024).fill(65);

        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
            const path = `/tmp/${crypto.randomUUID()}.bin`;
            const handle = await vfs.open(path, { write: true, create: true }, caller);
            await handle.write(data);
            await handle.close();
        }
        const elapsed = performance.now() - start;

        console.log(`Write 1000 x 1KB files: ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(2)}ms/file)`);
        expect(elapsed).toBeLessThan(30000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('should write 100 medium files (100KB each)', async () => {
        const data = new Uint8Array(100 * 1024).fill(65);

        const start = performance.now();
        for (let i = 0; i < 100; i++) {
            const path = `/tmp/${crypto.randomUUID()}.bin`;
            const handle = await vfs.open(path, { write: true, create: true }, caller);
            await handle.write(data);
            await handle.close();
        }
        const elapsed = performance.now() - start;

        console.log(`Write 100 x 100KB files: ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(2)}ms/file)`);
        expect(elapsed).toBeLessThan(10000);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('VFS Storage: Read Performance', () => {
    let hal: HAL;
    let vfs: VFS;
    const caller = 'perf-test';

    beforeEach(async () => {
        hal = createTestHAL();
        vfs = new VFS(hal);
        await vfs.init();

        await vfs.mkdir('/tmp', 'kernel');
        await vfs.setAccess('/tmp', 'kernel', {
            grants: [
                { to: 'kernel', ops: ['*'] },
                { to: '*', ops: ['read', 'write', 'create', 'delete', 'list', 'stat'] },
            ],
            deny: [],
        });
    });

    afterEach(async () => {
        await hal.shutdown();
    });

    async function createFile(path: string, size: number): Promise<void> {
        const data = new Uint8Array(size).fill(65);
        const handle = await vfs.open(path, { write: true, create: true }, caller);
        await handle.write(data);
        await handle.close();
    }

    it('should read 1KB file', async () => {
        const path = `/tmp/${crypto.randomUUID()}.bin`;
        await createFile(path, 1024);

        const start = performance.now();
        const handle = await vfs.open(path, { read: true }, caller);
        const data = await handle.read();
        await handle.close();
        const elapsed = performance.now() - start;

        console.log(`Read 1KB: ${elapsed.toFixed(2)}ms`);
        expect(data.length).toBe(1024);
        expect(elapsed).toBeLessThan(50);
    });

    it('should read 100KB file', async () => {
        const path = `/tmp/${crypto.randomUUID()}.bin`;
        await createFile(path, 100 * 1024);

        const start = performance.now();
        const handle = await vfs.open(path, { read: true }, caller);
        const data = await handle.read();
        await handle.close();
        const elapsed = performance.now() - start;

        console.log(`Read 100KB: ${elapsed.toFixed(2)}ms`);
        expect(data.length).toBe(100 * 1024);
        expect(elapsed).toBeLessThan(100);
    });

    it('should read 1MB file', async () => {
        const path = `/tmp/${crypto.randomUUID()}.bin`;
        await createFile(path, 1024 * 1024);

        const start = performance.now();
        const handle = await vfs.open(path, { read: true }, caller);
        const data = await handle.read();
        await handle.close();
        const elapsed = performance.now() - start;

        console.log(`Read 1MB: ${elapsed.toFixed(2)}ms`);
        expect(data.length).toBe(1024 * 1024);
        expect(elapsed).toBeLessThan(200);
    });

    it('should read 10MB file', async () => {
        const path = `/tmp/${crypto.randomUUID()}.bin`;
        await createFile(path, 10 * 1024 * 1024);

        const start = performance.now();
        const handle = await vfs.open(path, { read: true }, caller);
        const data = await handle.read();
        await handle.close();
        const elapsed = performance.now() - start;

        console.log(`Read 10MB: ${elapsed.toFixed(2)}ms`);
        expect(data.length).toBe(10 * 1024 * 1024);
        expect(elapsed).toBeLessThan(1000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('should read 100 small files (1KB each)', async () => {
        const files: string[] = [];
        for (let i = 0; i < 100; i++) {
            const path = `/tmp/${crypto.randomUUID()}.bin`;
            files.push(path);
            await createFile(path, 1024);
        }

        const start = performance.now();
        for (const path of files) {
            const handle = await vfs.open(path, { read: true }, caller);
            await handle.read();
            await handle.close();
        }
        const elapsed = performance.now() - start;

        console.log(`Read 100 x 1KB files: ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(2)}ms/file)`);
        expect(elapsed).toBeLessThan(2000);
    });

    it('should read 1000 small files (1KB each)', async () => {
        const files: string[] = [];
        for (let i = 0; i < 1000; i++) {
            const path = `/tmp/${crypto.randomUUID()}.bin`;
            files.push(path);
            await createFile(path, 1024);
        }

        const start = performance.now();
        for (const path of files) {
            const handle = await vfs.open(path, { read: true }, caller);
            await handle.read();
            await handle.close();
        }
        const elapsed = performance.now() - start;

        console.log(`Read 1000 x 1KB files: ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(2)}ms/file)`);
        expect(elapsed).toBeLessThan(15000);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('VFS Storage: List Performance', () => {
    let hal: HAL;
    let vfs: VFS;
    const caller = 'perf-test';

    beforeEach(async () => {
        hal = createTestHAL();
        vfs = new VFS(hal);
        await vfs.init();

        await vfs.mkdir('/tmp', 'kernel');
        await vfs.setAccess('/tmp', 'kernel', {
            grants: [
                { to: 'kernel', ops: ['*'] },
                { to: '*', ops: ['read', 'write', 'create', 'delete', 'list', 'stat'] },
            ],
            deny: [],
        });
    });

    afterEach(async () => {
        await hal.shutdown();
    });

    async function createFiles(count: number): Promise<void> {
        const data = new Uint8Array(100).fill(65);
        for (let i = 0; i < count; i++) {
            const path = `/tmp/${crypto.randomUUID()}.bin`;
            const handle = await vfs.open(path, { write: true, create: true }, caller);
            await handle.write(data);
            await handle.close();
        }
    }

    async function collectReaddir(path: string): Promise<number> {
        let count = 0;
        for await (const _entry of vfs.readdir(path, caller)) {
            count++;
        }
        return count;
    }

    it('should list directory with 10 files', async () => {
        await createFiles(10);

        const start = performance.now();
        const count = await collectReaddir('/tmp');
        const elapsed = performance.now() - start;

        console.log(`List 10 files: ${elapsed.toFixed(2)}ms`);
        expect(count).toBe(10);
        expect(elapsed).toBeLessThan(50);
    });

    it('should list directory with 100 files', async () => {
        await createFiles(100);

        const start = performance.now();
        const count = await collectReaddir('/tmp');
        const elapsed = performance.now() - start;

        console.log(`List 100 files: ${elapsed.toFixed(2)}ms`);
        expect(count).toBe(100);
        expect(elapsed).toBeLessThan(200);
    });

    it('should list directory with 1000 files', async () => {
        await createFiles(1000);

        const start = performance.now();
        const count = await collectReaddir('/tmp');
        const elapsed = performance.now() - start;

        console.log(`List 1000 files: ${elapsed.toFixed(2)}ms`);
        expect(count).toBe(1000);
        expect(elapsed).toBeLessThan(2000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('should list directory with 5000 files', async () => {
        await createFiles(5000);

        const start = performance.now();
        const count = await collectReaddir('/tmp');
        const elapsed = performance.now() - start;

        console.log(`List 5000 files: ${elapsed.toFixed(2)}ms`);
        expect(count).toBe(5000);
        expect(elapsed).toBeLessThan(10000);
    }, { timeout: TIMEOUT_LONG });

    it('should list directory 100 times (10 files)', async () => {
        await createFiles(10);

        const start = performance.now();
        for (let i = 0; i < 100; i++) {
            await collectReaddir('/tmp');
        }
        const elapsed = performance.now() - start;

        console.log(`List 10 files x 100 times: ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(2)}ms/list)`);
        expect(elapsed).toBeLessThan(2000);
    });
});

describe('VFS Storage: Delete Performance', () => {
    let hal: HAL;
    let vfs: VFS;
    const caller = 'perf-test';

    beforeEach(async () => {
        hal = createTestHAL();
        vfs = new VFS(hal);
        await vfs.init();

        await vfs.mkdir('/tmp', 'kernel');
        await vfs.setAccess('/tmp', 'kernel', {
            grants: [
                { to: 'kernel', ops: ['*'] },
                { to: '*', ops: ['read', 'write', 'create', 'delete', 'list', 'stat'] },
            ],
            deny: [],
        });
    });

    afterEach(async () => {
        await hal.shutdown();
    });

    async function createFiles(count: number): Promise<string[]> {
        const data = new Uint8Array(1024).fill(65);
        const files: string[] = [];
        for (let i = 0; i < count; i++) {
            const path = `/tmp/${crypto.randomUUID()}.bin`;
            files.push(path);
            const handle = await vfs.open(path, { write: true, create: true }, caller);
            await handle.write(data);
            await handle.close();
        }
        return files;
    }

    it('should delete 10 files', async () => {
        const files = await createFiles(10);

        const start = performance.now();
        for (const path of files) {
            await vfs.unlink(path, caller);
        }
        const elapsed = performance.now() - start;

        console.log(`Delete 10 files: ${elapsed.toFixed(2)}ms (${(elapsed / 10).toFixed(2)}ms/file)`);
        expect(elapsed).toBeLessThan(100);
    });

    it('should delete 100 files', async () => {
        const files = await createFiles(100);

        const start = performance.now();
        for (const path of files) {
            await vfs.unlink(path, caller);
        }
        const elapsed = performance.now() - start;

        console.log(`Delete 100 files: ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(2)}ms/file)`);
        expect(elapsed).toBeLessThan(2000);
    });

    it('should delete 1000 files', async () => {
        const files = await createFiles(1000);

        const start = performance.now();
        for (const path of files) {
            await vfs.unlink(path, caller);
        }
        const elapsed = performance.now() - start;

        console.log(`Delete 1000 files: ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(2)}ms/file)`);
        expect(elapsed).toBeLessThan(15000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('should delete 1MB file', async () => {
        const path = `/tmp/${crypto.randomUUID()}.bin`;
        const data = new Uint8Array(1024 * 1024).fill(65);
        const handle = await vfs.open(path, { write: true, create: true }, caller);
        await handle.write(data);
        await handle.close();

        const start = performance.now();
        await vfs.unlink(path, caller);
        const elapsed = performance.now() - start;

        console.log(`Delete 1MB file: ${elapsed.toFixed(2)}ms`);
        expect(elapsed).toBeLessThan(50);
    });

    it('should delete 10MB file', async () => {
        const path = `/tmp/${crypto.randomUUID()}.bin`;
        const data = new Uint8Array(10 * 1024 * 1024).fill(65);
        const handle = await vfs.open(path, { write: true, create: true }, caller);
        await handle.write(data);
        await handle.close();

        const start = performance.now();
        await vfs.unlink(path, caller);
        const elapsed = performance.now() - start;

        console.log(`Delete 10MB file: ${elapsed.toFixed(2)}ms`);
        expect(elapsed).toBeLessThan(100);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('VFS Storage: Mixed Workload', () => {
    let hal: HAL;
    let vfs: VFS;
    const caller = 'perf-test';

    beforeEach(async () => {
        hal = createTestHAL();
        vfs = new VFS(hal);
        await vfs.init();

        await vfs.mkdir('/tmp', 'kernel');
        await vfs.setAccess('/tmp', 'kernel', {
            grants: [
                { to: 'kernel', ops: ['*'] },
                { to: '*', ops: ['read', 'write', 'create', 'delete', 'list', 'stat'] },
            ],
            deny: [],
        });
    });

    afterEach(async () => {
        await hal.shutdown();
    });

    it('should handle create-read-delete cycle (100 files)', async () => {
        const data = new Uint8Array(1024).fill(65);

        const start = performance.now();
        for (let i = 0; i < 100; i++) {
            const path = `/tmp/${crypto.randomUUID()}.bin`;

            // Create
            const writeHandle = await vfs.open(path, { write: true, create: true }, caller);
            await writeHandle.write(data);
            await writeHandle.close();

            // Read
            const readHandle = await vfs.open(path, { read: true }, caller);
            await readHandle.read();
            await readHandle.close();

            // Delete
            await vfs.unlink(path, caller);
        }
        const elapsed = performance.now() - start;

        console.log(`Create-Read-Delete x 100: ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(2)}ms/cycle)`);
        expect(elapsed).toBeLessThan(10000);
    });

    it('should handle concurrent-style workload (write while reading)', async () => {
        // Create initial files
        const files: string[] = [];
        const data = new Uint8Array(10 * 1024).fill(65); // 10KB

        for (let i = 0; i < 50; i++) {
            const path = `/tmp/${crypto.randomUUID()}.bin`;
            files.push(path);
            const handle = await vfs.open(path, { write: true, create: true }, caller);
            await handle.write(data);
            await handle.close();
        }

        const start = performance.now();

        // Interleave reads and writes
        for (let i = 0; i < 100; i++) {
            // Read existing file
            const readPath = files[i % files.length]!;
            const readHandle = await vfs.open(readPath, { read: true }, caller);
            await readHandle.read();
            await readHandle.close();

            // Write new file
            const writePath = `/tmp/${crypto.randomUUID()}.bin`;
            const writeHandle = await vfs.open(writePath, { write: true, create: true }, caller);
            await writeHandle.write(data);
            await writeHandle.close();
        }

        const elapsed = performance.now() - start;

        console.log(`Interleaved read/write x 100: ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(2)}ms/op)`);
        expect(elapsed).toBeLessThan(15000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('should handle stat operations (1000 files)', async () => {
        const files: string[] = [];
        const data = new Uint8Array(100).fill(65);

        for (let i = 0; i < 1000; i++) {
            const path = `/tmp/${crypto.randomUUID()}.bin`;
            files.push(path);
            const handle = await vfs.open(path, { write: true, create: true }, caller);
            await handle.write(data);
            await handle.close();
        }

        const start = performance.now();
        for (const path of files) {
            await vfs.stat(path, caller);
        }
        const elapsed = performance.now() - start;

        console.log(`Stat 1000 files: ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(2)}ms/stat)`);
        expect(elapsed).toBeLessThan(5000);
    }, { timeout: TIMEOUT_MEDIUM });
});
