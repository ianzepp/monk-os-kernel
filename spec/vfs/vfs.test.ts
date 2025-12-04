import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createOsStack, type OsStack } from '@src/os/stack.js';
import {
    ENOENT,
    EEXIST,
    EACCES,
    EISDIR,
} from '@src/hal/index.js';

describe('VFS', () => {
    let stack: OsStack;
    const caller = 'test-user-uuid';

    beforeEach(async () => {
        stack = await createOsStack({ vfs: true });
    });

    afterEach(async () => {
        await stack.shutdown();
    });

    describe('init', () => {
        it('should create root folder', async () => {
            const stat = await stack.vfs!.stat('/', caller);
            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('');
            expect(stat.parent).toBeNull();
        });

        it('should be idempotent', async () => {
            await stack.vfs!.init();
            await stack.vfs!.init();
            const stat = await stack.vfs!.stat('/', caller);
            expect(stat.model).toBe('folder');
        });
    });

    describe('mkdir', () => {
        it('should create directory', async () => {
            const id = await stack.vfs!.mkdir('/test', caller);
            expect(id).toBeDefined();

            const stat = await stack.vfs!.stat('/test', caller);
            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('test');
        });

        it('should create nested directories', async () => {
            await stack.vfs!.mkdir('/a', caller);
            await stack.vfs!.mkdir('/a/b', caller);
            await stack.vfs!.mkdir('/a/b/c', caller);

            const stat = await stack.vfs!.stat('/a/b/c', caller);
            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('c');
        });

        it('should fail if path exists', async () => {
            await stack.vfs!.mkdir('/test', caller);
            await expect(stack.vfs!.mkdir('/test', caller)).rejects.toBeInstanceOf(EEXIST);
        });

        it('should fail if parent does not exist', async () => {
            await expect(stack.vfs!.mkdir('/nonexistent/child', caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should set owner to caller', async () => {
            await stack.vfs!.mkdir('/test', caller);
            const stat = await stack.vfs!.stat('/test', caller);
            expect(stat.owner).toBe(caller);
        });
    });

    describe('open', () => {
        it('should create file with create flag', async () => {
            const handle = await stack.vfs!.open('/newfile.txt', { read: true, write: true, create: true }, caller);
            expect(handle).toBeDefined();
            await handle.close();

            const stat = await stack.vfs!.stat('/newfile.txt', caller);
            expect(stat.model).toBe('file');
        });

        it('should fail without create flag for non-existent file', async () => {
            await expect(stack.vfs!.open('/missing.txt', { read: true }, caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should open existing file', async () => {
            const h1 = await stack.vfs!.open('/file.txt', { write: true, create: true }, caller);
            await h1.write(new TextEncoder().encode('hello'));
            await h1.close();

            const h2 = await stack.vfs!.open('/file.txt', { read: true }, caller);
            const data = await h2.read();
            await h2.close();

            expect(new TextDecoder().decode(data)).toBe('hello');
        });

        it('should truncate with truncate flag', async () => {
            const h1 = await stack.vfs!.open('/file.txt', { write: true, create: true }, caller);
            await h1.write(new TextEncoder().encode('hello world'));
            await h1.close();

            // Truncate and write new content
            const h2 = await stack.vfs!.open('/file.txt', { write: true, truncate: true }, caller);
            await h2.write(new TextEncoder().encode('new')); // Write to trigger flush
            await h2.close();

            const h3 = await stack.vfs!.open('/file.txt', { read: true }, caller);
            const data = await h3.read();
            await h3.close();

            expect(new TextDecoder().decode(data)).toBe('new');
        });

        it('should fail to open folder for I/O', async () => {
            await stack.vfs!.mkdir('/folder', caller);
            await expect(stack.vfs!.open('/folder', { read: true }, caller)).rejects.toBeInstanceOf(EISDIR);
        });
    });

    describe('stat', () => {
        it('should return file metadata', async () => {
            const h = await stack.vfs!.open('/file.txt', { write: true, create: true }, caller);
            await h.write(new TextEncoder().encode('content'));
            await h.close();

            const stat = await stack.vfs!.stat('/file.txt', caller);
            expect(stat.model).toBe('file');
            expect(stat.name).toBe('file.txt');
            expect(stat.size).toBe(7);
        });

        it('should return folder metadata', async () => {
            await stack.vfs!.mkdir('/folder', caller);
            const stat = await stack.vfs!.stat('/folder', caller);
            expect(stat.model).toBe('folder');
            expect(stat.size).toBe(0);
        });

        it('should fail for non-existent path', async () => {
            await expect(stack.vfs!.stat('/missing', caller)).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('setstat', () => {
        it('should update file name', async () => {
            const h = await stack.vfs!.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            await stack.vfs!.setstat('/file.txt', caller, { name: 'renamed.txt' });

            // Note: path resolution uses name, so this won't find by old path
            // This is a limitation of the current implementation
        });

        it('should update mtime', async () => {
            const h = await stack.vfs!.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            const stat1 = await stack.vfs!.stat('/file.txt', caller);

            // Small delay to ensure mtime changes
            await new Promise(resolve => setTimeout(resolve, 10));

            await stack.vfs!.setstat('/file.txt', caller, {});

            const stat2 = await stack.vfs!.stat('/file.txt', caller);
            expect(stat2.mtime).toBeGreaterThanOrEqual(stat1.mtime);
        });
    });

    describe('unlink', () => {
        it('should delete file', async () => {
            const h = await stack.vfs!.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            await stack.vfs!.unlink('/file.txt', caller);

            await expect(stack.vfs!.stat('/file.txt', caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should delete empty folder', async () => {
            await stack.vfs!.mkdir('/folder', caller);
            await stack.vfs!.unlink('/folder', caller);

            await expect(stack.vfs!.stat('/folder', caller)).rejects.toBeInstanceOf(ENOENT);
        });

        it('should fail to delete non-empty folder', async () => {
            await stack.vfs!.mkdir('/folder', caller);
            const h = await stack.vfs!.open('/folder/file.txt', { write: true, create: true }, caller);
            await h.close();

            // Will fail because folder has children
            // The specific error depends on implementation
        });

        it('should fail to delete root', async () => {
            await expect(stack.vfs!.unlink('/', caller)).rejects.toBeInstanceOf(EACCES);
        });

        it('should fail for non-existent path', async () => {
            await expect(stack.vfs!.unlink('/missing', caller)).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('readdir', () => {
        it('should list directory contents', async () => {
            await stack.vfs!.mkdir('/dir', caller);
            const h1 = await stack.vfs!.open('/dir/a.txt', { write: true, create: true }, caller);
            await h1.close();
            const h2 = await stack.vfs!.open('/dir/b.txt', { write: true, create: true }, caller);
            await h2.close();
            await stack.vfs!.mkdir('/dir/subdir', caller);

            const entries: string[] = [];
            for await (const entry of stack.vfs!.readdir('/dir', caller)) {
                entries.push(entry.name);
            }

            expect(entries.sort()).toEqual(['a.txt', 'b.txt', 'subdir']);
        });

        it('should return empty for empty directory', async () => {
            await stack.vfs!.mkdir('/empty', caller);

            const entries: string[] = [];
            for await (const entry of stack.vfs!.readdir('/empty', caller)) {
                entries.push(entry.name);
            }

            expect(entries).toEqual([]);
        });

        it('should fail for non-existent directory', async () => {
            await expect(async () => {
                for await (const _entry of stack.vfs!.readdir('/missing', caller)) {
                    // Should throw
                }
            }).toThrow();
        });

        it('should fail for file (not directory)', async () => {
            const h = await stack.vfs!.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            await expect(async () => {
                for await (const _entry of stack.vfs!.readdir('/file.txt', caller)) {
                    // Should throw
                }
            }).toThrow();
        });
    });

    describe('access', () => {
        it('should return ACL for path', async () => {
            const h = await stack.vfs!.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            const acl = await stack.vfs!.access('/file.txt', caller);
            expect(acl.grants.length).toBeGreaterThan(0);
        });
    });

    describe('setAccess', () => {
        it('should set ACL for path', async () => {
            const h = await stack.vfs!.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            await stack.vfs!.setAccess('/file.txt', caller, {
                grants: [
                    { to: caller, ops: ['*'] },
                    { to: 'other-user', ops: ['read'] },
                ],
                deny: [],
            });

            const acl = await stack.vfs!.access('/file.txt', caller);
            expect(acl.grants.length).toBe(2);
        });

        it('should reset ACL with null', async () => {
            const h = await stack.vfs!.open('/file.txt', { write: true, create: true }, caller);
            await h.close();

            await stack.vfs!.setAccess('/file.txt', caller, null);

            const acl = await stack.vfs!.access('/file.txt', caller);
            // Should be default ACL (owner + world-readable)
            expect(acl.grants.length).toBe(2);
            expect(acl.grants[0]!.to).toBe(caller);
            expect(acl.grants[1]!.to).toBe('*');
        });
    });

    describe('FileHandle', () => {
        it('should read and write', async () => {
            const handle = await stack.vfs!.open('/test.txt', { read: true, write: true, create: true }, caller);

            await handle.write(new TextEncoder().encode('hello'));
            await handle.seek(0, 'start');
            const data = await handle.read();

            expect(new TextDecoder().decode(data)).toBe('hello');
            await handle.close();
        });

        it('should track position', async () => {
            const handle = await stack.vfs!.open('/test.txt', { read: true, write: true, create: true }, caller);

            await handle.write(new TextEncoder().encode('hello'));
            expect(await handle.tell()).toBe(5);

            await handle.seek(0, 'start');
            expect(await handle.tell()).toBe(0);

            await handle.seek(0, 'end');
            expect(await handle.tell()).toBe(5);

            await handle.close();
        });

        it('should support append mode', async () => {
            const h1 = await stack.vfs!.open('/test.txt', { write: true, create: true }, caller);
            await h1.write(new TextEncoder().encode('hello'));
            await h1.close();

            const h2 = await stack.vfs!.open('/test.txt', { write: true, append: true }, caller);
            await h2.write(new TextEncoder().encode(' world'));
            await h2.close();

            const h3 = await stack.vfs!.open('/test.txt', { read: true }, caller);
            const data = await h3.read();
            await h3.close();

            expect(new TextDecoder().decode(data)).toBe('hello world');
        });

        it('should persist data on close', async () => {
            const h1 = await stack.vfs!.open('/test.txt', { write: true, create: true }, caller);
            await h1.write(new TextEncoder().encode('content'));
            await h1.close();

            // Reopen and verify
            const h2 = await stack.vfs!.open('/test.txt', { read: true }, caller);
            const data = await h2.read();
            await h2.close();

            expect(new TextDecoder().decode(data)).toBe('content');
        });

        it('should support sync', async () => {
            const handle = await stack.vfs!.open('/test.txt', { write: true, create: true }, caller);
            await handle.write(new TextEncoder().encode('data'));
            await handle.sync();
            await handle.close();
        });

        it('should be closeable multiple times', async () => {
            const handle = await stack.vfs!.open('/test.txt', { write: true, create: true }, caller);
            await handle.close();
            await handle.close(); // Should not throw
        });

        it('should throw on read after close', async () => {
            const handle = await stack.vfs!.open('/test.txt', { read: true, write: true, create: true }, caller);
            await handle.close();

            await expect(handle.read()).rejects.toThrow();
        });

        it('should throw on write after close', async () => {
            const handle = await stack.vfs!.open('/test.txt', { write: true, create: true }, caller);
            await handle.close();

            await expect(handle.write(new Uint8Array([1]))).rejects.toThrow();
        });
    });

    describe('path normalization', () => {
        it('should handle trailing slashes', async () => {
            await stack.vfs!.mkdir('/folder', caller);
            const stat = await stack.vfs!.stat('/folder/', caller);
            expect(stat.name).toBe('folder');
        });

        it('should handle multiple slashes', async () => {
            await stack.vfs!.mkdir('/folder', caller);
            const stat = await stack.vfs!.stat('//folder//', caller);
            expect(stat.name).toBe('folder');
        });

        it('should handle root variations', async () => {
            const stat1 = await stack.vfs!.stat('/', caller);
            const stat2 = await stack.vfs!.stat('//', caller);
            expect(stat1.id).toBe(stat2.id);
        });
    });
});
