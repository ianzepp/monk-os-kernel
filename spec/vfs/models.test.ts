/**
 * FileModel and FolderModel tests using TestOS
 *
 * These models are EMS-backed and require EntityCache + EntityOps.
 * Tests use TestOS with layers: ['vfs'] to get proper dependencies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestOS } from '@src/os/test.js';
import { ENOENT, EISDIR } from '@src/hal/index.js';

describe('FileModel', () => {
    let os: TestOS;

    beforeEach(async () => {
        os = new TestOS();
        await os.boot({ layers: ['vfs'] });
    });

    afterEach(async () => {
        await os.shutdown();
    });

    describe('via VFS', () => {
        it('should create file with open({ create: true })', async () => {
            const handle = await os.internalVfs.open('/test.txt', { read: true, write: true, create: true }, 'kernel');

            expect(handle).toBeDefined();
            expect(handle.closed).toBe(false);
            await handle.close();
        });

        it('should stat created file', async () => {
            await os.internalVfs.open('/test.txt', { write: true, create: true }, 'kernel');
            const stat = await os.internalVfs.stat('/test.txt', 'kernel');

            expect(stat.model).toBe('file');
            expect(stat.name).toBe('test.txt');
            expect(stat.size).toBe(0);
        });

        it('should write and read file content', async () => {
            const handle = await os.internalVfs.open('/test.txt', { read: true, write: true, create: true }, 'kernel');

            const content = new TextEncoder().encode('Hello, World!');

            await handle.write(content);
            await handle.close();

            // Re-open and read
            const handle2 = await os.internalVfs.open('/test.txt', { read: true }, 'kernel');
            const data = await handle2.read();

            await handle2.close();

            expect(data.length).toBe(13);
            expect(new TextDecoder().decode(data)).toBe('Hello, World!');
        });

        it('should update file size after write', async () => {
            const handle = await os.internalVfs.open('/test.txt', { read: true, write: true, create: true }, 'kernel');

            await handle.write(new TextEncoder().encode('Hello'));
            await handle.close();

            const stat = await os.internalVfs.stat('/test.txt', 'kernel');

            expect(stat.size).toBe(5);
        });

        it('should throw ENOENT for non-existent file', async () => {
            await expect(os.internalVfs.stat('/non-existent.txt', 'kernel')).rejects.toBeInstanceOf(ENOENT);
        });

        it('should delete file with unlink', async () => {
            await os.internalVfs.open('/test.txt', { write: true, create: true }, 'kernel');
            await os.internalVfs.unlink('/test.txt', 'kernel');

            await expect(os.internalVfs.stat('/test.txt', 'kernel')).rejects.toBeInstanceOf(ENOENT);
        });
    });
});

describe('FolderModel', () => {
    let os: TestOS;

    beforeEach(async () => {
        os = new TestOS();
        await os.boot({ layers: ['vfs'] });
    });

    afterEach(async () => {
        await os.shutdown();
    });

    describe('via VFS', () => {
        it('should create folder with mkdir', async () => {
            const id = await os.internalVfs.mkdir('/testdir', 'kernel');

            expect(id).toBeDefined();
            expect(id.length).toBeGreaterThan(0); // UUID format varies
        });

        it('should stat created folder', async () => {
            await os.internalVfs.mkdir('/testdir', 'kernel');
            const stat = await os.internalVfs.stat('/testdir', 'kernel');

            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('testdir');
            expect(stat.size).toBe(0);
        });

        it('should throw EISDIR when opening folder', async () => {
            await os.internalVfs.mkdir('/testdir', 'kernel');
            await expect(
                os.internalVfs.open('/testdir', { read: true }, 'kernel'),
            ).rejects.toBeInstanceOf(EISDIR);
        });

        it('should list folder children', async () => {
            await os.internalVfs.mkdir('/testdir', 'kernel');
            await os.internalVfs.open('/testdir/file1.txt', { write: true, create: true }, 'kernel');
            await os.internalVfs.open('/testdir/file2.txt', { write: true, create: true }, 'kernel');

            const children: string[] = [];

            for await (const child of os.internalVfs.readdir('/testdir', 'kernel')) {
                children.push(child.name);
            }

            expect(children).toContain('file1.txt');
            expect(children).toContain('file2.txt');
            expect(children.length).toBe(2);
        });

        it('should return empty for empty folder', async () => {
            await os.internalVfs.mkdir('/emptydir', 'kernel');

            const children: string[] = [];

            for await (const child of os.internalVfs.readdir('/emptydir', 'kernel')) {
                children.push(child.name);
            }

            expect(children).toEqual([]);
        });

        it('should create nested folders with recursive', async () => {
            await os.internalVfs.mkdir('/a/b/c', 'kernel', { recursive: true });

            const statA = await os.internalVfs.stat('/a', 'kernel');
            const statB = await os.internalVfs.stat('/a/b', 'kernel');
            const statC = await os.internalVfs.stat('/a/b/c', 'kernel');

            expect(statA.model).toBe('folder');
            expect(statB.model).toBe('folder');
            expect(statC.model).toBe('folder');
        });

        it('should delete empty folder', async () => {
            await os.internalVfs.mkdir('/testdir', 'kernel');
            await os.internalVfs.unlink('/testdir', 'kernel');

            await expect(os.internalVfs.stat('/testdir', 'kernel')).rejects.toBeInstanceOf(ENOENT);
        });

        it('should throw ENOENT for non-existent folder', async () => {
            await expect(os.internalVfs.stat('/non-existent', 'kernel')).rejects.toBeInstanceOf(ENOENT);
        });
    });
});
