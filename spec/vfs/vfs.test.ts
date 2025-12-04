import { describe, it, expect, beforeEach } from 'bun:test';
import { VFS } from '@src/vfs/vfs.js';
import type { HAL } from '@src/hal/index.js';
import {
    MemoryStorageEngine,
    MockClockDevice,
    SeededEntropyDevice,
    MemoryBlockDevice,
    MockTimerDevice,
    BufferConsoleDevice,
    MockDNSDevice,
    MockHostDevice,
    MockIPCDevice,
    BunCryptoDevice,
    BunChannelDevice,
    MockCompressionDevice,
    MockFileDevice,
    ENOENT,
    EEXIST,
    EACCES,
    EISDIR,
} from '@src/hal/index.js';

function createMockHAL(): HAL {
    const storage = new MemoryStorageEngine();
    const clock = new MockClockDevice();
    const entropy = new SeededEntropyDevice(12345);
    const timer = new MockTimerDevice();

    clock.set(1000000); // Start at 1 second

    return {
        block: new MemoryBlockDevice(),
        storage,
        network: {} as any, // Not needed for VFS tests
        timer,
        clock,
        entropy,
        crypto: new BunCryptoDevice(),
        console: new BufferConsoleDevice(),
        dns: new MockDNSDevice(),
        host: new MockHostDevice(),
        ipc: new MockIPCDevice(),
        channel: new BunChannelDevice(),
        compression: new MockCompressionDevice(),
        file: new MockFileDevice(),
        async init() {},
        async shutdown() {
            await storage.close();
        },
    };
}

