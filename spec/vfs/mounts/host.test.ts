/**
 * HostMount Tests
 *
 * Tests for the host filesystem mount module, including path resolution,
 * security boundaries, and file operations.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createHostMount,
    resolveHostPath,
    isUnderHostMount,
    hostStat,
    hostReaddir,
    hostOpen,
    type HostMount,
} from '@src/vfs/mounts/host.js';
import { ENOENT, EACCES, EISDIR, ENOTDIR, EBADF } from '@src/hal/errors.js';

// =============================================================================
// TEST SETUP
// =============================================================================

let tempDir: string;

beforeAll(async () => {
    // Create temp directory for tests
    tempDir = await mkdtemp(join(tmpdir(), 'monk-host-mount-test-'));

    // Create test file structure:
    // tempDir/
    //   file1.txt (content: "Hello, World!")
    //   file2.txt (content: "Test file 2")
    //   subdir/
    //     nested.txt (content: "Nested file")
    //   empty.txt (empty file)
    await writeFile(join(tempDir, 'file1.txt'), 'Hello, World!');
    await writeFile(join(tempDir, 'file2.txt'), 'Test file 2');
    await mkdir(join(tempDir, 'subdir'));
    await writeFile(join(tempDir, 'subdir', 'nested.txt'), 'Nested file');
    await writeFile(join(tempDir, 'empty.txt'), '');
});

afterAll(async () => {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
});

// =============================================================================
// MOUNT CONFIGURATION TESTS
// =============================================================================

describe('HostMount', () => {
    describe('createHostMount()', () => {
        it('should create mount with normalized VFS path', () => {
            const mount = createHostMount('/bin', tempDir);

            expect(mount.vfsPath).toBe('/bin');
            expect(mount.hostPath).toBe(tempDir);
            expect(mount.resolvedHostPath).toBe(tempDir);
        });

        it('should remove trailing slash from VFS path', () => {
            const mount = createHostMount('/bin/', tempDir);

            expect(mount.vfsPath).toBe('/bin');
        });

        it('should handle root mount', () => {
            const mount = createHostMount('/', tempDir);

            expect(mount.vfsPath).toBe('/');
        });

        it('should resolve relative host paths to absolute', () => {
            const mount = createHostMount('/bin', './relative/path');

            // resolvedHostPath should be absolute
            expect(mount.resolvedHostPath).toMatch(/^\//);
            expect(mount.resolvedHostPath).toContain('relative/path');
        });

        it('should default to readonly=true', () => {
            const mount = createHostMount('/bin', tempDir);

            expect(mount.options.readonly).toBe(true);
        });

        it('should respect readonly option', () => {
            const mount = createHostMount('/bin', tempDir, { readonly: false });

            expect(mount.options.readonly).toBe(false);
        });

        it('should preserve original hostPath', () => {
            const mount = createHostMount('/bin', './relative');

            expect(mount.hostPath).toBe('./relative');
            // But resolvedHostPath should be absolute
            expect(mount.resolvedHostPath).not.toBe('./relative');
        });
    });

    // =========================================================================
    // PATH RESOLUTION TESTS
    // =========================================================================

    describe('resolveHostPath()', () => {
        let mount: HostMount;

        beforeAll(() => {
            mount = createHostMount('/bin', tempDir);
        });

        it('should resolve exact mount path', () => {
            const resolved = resolveHostPath(mount, '/bin');

            expect(resolved).toBe(tempDir);
        });

        it('should resolve path under mount', () => {
            const resolved = resolveHostPath(mount, '/bin/file1.txt');

            expect(resolved).toBe(join(tempDir, 'file1.txt'));
        });

        it('should resolve nested path', () => {
            const resolved = resolveHostPath(mount, '/bin/subdir/nested.txt');

            expect(resolved).toBe(join(tempDir, 'subdir/nested.txt'));
        });

        it('should return null for path outside mount', () => {
            const resolved = resolveHostPath(mount, '/etc/passwd');

            expect(resolved).toBeNull();
        });

        it('should reject path traversal attacks', () => {
            // SECURITY: Attempt to escape mount boundary
            const resolved = resolveHostPath(mount, '/bin/../../../etc/passwd');

            expect(resolved).toBeNull();
        });

        it('should reject path traversal in middle of path', () => {
            const resolved = resolveHostPath(mount, '/bin/subdir/../../etc/passwd');

            expect(resolved).toBeNull();
        });

        it('should allow . and .. within mount boundary', () => {
            const resolved = resolveHostPath(mount, '/bin/subdir/../file1.txt');

            // Should resolve to file1.txt if it stays within mount
            expect(resolved).toBe(join(tempDir, 'file1.txt'));
        });

        it('should handle root mount', () => {
            const rootMount = createHostMount('/', tempDir);
            const resolved = resolveHostPath(rootMount, '/file1.txt');

            expect(resolved).toBe(join(tempDir, 'file1.txt'));
        });

        it('should handle root mount with nested paths', () => {
            const rootMount = createHostMount('/', tempDir);
            const resolved = resolveHostPath(rootMount, '/subdir/nested.txt');

            expect(resolved).toBe(join(tempDir, 'subdir/nested.txt'));
        });

        it('should reject traversal from root mount', () => {
            const rootMount = createHostMount('/', tempDir);
            const resolved = resolveHostPath(rootMount, '/../../../etc/passwd');

            expect(resolved).toBeNull();
        });
    });

    describe('isUnderHostMount()', () => {
        let mount: HostMount;

        beforeAll(() => {
            mount = createHostMount('/bin', tempDir);
        });

        it('should return true for exact mount path', () => {
            expect(isUnderHostMount(mount, '/bin')).toBe(true);
        });

        it('should return true for path under mount', () => {
            expect(isUnderHostMount(mount, '/bin/file1.txt')).toBe(true);
        });

        it('should return true for nested path', () => {
            expect(isUnderHostMount(mount, '/bin/subdir/nested.txt')).toBe(true);
        });

        it('should return false for path outside mount', () => {
            expect(isUnderHostMount(mount, '/etc/passwd')).toBe(false);
        });

        it('should return false for similar prefix', () => {
            // /binary should not match mount at /bin
            expect(isUnderHostMount(mount, '/binary')).toBe(false);
        });

        it('should handle root mount', () => {
            const rootMount = createHostMount('/', tempDir);

            expect(isUnderHostMount(rootMount, '/anything')).toBe(true);
            expect(isUnderHostMount(rootMount, '/deep/nested/path')).toBe(true);
        });
    });

    // =========================================================================
    // FILE METADATA TESTS
    // =========================================================================

    describe('hostStat()', () => {
        let mount: HostMount;

        beforeAll(() => {
            mount = createHostMount('/mnt', tempDir);
        });

        it('should stat existing file', async () => {
            const stat = await hostStat(mount, '/mnt/file1.txt');

            expect(stat.id).toBe('host:/mnt/file1.txt');
            expect(stat.model).toBe('file');
            expect(stat.name).toBe('file1.txt');
            expect(stat.parent).toBeNull();
            expect(stat.owner).toBe('kernel');
            expect(stat.size).toBe(13); // "Hello, World!" = 13 bytes
            expect(stat.mtime).toBeGreaterThan(0);
            expect(stat.ctime).toBeGreaterThan(0);
        });

        it('should stat directory', async () => {
            const stat = await hostStat(mount, '/mnt/subdir');

            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('subdir');
        });

        it('should stat mount root', async () => {
            const stat = await hostStat(mount, '/mnt');

            expect(stat.model).toBe('folder');
            // Name for mount root should be the mount basename
            expect(stat.name).toBeTruthy();
        });

        it('should throw ENOENT for non-existent file', async () => {
            await expect(hostStat(mount, '/mnt/nonexistent.txt')).rejects.toThrow(ENOENT);
        });

        it('should throw ENOENT for path outside mount', async () => {
            await expect(hostStat(mount, '/etc/passwd')).rejects.toThrow(ENOENT);
        });

        it('should throw ENOENT for path traversal', async () => {
            await expect(hostStat(mount, '/mnt/../../etc/passwd')).rejects.toThrow(ENOENT);
        });

        it('should stat empty file', async () => {
            const stat = await hostStat(mount, '/mnt/empty.txt');

            expect(stat.size).toBe(0);
            expect(stat.model).toBe('file');
        });
    });

    // =========================================================================
    // DIRECTORY LISTING TESTS
    // =========================================================================

    describe('hostReaddir()', () => {
        let mount: HostMount;

        beforeAll(() => {
            mount = createHostMount('/mnt', tempDir);
        });

        it('should list directory entries', async () => {
            const entries: string[] = [];

            for await (const stat of hostReaddir(mount, '/mnt')) {
                entries.push(stat.name);
            }

            expect(entries).toContain('file1.txt');
            expect(entries).toContain('file2.txt');
            expect(entries).toContain('subdir');
            expect(entries).toContain('empty.txt');
        });

        it('should return ModelStat for each entry', async () => {
            for await (const stat of hostReaddir(mount, '/mnt')) {
                expect(stat.id).toMatch(/^host:/);
                expect(stat.model).toMatch(/^(file|folder)$/);
                expect(stat.name).toBeTruthy();
                expect(stat.parent).toBeNull();
                expect(stat.owner).toBe('kernel');
                expect(stat.size).toBeGreaterThanOrEqual(0);
            }
        });

        it('should list nested directory', async () => {
            const entries: string[] = [];

            for await (const stat of hostReaddir(mount, '/mnt/subdir')) {
                entries.push(stat.name);
            }

            expect(entries).toContain('nested.txt');
        });

        it('should return empty iterator for empty directory', async () => {
            // Create empty directory
            const emptyDir = join(tempDir, 'emptydir');

            await mkdir(emptyDir);

            const entries: string[] = [];

            for await (const stat of hostReaddir(mount, '/mnt/emptydir')) {
                entries.push(stat.name);
            }

            expect(entries).toEqual([]);

            await rm(emptyDir, { recursive: true });
        });

        it('should throw ENOENT for non-existent directory', async () => {
            const iterator = hostReaddir(mount, '/mnt/nonexistent');

            await expect(iterator.next()).rejects.toThrow(ENOENT);
        });

        it('should throw ENOTDIR for file path', async () => {
            const iterator = hostReaddir(mount, '/mnt/file1.txt');

            await expect(iterator.next()).rejects.toThrow(ENOTDIR);
        });

        it('should throw ENOENT for path outside mount', async () => {
            const iterator = hostReaddir(mount, '/etc');

            await expect(iterator.next()).rejects.toThrow(ENOENT);
        });

        it('should include correct VFS paths in entry IDs', async () => {
            for await (const stat of hostReaddir(mount, '/mnt/subdir')) {
                // Entry IDs should include full VFS path
                expect(stat.id).toBe(`host:/mnt/subdir/${stat.name}`);
            }
        });

        it('should handle root mount directory listing', async () => {
            const rootMount = createHostMount('/', tempDir);
            const entries: string[] = [];

            for await (const stat of hostReaddir(rootMount, '/')) {
                entries.push(stat.name);
            }

            expect(entries.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // FILE OPEN TESTS
    // =========================================================================

    describe('hostOpen()', () => {
        let mount: HostMount;
        let writableMount: HostMount;

        beforeAll(() => {
            mount = createHostMount('/mnt', tempDir, { readonly: true });
            writableMount = createHostMount('/writable', tempDir, { readonly: false });
        });

        it('should open existing file for reading', async () => {
            const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

            expect(handle).toBeDefined();
            expect(handle.id).toMatch(/^host-handle:/);
            expect(handle.path).toBe('/mnt/file1.txt');
            expect(handle.flags.read).toBe(true);
            expect(handle.flags.write).toBe(false);
            expect(handle.closed).toBe(false);

            await handle.close();
        });

        it('should throw ENOENT for non-existent file', async () => {
            await expect(
                hostOpen(mount, '/mnt/nonexistent.txt', { read: true, write: false }),
            ).rejects.toThrow(ENOENT);
        });

        it('should throw EISDIR for directory', async () => {
            await expect(
                hostOpen(mount, '/mnt/subdir', { read: true, write: false }),
            ).rejects.toThrow(EISDIR);
        });

        it('should throw ENOENT for path outside mount', async () => {
            await expect(
                hostOpen(mount, '/etc/passwd', { read: true, write: false }),
            ).rejects.toThrow(ENOENT);
        });

        it('should throw EACCES for write on readonly mount', async () => {
            await expect(
                hostOpen(mount, '/mnt/file1.txt', { read: true, write: true }),
            ).rejects.toThrow(EACCES);
        });

        it('should throw EACCES for create on readonly mount', async () => {
            await expect(
                hostOpen(mount, '/mnt/newfile.txt', { read: true, write: true, create: true }),
            ).rejects.toThrow(EACCES);
        });

        it('should allow write flag on writable mount', async () => {
            const handle = await hostOpen(writableMount, '/writable/file1.txt', {
                read: true,
                write: true,
            });

            expect(handle.flags.write).toBe(true);

            await handle.close();
        });

        it('should throw for create flag (not implemented)', async () => {
            await expect(
                hostOpen(writableMount, '/writable/newfile.txt', {
                    read: true,
                    write: true,
                    create: true,
                }),
            ).rejects.toThrow(EACCES);
        });
    });

    // =========================================================================
    // FILE HANDLE I/O TESTS
    // =========================================================================

    describe('HostFileHandle', () => {
        let mount: HostMount;

        beforeAll(() => {
            mount = createHostMount('/mnt', tempDir);
        });

        describe('read()', () => {
            it('should read entire file content', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });
                const content = await handle.read();

                expect(content).toEqual(new TextEncoder().encode('Hello, World!'));

                await handle.close();
            });

            it('should read partial content with size limit', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });
                const content = await handle.read(5);

                expect(content).toEqual(new TextEncoder().encode('Hello'));

                await handle.close();
            });

            it('should read from current position', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                // Read first 5 bytes
                await handle.read(5);

                // Read next 2 bytes
                const content = await handle.read(2);

                expect(content).toEqual(new TextEncoder().encode(', '));

                await handle.close();
            });

            it('should return empty array at EOF', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                // Read entire file
                await handle.read();

                // Read again at EOF
                const content = await handle.read();

                expect(content).toEqual(new Uint8Array(0));

                await handle.close();
            });

            it('should handle empty files', async () => {
                const handle = await hostOpen(mount, '/mnt/empty.txt', { read: true, write: false });
                const content = await handle.read();

                expect(content).toEqual(new Uint8Array(0));

                await handle.close();
            });

            it('should throw EBADF after close', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                await handle.close();

                await expect(handle.read()).rejects.toThrow(EBADF);
            });

            it('should throw EACCES if not opened for reading', async () => {
                // Open with write-only (on writable mount)
                const writableMount = createHostMount('/writable', tempDir, { readonly: false });
                const handle = await hostOpen(writableMount, '/writable/file1.txt', {
                    read: false,
                    write: true,
                });

                await expect(handle.read()).rejects.toThrow(EACCES);

                await handle.close();
            });

            it('should cache content after first read', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                // First read loads content
                const content1 = await handle.read(5);

                // Reset position
                await handle.seek(0, 'start');

                // Second read should use cached content
                const content2 = await handle.read(5);

                expect(content1).toEqual(content2);

                await handle.close();
            });
        });

        describe('write()', () => {
            it('should throw EBADF after close', async () => {
                const writableMount = createHostMount('/writable', tempDir, { readonly: false });
                const handle = await hostOpen(writableMount, '/writable/file1.txt', {
                    read: true,
                    write: true,
                });

                await handle.close();

                await expect(handle.write(new Uint8Array([1, 2, 3]))).rejects.toThrow(EBADF);
            });

            it('should throw EACCES if not opened for writing', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                await expect(handle.write(new Uint8Array([1, 2, 3]))).rejects.toThrow(EACCES);

                await handle.close();
            });

            it('should throw EACCES for write operation (not implemented)', async () => {
                const writableMount = createHostMount('/writable', tempDir, { readonly: false });
                const handle = await hostOpen(writableMount, '/writable/file1.txt', {
                    read: true,
                    write: true,
                });

                await expect(handle.write(new Uint8Array([1, 2, 3]))).rejects.toThrow(EACCES);

                await handle.close();
            });
        });

        describe('seek()', () => {
            it('should seek from start', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                const pos = await handle.seek(7, 'start');

                expect(pos).toBe(7);

                const content = await handle.read(5);

                expect(content).toEqual(new TextEncoder().encode('World'));

                await handle.close();
            });

            it('should seek from current position', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                await handle.read(5);

                const pos = await handle.seek(2, 'current');

                expect(pos).toBe(7);

                await handle.close();
            });

            it('should seek from end', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                const pos = await handle.seek(-1, 'end');

                // "Hello, World!" = 13 bytes, so -1 from end = position 12
                expect(pos).toBe(12);

                const content = await handle.read();

                expect(content).toEqual(new TextEncoder().encode('!'));

                await handle.close();
            });

            it('should clamp negative positions to 0', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                const pos = await handle.seek(-999, 'start');

                expect(pos).toBe(0);

                await handle.close();
            });

            it('should allow seeking past EOF', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                const pos = await handle.seek(999, 'start');

                expect(pos).toBe(999);

                // Read should return empty at EOF
                const content = await handle.read();

                expect(content).toEqual(new Uint8Array(0));

                await handle.close();
            });

            it('should throw EBADF after close', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                await handle.close();

                await expect(handle.seek(0, 'start')).rejects.toThrow(EBADF);
            });

            it('should load content for size calculation', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                // Seek to end (requires knowing file size)
                const pos = await handle.seek(0, 'end');

                expect(pos).toBe(13);

                await handle.close();
            });
        });

        describe('tell()', () => {
            it('should return current position', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                expect(await handle.tell()).toBe(0);

                await handle.read(5);

                expect(await handle.tell()).toBe(5);

                await handle.close();
            });

            it('should return position after seek', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                await handle.seek(10, 'start');

                expect(await handle.tell()).toBe(10);

                await handle.close();
            });
        });

        describe('sync()', () => {
            it('should be no-op for readonly files', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                await handle.sync();

                await handle.close();
            });
        });

        describe('close()', () => {
            it('should mark handle as closed', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                expect(handle.closed).toBe(false);

                await handle.close();

                expect(handle.closed).toBe(true);
            });

            it('should be idempotent', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                await handle.close();
                await handle.close();
                await handle.close();

                expect(handle.closed).toBe(true);
            });

            it('should release cached content', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                // Load content
                await handle.read();

                await handle.close();

                // After close, content should be released
                // This is tested implicitly - no way to inspect private _content
                expect(handle.closed).toBe(true);
            });
        });

        describe('Symbol.asyncDispose', () => {
            it('should close handle on dispose', async () => {
                const handle = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                await handle[Symbol.asyncDispose]();

                expect(handle.closed).toBe(true);
            });

            it('should work with await using pattern', async () => {
                {
                    await using handle = await hostOpen(mount, '/mnt/file1.txt', {
                        read: true,
                        write: false,
                    });

                    const content = await handle.read(5);

                    expect(content).toEqual(new TextEncoder().encode('Hello'));
                }

                // Handle should be auto-closed after block
            });
        });

        describe('multiple handles', () => {
            it('should allow multiple independent handles to same file', async () => {
                const handle1 = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });
                const handle2 = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                // Read different amounts from each
                await handle1.read(5);
                await handle2.read(7);

                // Positions should be independent
                expect(await handle1.tell()).toBe(5);
                expect(await handle2.tell()).toBe(7);

                await handle1.close();
                await handle2.close();
            });

            it('should have unique IDs when opened at different times', async () => {
                const handle1 = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                // Wait a millisecond to ensure different timestamp
                await Bun.sleep(1);

                const handle2 = await hostOpen(mount, '/mnt/file1.txt', { read: true, write: false });

                expect(handle1.id).not.toBe(handle2.id);

                await handle1.close();
                await handle2.close();
            });
        });
    });

    // =========================================================================
    // SECURITY TESTS
    // =========================================================================

    describe('security', () => {
        let mount: HostMount;

        beforeAll(() => {
            mount = createHostMount('/secure', tempDir);
        });

        it('should reject path traversal with ../', async () => {
            const paths = [
                '/secure/../etc/passwd',
                '/secure/subdir/../../etc/passwd',
                '/secure/../../../etc/passwd',
            ];

            for (const path of paths) {
                const resolved = resolveHostPath(mount, path);

                expect(resolved).toBeNull();
            }
        });

        it('should reject absolute path injection', async () => {
            // Try to inject absolute path
            const resolved = resolveHostPath(mount, '/etc/passwd');

            expect(resolved).toBeNull();
        });

        it('should only allow access within mount boundary', async () => {
            // Verify we can access files in mount
            const validPath = resolveHostPath(mount, '/secure/file1.txt');

            expect(validPath).not.toBeNull();

            // But not outside it
            const invalidPath = resolveHostPath(mount, '/other/file.txt');

            expect(invalidPath).toBeNull();
        });

        it('should enforce readonly on mount operations', async () => {
            await expect(
                hostOpen(mount, '/secure/file1.txt', { read: true, write: true }),
            ).rejects.toThrow(EACCES);
        });

        it('should validate paths before any filesystem access', async () => {
            // Path validation should happen before stat/open
            // This prevents information leakage about host filesystem
            await expect(hostStat(mount, '/secure/../etc/passwd')).rejects.toThrow(ENOENT);
        });
    });
});
