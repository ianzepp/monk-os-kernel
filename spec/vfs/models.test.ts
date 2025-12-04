/**
 * FileModel and FolderModel tests using createOsStack()
 *
 * These models are EMS-backed and require EntityCache + EntityOps.
 * Tests use createOsStack({ vfs: true }) to get proper dependencies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createOsStack, type OsStack } from '@src/os/stack.js';
import { ENOENT, EISDIR } from '@src/hal/index.js';

describe('FileModel', () => {
    let stack: OsStack;
    const ROOT_ID = '00000000-0000-0000-0000-000000000000';

    beforeEach(async () => {
        stack = await createOsStack({ vfs: true });
    });

    afterEach(async () => {
        await stack.shutdown();
    });

    describe('via VFS', () => {
        it('should create file with open({ create: true })', async () => {
            const handle = await stack.vfs!.open('/test.txt', { read: true, write: true, create: true }, 'kernel');
            expect(handle).toBeDefined();
            expect(handle.closed).toBe(false);
            await handle.close();
        });

        it('should stat created file', async () => {
            await stack.vfs!.open('/test.txt', { write: true, create: true }, 'kernel');
            const stat = await stack.vfs!.stat('/test.txt', 'kernel');

            expect(stat.model).toBe('file');
            expect(stat.name).toBe('test.txt');
            expect(stat.size).toBe(0);
        });

        it('should write and read file content', async () => {
            const handle = await stack.vfs!.open('/test.txt', { read: true, write: true, create: true }, 'kernel');

            const content = new TextEncoder().encode('Hello, World!');
            await handle.write(content);
            await handle.close();

            // Re-open and read
            const handle2 = await stack.vfs!.open('/test.txt', { read: true }, 'kernel');
            const data = await handle2.read();
            await handle2.close();

            expect(data.length).toBe(13);
            expect(new TextDecoder().decode(data)).toBe('Hello, World!');
        });

        it('should update file size after write', async () => {
            const handle = await stack.vfs!.open('/test.txt', { read: true, write: true, create: true }, 'kernel');
            await handle.write(new TextEncoder().encode('Hello'));
            await handle.close();

            const stat = await stack.vfs!.stat('/test.txt', 'kernel');
            expect(stat.size).toBe(5);
        });

        it('should throw ENOENT for non-existent file', async () => {
            await expect(stack.vfs!.stat('/non-existent.txt', 'kernel')).rejects.toBeInstanceOf(ENOENT);
        });

        it('should delete file with unlink', async () => {
            await stack.vfs!.open('/test.txt', { write: true, create: true }, 'kernel');
            await stack.vfs!.unlink('/test.txt', 'kernel');

            await expect(stack.vfs!.stat('/test.txt', 'kernel')).rejects.toBeInstanceOf(ENOENT);
        });
    });
});

describe('FolderModel', () => {
    let stack: OsStack;
    const ROOT_ID = '00000000-0000-0000-0000-000000000000';

    beforeEach(async () => {
        stack = await createOsStack({ vfs: true });
    });

    afterEach(async () => {
        await stack.shutdown();
    });

    describe('via VFS', () => {
        it('should create folder with mkdir', async () => {
            const id = await stack.vfs!.mkdir('/testdir', 'kernel');
            expect(id).toBeDefined();
            expect(id.length).toBeGreaterThan(0); // UUID format varies
        });

        it('should stat created folder', async () => {
            await stack.vfs!.mkdir('/testdir', 'kernel');
            const stat = await stack.vfs!.stat('/testdir', 'kernel');

            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('testdir');
            expect(stat.size).toBe(0);
        });

        it('should throw EISDIR when opening folder', async () => {
            await stack.vfs!.mkdir('/testdir', 'kernel');
            await expect(
                stack.vfs!.open('/testdir', { read: true }, 'kernel')
            ).rejects.toBeInstanceOf(EISDIR);
        });

        it('should list folder children', async () => {
            await stack.vfs!.mkdir('/testdir', 'kernel');
            await stack.vfs!.open('/testdir/file1.txt', { write: true, create: true }, 'kernel');
            await stack.vfs!.open('/testdir/file2.txt', { write: true, create: true }, 'kernel');

            const children: string[] = [];
            for await (const child of stack.vfs!.readdir('/testdir', 'kernel')) {
                children.push(child.name);
            }

            expect(children).toContain('file1.txt');
            expect(children).toContain('file2.txt');
            expect(children.length).toBe(2);
        });

        it('should return empty for empty folder', async () => {
            await stack.vfs!.mkdir('/emptydir', 'kernel');

            const children: string[] = [];
            for await (const child of stack.vfs!.readdir('/emptydir', 'kernel')) {
                children.push(child.name);
            }

            expect(children).toEqual([]);
        });

        it('should create nested folders with recursive', async () => {
            await stack.vfs!.mkdir('/a/b/c', 'kernel', { recursive: true });

            const statA = await stack.vfs!.stat('/a', 'kernel');
            const statB = await stack.vfs!.stat('/a/b', 'kernel');
            const statC = await stack.vfs!.stat('/a/b/c', 'kernel');

            expect(statA.model).toBe('folder');
            expect(statB.model).toBe('folder');
            expect(statC.model).toBe('folder');
        });

        it('should delete empty folder', async () => {
            await stack.vfs!.mkdir('/testdir', 'kernel');
            await stack.vfs!.unlink('/testdir', 'kernel');

            await expect(stack.vfs!.stat('/testdir', 'kernel')).rejects.toBeInstanceOf(ENOENT);
        });

        it('should throw ENOENT for non-existent folder', async () => {
            await expect(stack.vfs!.stat('/non-existent', 'kernel')).rejects.toBeInstanceOf(ENOENT);
        });
    });
});