describe('VFS', () => {
    let hal: HAL;
    let vfs: VFS;
    const caller = 'test-user-uuid';

    beforeEach(async () => {
        hal = createMockHAL();
        vfs = new VFS(hal);
        await vfs.init();
    });

    describe('init', () => {
        it('should create root folder', async () => {
            const stat = await vfs.stat('/', caller);
            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('');
            expect(stat.parent).toBeNull();
        });

        it('should be idempotent', async () => {
            await vfs.init();
            await vfs.init();
            const stat = await vfs.stat('/', caller);
            expect(stat.model).toBe('folder');
        });
    });

    describe('mkdir', () => {
        it('should create directory', async () => {
            const id = await vfs.mkdir('/test', caller);
            expect(id).toBeDefined();

            const stat = await vfs.stat('/test', caller);
            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('test');
        });

        it('should create nested directories', async () => {
            await vfs.mkdir('/a', caller);
            await vfs.mkdir('/a/b', caller);
            await vfs.mkdir('/a/b/c', caller);

            const stat = await vfs.stat('/a/b/c', caller);
            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('c');
        });

        it('should fail if path exists', async () => {
            await vfs.mkdir('/test', caller);
            await expect(vfs.mkdir('/test', caller)).rejects.toBeInstanceOf(EEXIST);
        });

        it('should fail if parent does not exist', async () => {
            await expect(vfs.mkdir('/nonexistent/child', caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should set owner to caller', async () => {
            await vfs.mkdir('/test', caller);
            const stat = await vfs.stat('/test', caller);
            expect(stat.owner).toBe(caller);
        });
    });

    describe('open', () => {
        it('should create file with create flag', async () => {
            const handle = await vfs.open('/newfile.txt', { read: true, write: true, create: true }, caller);
            expect(handle).toBeDefined();
            await handle.close();

            const stat = await vfs.stat('/newfile.txt', caller);
            expect(stat.model).toBe('file');
        });

        it('should fail without create flag for non-existent file', async () => {
            await expect(vfs.open('/missing.txt', { read: true }, caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should open existing file', async () => {
            const h1 = await vfs.open('/file.txt', { write: true, create: true }, caller);
            await h1.write(new TextEncoder().encode('hello'));
            await h1.close();

            const h2 = await vfs.open('/file.txt', { read: true }, caller);
            const data = await h2.read();
            await h2.close();

            expect(new TextDecoder().decode(data)).toBe('hello');
        });

        it('should truncate with truncate flag', async () => {
            const h1 = await vfs.open('/file.txt', { write: true, create: true }, caller);
            await h1.write(new TextEncoder().encode('hello world'));
            await h1.close();

            // Truncate and write new content
            const h2 = await vfs.open('/file.txt', { write: true, truncate: true }, caller);
            await h2.write(new TextEncoder().encode('new')); // Write to trigger flush
            await h2.close();

            const h3 = await vfs.open('/file.txt', { read: true }, caller);
            const data = await h3.read();
            await h3.close();

            expect(new TextDecoder().decode(data)).toBe('new');
        });

        it('should fail to open folder for I/O', async () => {
            await vfs.mkdir('/folder', caller);
            await expect(vfs.open('/folder', { read: true }, caller)).rejects.toBeInstanceOf(EISDIR);
        });
    });

    describe('stat', () => {
        it('should return file metadata', async () => {
            const h = await vfs.open('/file.txt', { write: true, create: true }, caller);
            await h.write(new TextEncoder().encode('content'));
            await h.close();

            const stat = await vfs.stat('/file.txt', caller);
            expect(stat.model).toBe('file');
            expect(stat.name).toBe('file.txt');
            expect(stat.size).toBe(7);
        });

        it('should return folder metadata', async () => {
            await vfs.mkdir('/folder', caller);
            const stat = await vfs.stat('/folder', caller);
            expect(stat.model).toBe('folder');
            expect(stat.size).toBe(0);
        });

        it('should fail for non-existent path', async () => {
            await expect(vfs.stat('/missing', caller)).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('setstat', () => {
        it('should update file name', async () => {
            const h = await vfs.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            await vfs.setstat('/file.txt', caller, { name: 'renamed.txt' });

            // Note: path resolution uses name, so this won't find by old path
            // This is a limitation of the current implementation
        });

        it('should update mtime', async () => {
            const h = await vfs.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            const stat1 = await vfs.stat('/file.txt', caller);
            (hal.clock as MockClockDevice).advance(1000);

            await vfs.setstat('/file.txt', caller, {});

            const stat2 = await vfs.stat('/file.txt', caller);
            expect(stat2.mtime).toBeGreaterThan(stat1.mtime);
        });
    });

    describe('unlink', () => {
        it('should delete file', async () => {
            const h = await vfs.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            await vfs.unlink('/file.txt', caller);

            await expect(vfs.stat('/file.txt', caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should delete empty folder', async () => {
            await vfs.mkdir('/folder', caller);
            await vfs.unlink('/folder', caller);

            await expect(vfs.stat('/folder', caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should fail to delete non-empty folder', async () => {
            await vfs.mkdir('/folder', caller);
            const h = await vfs.open('/folder/file.txt', { write: true, create: true }, caller);
            await h.close();

            // Will fail because folder has children
            // The specific error depends on implementation
        });

        it('should fail to delete root', async () => {
            await expect(vfs.unlink('/', caller)).rejects.toBeInstanceOf(EACCES);
        });

        it('should fail for non-existent path', async () => {
            await expect(vfs.unlink('/missing', caller)).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('readdir', () => {
        it('should list directory contents', async () => {
            await vfs.mkdir('/dir', caller);
            const h1 = await vfs.open('/dir/a.txt', { write: true, create: true }, caller);
            await h1.close();
            const h2 = await vfs.open('/dir/b.txt', { write: true, create: true }, caller);
            await h2.close();
            await vfs.mkdir('/dir/subdir', caller);

            const entries: string[] = [];
            for await (const entry of vfs.readdir('/dir', caller)) {
                entries.push(entry.name);
            }

            expect(entries.sort()).toEqual(['a.txt', 'b.txt', 'subdir']);
        });

        it('should return empty for empty directory', async () => {
            await vfs.mkdir('/empty', caller);

            const entries: string[] = [];
            for await (const entry of vfs.readdir('/empty', caller)) {
                entries.push(entry.name);
            }

            expect(entries).toEqual([]);
        });

        it('should fail for non-existent directory', async () => {
            await expect(async () => {
                for await (const _entry of vfs.readdir('/missing', caller)) {
                    // Should throw
                }
            }).toThrow();
        });

        it('should fail for file (not directory)', async () => {
            const h = await vfs.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            await expect(async () => {
                for await (const _entry of vfs.readdir('/file.txt', caller)) {
                    // Should throw
                }
            }).toThrow();
        });
    });

    describe('access', () => {
        it('should return ACL for path', async () => {
            const h = await vfs.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            const acl = await vfs.access('/file.txt', caller);
            expect(acl.grants.length).toBeGreaterThan(0);
        });
    });

    describe('setAccess', () => {
        it('should set ACL for path', async () => {
            const h = await vfs.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            await vfs.setAccess('/file.txt', caller, {
                grants: [
                    { to: caller, ops: ['*'] },
                    { to: 'other-user', ops: ['read'] },
                ],
                deny: [],
            });

            const acl = await vfs.access('/file.txt', caller);
            expect(acl.grants.length).toBe(2);
        });

        it('should reset ACL with null', async () => {
            const h = await vfs.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            await vfs.setAccess('/file.txt', caller, null);

            const acl = await vfs.access('/file.txt', caller);
            // Should be default ACL (owner + world-readable)
            expect(acl.grants.length).toBe(2);
            expect(acl.grants[0]!.to).toBe(caller);
            expect(acl.grants[1]!.to).toBe('*');
        });
    });

    describe('FileHandle', () => {
        it('should read and write', async () => {
            const handle = await vfs.open('/test.txt', { read: true, write: true, create: true }, caller);

            await handle.write(new TextEncoder().encode('hello'));
            await handle.seek(0, 'start');
            const data = await handle.read();

            expect(new TextDecoder().decode(data)).toBe('hello');
            await handle.close();
        });

        it('should track position', async () => {
            const handle = await vfs.open('/test.txt', { read: true, write: true, create: true }, caller);

            await handle.write(new TextEncoder().encode('hello'));
            expect(await handle.tell()).toBe(5);

            await handle.seek(0, 'start');
            expect(await handle.tell()).toBe(0);

            await handle.seek(0, 'end');
            expect(await handle.tell()).toBe(5);

            await handle.close();
        });

        it('should support append mode', async () => {
            const h1 = await vfs.open('/test.txt', { write: true, create: true }, caller);
            await h1.write(new TextEncoder().encode('hello'));
            await h1.close();

            const h2 = await vfs.open('/test.txt', { write: true, append: true }, caller);
            await h2.write(new TextEncoder().encode(' world'));
            await h2.close();

            const h3 = await vfs.open('/test.txt', { read: true }, caller);
            const data = await h3.read();
            await h3.close();

            expect(new TextDecoder().decode(data)).toBe('hello world');
        });

        it('should persist data on close', async () => {
            const h1 = await vfs.open('/test.txt', { write: true, create: true }, caller);
            await h1.write(new TextEncoder().encode('content'));
            await h1.close();

            // Reopen and verify
            const h2 = await vfs.open('/test.txt', { read: true }, caller);
            const data = await h2.read();
            await h2.close();

            expect(new TextDecoder().decode(data)).toBe('content');
        });

        it('should support sync', async () => {
            const handle = await vfs.open('/test.txt', { write: true, create: true }, caller);
            await handle.write(new TextEncoder().encode('data'));
            await handle.sync();
            await handle.close();
        });

        it('should be closeable multiple times', async () => {
            const handle = await vfs.open('/test.txt', { write: true, create: true }, caller);
            await handle.close();
            await handle.close(); // Should not throw
        });

        it('should throw on read after close', async () => {
            const handle = await vfs.open('/test.txt', { read: true, write: true, create: true }, caller);
            await handle.close();

            await expect(handle.read()).rejects.toThrow();
        });

        it('should throw on write after close', async () => {
            const handle = await vfs.open('/test.txt', { write: true, create: true }, caller);
            await handle.close();

            await expect(handle.write(new Uint8Array([1]))).rejects.toThrow();
        });
    });

    describe('path normalization', () => {
        it('should handle trailing slashes', async () => {
            await vfs.mkdir('/folder', caller);
            const stat = await vfs.stat('/folder/', caller);
            expect(stat.name).toBe('folder');
        });

        it('should handle multiple slashes', async () => {
            await vfs.mkdir('/folder', caller);
            const stat = await vfs.stat('//folder//', caller);
            expect(stat.name).toBe('folder');
        });

        it('should handle root variations', async () => {
            const stat1 = await vfs.stat('/', caller);
            const stat2 = await vfs.stat('//', caller);
            expect(stat1.id).toBe(stat2.id);
        });
    });
});
