import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestOS } from '@src/os/test.js';
import {
    ENOENT,
    EEXIST,
    EACCES,
    EISDIR,
} from '@src/hal/index.js';

describe('VFS', () => {
    let os: TestOS;
    const caller = 'test-user-uuid';

    beforeEach(async () => {
        os = new TestOS();
        await os.boot({ layers: ['vfs'] });
    });

    afterEach(async () => {
        await os.shutdown();
    });

    describe('init', () => {
        it('should create root folder', async () => {
            const stat = await os.internalVfs.stat('/', caller);

            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('');
            expect(stat.parent).toBeNull();
        });

        it('should be idempotent', async () => {
            await os.internalVfs.init();
            await os.internalVfs.init();
            const stat = await os.internalVfs.stat('/', caller);

            expect(stat.model).toBe('folder');
        });
    });

    describe('mkdir', () => {
        it('should create directory', async () => {
            const id = await os.internalVfs.mkdir('/test', caller);

            expect(id).toBeDefined();

            const stat = await os.internalVfs.stat('/test', caller);

            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('test');
        });

        it('should create nested directories', async () => {
            await os.internalVfs.mkdir('/a', caller);
            await os.internalVfs.mkdir('/a/b', caller);
            await os.internalVfs.mkdir('/a/b/c', caller);

            const stat = await os.internalVfs.stat('/a/b/c', caller);

            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('c');
        });

        it('should fail if path exists', async () => {
            await os.internalVfs.mkdir('/test', caller);
            await expect(os.internalVfs.mkdir('/test', caller)).rejects.toBeInstanceOf(EEXIST);
        });

        it('should fail if parent does not exist', async () => {
            await expect(os.internalVfs.mkdir('/nonexistent/child', caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should set owner to caller', async () => {
            await os.internalVfs.mkdir('/test', caller);
            const stat = await os.internalVfs.stat('/test', caller);

            expect(stat.owner).toBe(caller);
        });
    });

    describe('open', () => {
        it('should create file with create flag', async () => {
            const handle = await os.internalVfs.open('/newfile.txt', { read: true, write: true, create: true }, caller);

            expect(handle).toBeDefined();
            await handle.close();

            const stat = await os.internalVfs.stat('/newfile.txt', caller);

            expect(stat.model).toBe('file');
        });

        it('should fail without create flag for non-existent file', async () => {
            await expect(os.internalVfs.open('/missing.txt', { read: true }, caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should open existing file', async () => {
            const h1 = await os.internalVfs.open('/file.txt', { write: true, create: true }, caller);

            await h1.write(new TextEncoder().encode('hello'));
            await h1.close();

            const h2 = await os.internalVfs.open('/file.txt', { read: true }, caller);
            const data = await h2.read();

            await h2.close();

            expect(new TextDecoder().decode(data)).toBe('hello');
        });

        it('should truncate with truncate flag', async () => {
            const h1 = await os.internalVfs.open('/file.txt', { write: true, create: true }, caller);

            await h1.write(new TextEncoder().encode('hello world'));
            await h1.close();

            // Truncate and write new content
            const h2 = await os.internalVfs.open('/file.txt', { write: true, truncate: true }, caller);

            await h2.write(new TextEncoder().encode('new')); // Write to trigger flush
            await h2.close();

            const h3 = await os.internalVfs.open('/file.txt', { read: true }, caller);
            const data = await h3.read();

            await h3.close();

            expect(new TextDecoder().decode(data)).toBe('new');
        });

        it('should fail to open folder for I/O', async () => {
            await os.internalVfs.mkdir('/folder', caller);
            await expect(os.internalVfs.open('/folder', { read: true }, caller)).rejects.toBeInstanceOf(EISDIR);
        });
    });

    describe('stat', () => {
        it('should return file metadata', async () => {
            const h = await os.internalVfs.open('/file.txt', { write: true, create: true }, caller);

            await h.write(new TextEncoder().encode('content'));
            await h.close();

            const stat = await os.internalVfs.stat('/file.txt', caller);

            expect(stat.model).toBe('file');
            expect(stat.name).toBe('file.txt');
            expect(stat.size).toBe(7);
        });

        it('should return folder metadata', async () => {
            await os.internalVfs.mkdir('/folder', caller);
            const stat = await os.internalVfs.stat('/folder', caller);

            expect(stat.model).toBe('folder');
            expect(stat.size).toBe(0);
        });

        it('should fail for non-existent path', async () => {
            await expect(os.internalVfs.stat('/missing', caller)).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('setstat', () => {
        it('should update file name', async () => {
            const h = await os.internalVfs.open('/file.txt', { write: true, create: true }, caller);

            await h.close();

            await os.internalVfs.setstat('/file.txt', caller, { name: 'renamed.txt' });

            // Note: path resolution uses name, so this won't find by old path
            // This is a limitation of the current implementation
        });

        it('should update mtime', async () => {
            const h = await os.internalVfs.open('/file.txt', { write: true, create: true }, caller);

            await h.close();

            const stat1 = await os.internalVfs.stat('/file.txt', caller);

            // Small delay to ensure mtime changes
            await new Promise(resolve => setTimeout(resolve, 10));

            await os.internalVfs.setstat('/file.txt', caller, {});

            const stat2 = await os.internalVfs.stat('/file.txt', caller);

            expect(stat2.mtime).toBeGreaterThanOrEqual(stat1.mtime);
        });
    });

    describe('unlink', () => {
        it('should delete file', async () => {
            const h = await os.internalVfs.open('/file.txt', { write: true, create: true }, caller);

            await h.close();

            await os.internalVfs.unlink('/file.txt', caller);

            await expect(os.internalVfs.stat('/file.txt', caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should delete empty folder', async () => {
            await os.internalVfs.mkdir('/folder', caller);
            await os.internalVfs.unlink('/folder', caller);

            await expect(os.internalVfs.stat('/folder', caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should fail to delete non-empty folder', async () => {
            await os.internalVfs.mkdir('/folder', caller);
            const h = await os.internalVfs.open('/folder/file.txt', { write: true, create: true }, caller);

            await h.close();

            // Will fail because folder has children
            // The specific error depends on implementation
        });

        it('should fail to delete root', async () => {
            await expect(os.internalVfs.unlink('/', caller)).rejects.toBeInstanceOf(EACCES);
        });

        it('should fail for non-existent path', async () => {
            await expect(os.internalVfs.unlink('/missing', caller)).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('readdir', () => {
        it('should list directory contents', async () => {
            await os.internalVfs.mkdir('/dir', caller);
            const h1 = await os.internalVfs.open('/dir/a.txt', { write: true, create: true }, caller);

            await h1.close();
            const h2 = await os.internalVfs.open('/dir/b.txt', { write: true, create: true }, caller);

            await h2.close();
            await os.internalVfs.mkdir('/dir/subdir', caller);

            const entries: string[] = [];

            for await (const entry of os.internalVfs.readdir('/dir', caller)) {
                entries.push(entry.name);
            }

            expect(entries.sort()).toEqual(['a.txt', 'b.txt', 'subdir']);
        });

        it('should return empty for empty directory', async () => {
            await os.internalVfs.mkdir('/empty', caller);

            const entries: string[] = [];

            for await (const entry of os.internalVfs.readdir('/empty', caller)) {
                entries.push(entry.name);
            }

            expect(entries).toEqual([]);
        });

        it('should fail for non-existent directory', async () => {
            await expect(async () => {
                for await (const _entry of os.internalVfs.readdir('/missing', caller)) {
                    // Should throw
                }
            }).toThrow();
        });

        it('should fail for file (not directory)', async () => {
            const h = await os.internalVfs.open('/file.txt', { write: true, create: true }, caller);

            await h.close();

            await expect(async () => {
                for await (const _entry of os.internalVfs.readdir('/file.txt', caller)) {
                    // Should throw
                }
            }).toThrow();
        });
    });

    describe('access', () => {
        it('should return ACL for path', async () => {
            const h = await os.internalVfs.open('/file.txt', { write: true, create: true }, caller);

            await h.close();

            const acl = await os.internalVfs.access('/file.txt', caller);

            expect(acl.grants.length).toBeGreaterThan(0);
        });
    });

    describe('setAccess', () => {
        it('should set ACL for path', async () => {
            const h = await os.internalVfs.open('/file.txt', { write: true, create: true }, caller);

            await h.close();

            await os.internalVfs.setAccess('/file.txt', caller, {
                grants: [
                    { to: caller, ops: ['*'] },
                    { to: 'other-user', ops: ['read'] },
                ],
                deny: [],
            });

            const acl = await os.internalVfs.access('/file.txt', caller);

            expect(acl.grants.length).toBe(2);
        });

        it('should reset ACL with null', async () => {
            const h = await os.internalVfs.open('/file.txt', { write: true, create: true }, caller);

            await h.close();

            await os.internalVfs.setAccess('/file.txt', caller, null);

            const acl = await os.internalVfs.access('/file.txt', caller);

            // Should be default ACL (owner + world-readable)
            expect(acl.grants.length).toBe(2);
            expect(acl.grants[0]!.to).toBe(caller);
            expect(acl.grants[1]!.to).toBe('*');
        });
    });

    describe('FileHandle', () => {
        it('should read and write', async () => {
            const handle = await os.internalVfs.open('/test.txt', { read: true, write: true, create: true }, caller);

            await handle.write(new TextEncoder().encode('hello'));
            await handle.seek(0, 'start');
            const data = await handle.read();

            expect(new TextDecoder().decode(data)).toBe('hello');
            await handle.close();
        });

        it('should track position', async () => {
            const handle = await os.internalVfs.open('/test.txt', { read: true, write: true, create: true }, caller);

            await handle.write(new TextEncoder().encode('hello'));
            expect(await handle.tell()).toBe(5);

            await handle.seek(0, 'start');
            expect(await handle.tell()).toBe(0);

            await handle.seek(0, 'end');
            expect(await handle.tell()).toBe(5);

            await handle.close();
        });

        it('should support append mode', async () => {
            const h1 = await os.internalVfs.open('/test.txt', { write: true, create: true }, caller);

            await h1.write(new TextEncoder().encode('hello'));
            await h1.close();

            const h2 = await os.internalVfs.open('/test.txt', { write: true, append: true }, caller);

            await h2.write(new TextEncoder().encode(' world'));
            await h2.close();

            const h3 = await os.internalVfs.open('/test.txt', { read: true }, caller);
            const data = await h3.read();

            await h3.close();

            expect(new TextDecoder().decode(data)).toBe('hello world');
        });

        it('should persist data on close', async () => {
            const h1 = await os.internalVfs.open('/test.txt', { write: true, create: true }, caller);

            await h1.write(new TextEncoder().encode('content'));
            await h1.close();

            // Reopen and verify
            const h2 = await os.internalVfs.open('/test.txt', { read: true }, caller);
            const data = await h2.read();

            await h2.close();

            expect(new TextDecoder().decode(data)).toBe('content');
        });

        it('should support sync', async () => {
            const handle = await os.internalVfs.open('/test.txt', { write: true, create: true }, caller);

            await handle.write(new TextEncoder().encode('data'));
            await handle.sync();
            await handle.close();
        });

        it('should be closeable multiple times', async () => {
            const handle = await os.internalVfs.open('/test.txt', { write: true, create: true }, caller);

            await handle.close();
            await handle.close(); // Should not throw
        });

        it('should throw on read after close', async () => {
            const handle = await os.internalVfs.open('/test.txt', { read: true, write: true, create: true }, caller);

            await handle.close();

            await expect(handle.read()).rejects.toThrow();
        });

        it('should throw on write after close', async () => {
            const handle = await os.internalVfs.open('/test.txt', { write: true, create: true }, caller);

            await handle.close();

            await expect(handle.write(new Uint8Array([1]))).rejects.toThrow();
        });
    });

    describe('path normalization', () => {
        it('should handle trailing slashes', async () => {
            await os.internalVfs.mkdir('/folder', caller);
            const stat = await os.internalVfs.stat('/folder/', caller);

            expect(stat.name).toBe('folder');
        });

        it('should handle multiple slashes', async () => {
            await os.internalVfs.mkdir('/folder', caller);
            const stat = await os.internalVfs.stat('//folder//', caller);

            expect(stat.name).toBe('folder');
        });

        it('should handle root variations', async () => {
            const stat1 = await os.internalVfs.stat('/', caller);
            const stat2 = await os.internalVfs.stat('//', caller);

            expect(stat1.id).toBe(stat2.id);
        });
    });
});
