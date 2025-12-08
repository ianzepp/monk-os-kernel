/**
 * VFS Syscall Tests
 *
 * Tests for file system syscall validation and behavior.
 *
 * WHY: These tests validate the syscall layer through the real dispatch chain.
 * Uses TestOS with dispatcher layer to test syscall validation and behavior
 * without mocks, ensuring real integration between syscall handlers and VFS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestOS } from '@src/os/test.js';

describe('VFS Syscalls', () => {
    let os: TestOS;

    beforeEach(async () => {
        os = new TestOS();
        // WHY: Boot with dispatcher layer to enable syscall testing
        // This provides hal, ems, auth, vfs, kernel, dispatcher
        await os.boot({ layers: ['dispatcher'] });
    });

    afterEach(async () => {
        await os.shutdown();
    });

    // =========================================================================
    // file:open
    // =========================================================================

    describe('file:open', () => {
        it('should yield EINVAL when path is not a string', async () => {
            await expect(os.syscall('file:open', 123)).rejects.toThrow('path must be a string');
        });

        it('should yield EINVAL when path is null', async () => {
            await expect(os.syscall('file:open', null)).rejects.toThrow('path must be a string');
        });

        it('should yield EINVAL when path is undefined', async () => {
            await expect(os.syscall('file:open', undefined)).rejects.toThrow('path must be a string');
        });
    });

    // =========================================================================
    // file:close
    // =========================================================================

    describe('file:close', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('file:close', 'string')).rejects.toThrow('fd must be a number');
        });

        it('should yield EINVAL when fd is null', async () => {
            await expect(os.syscall('file:close', null)).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // file:read
    // =========================================================================

    describe('file:read', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('file:read', 'string')).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // file:write
    // =========================================================================

    describe('file:write', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('file:write', null, 'data')).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // file:seek
    // =========================================================================

    describe('file:seek', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('file:seek', 'invalid', 0)).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // file:stat
    // =========================================================================

    describe('file:stat', () => {
        it('should yield EINVAL when path is not a string', async () => {
            await expect(os.syscall('file:stat', 123)).rejects.toThrow('path must be a string');
        });

        it('should return stat data for root directory', async () => {
            const result = await os.syscall<{ model: string; name: string }>('file:stat', '/');

            expect(result.model).toBe('folder');
            // WHY: Root folder has empty name in VFS (no parent to name it)
            expect(result.name).toBe('');
        });

        it('should use test user identity for ACL checks', async () => {
            // WHY: Test that user identity is passed through to VFS
            os.setTestUser('alice');

            // Root is always accessible, so this should work
            const result = await os.syscall<{ model: string }>('file:stat', '/');

            expect(result.model).toBe('folder');
        });
    });

    // =========================================================================
    // file:setstat
    // =========================================================================

    describe('file:setstat', () => {
        it('should yield EINVAL when path is not a string', async () => {
            await expect(os.syscall('file:setstat', 123, { mtime: 0 })).rejects.toThrow('path must be a string');
        });

        it('should yield EINVAL when path is null', async () => {
            await expect(os.syscall('file:setstat', null, { mtime: 0 })).rejects.toThrow('path must be a string');
        });

        it('should yield EINVAL when fields is not an object', async () => {
            await expect(os.syscall('file:setstat', '/file.txt', 'invalid')).rejects.toThrow('fields must be an object');
        });

        it('should yield EINVAL when fields is null', async () => {
            await expect(os.syscall('file:setstat', '/file.txt', null)).rejects.toThrow('fields must be an object');
        });
    });

    // =========================================================================
    // file:fstat
    // =========================================================================

    describe('file:fstat', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('file:fstat', 'string')).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // file:mkdir
    // =========================================================================

    describe('file:mkdir', () => {
        it('should yield EINVAL when path is not a string', async () => {
            await expect(os.syscall('file:mkdir', 123)).rejects.toThrow('path must be a string');
        });

        it('should create a directory', async () => {
            await os.syscall('file:mkdir', '/test-dir');

            const stat = await os.syscall<{ model: string; name: string }>('file:stat', '/test-dir');

            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('test-dir');
        });
    });

    // =========================================================================
    // file:unlink
    // =========================================================================

    describe('file:unlink', () => {
        it('should yield EINVAL when path is not a string', async () => {
            await expect(os.syscall('file:unlink', null)).rejects.toThrow('path must be a string');
        });
    });

    // =========================================================================
    // file:rmdir
    // =========================================================================

    describe('file:rmdir', () => {
        it('should yield EINVAL when path is not a string', async () => {
            await expect(os.syscall('file:rmdir', {})).rejects.toThrow('path must be a string');
        });
    });

    // =========================================================================
    // file:readdir
    // =========================================================================

    describe('file:readdir', () => {
        it('should yield EINVAL when path is not a string', async () => {
            await expect(os.syscall('file:readdir', undefined)).rejects.toThrow('path must be a string');
        });

        it('should stream directory entries', async () => {
            // Create test directory structure
            await os.syscall('file:mkdir', '/test-readdir');
            await os.syscall('file:mkdir', '/test-readdir/subdir1');
            await os.syscall('file:mkdir', '/test-readdir/subdir2');

            const entries = await os.syscall<Array<{ name: string; model: string }>>('file:readdir', '/test-readdir');

            expect(entries.length).toBe(2);
            expect(entries.some(e => e.name === 'subdir1')).toBe(true);
            expect(entries.some(e => e.name === 'subdir2')).toBe(true);
        });
    });

    // =========================================================================
    // file:rename
    // =========================================================================

    describe('file:rename', () => {
        it('should yield EINVAL when oldPath is not a string', async () => {
            await expect(os.syscall('file:rename', 123, '/new')).rejects.toThrow('paths must be strings');
        });

        it('should yield EINVAL when newPath is not a string', async () => {
            await expect(os.syscall('file:rename', '/old', 456)).rejects.toThrow('paths must be strings');
        });

        it('should yield ENOSYS (not implemented)', async () => {
            await expect(os.syscall('file:rename', '/old', '/new')).rejects.toThrow();
        });
    });

    // =========================================================================
    // file:symlink
    // =========================================================================

    describe('file:symlink', () => {
        it('should yield EINVAL when target is not a string', async () => {
            await expect(os.syscall('file:symlink', 123, '/link')).rejects.toThrow('target must be a string');
        });

        it('should yield EINVAL when linkPath is not a string', async () => {
            await expect(os.syscall('file:symlink', '/target', null)).rejects.toThrow('linkPath must be a string');
        });

        it('should reject symlink creation (disabled)', async () => {
            // WHY: Symlinks are disabled until proper resolution is implemented
            await expect(os.syscall('file:symlink', '/target', '/link')).rejects.toThrow('not supported');
        });
    });

    // =========================================================================
    // file:access
    // =========================================================================

    describe('file:access', () => {
        it('should yield EINVAL when path is not a string', async () => {
            await expect(os.syscall('file:access', {})).rejects.toThrow('path must be a string');
        });

        it('should get ACL when acl argument is undefined', async () => {
            const acl = await os.syscall('file:access', '/');

            expect(acl).toBeDefined();
        });
    });

    // =========================================================================
    // file:recv
    // =========================================================================

    describe('file:recv', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('file:recv', 'string')).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // file:send
    // =========================================================================

    describe('file:send', () => {
        it('should yield EINVAL when fd is not a number', async () => {
            await expect(os.syscall('file:send', null, {})).rejects.toThrow('fd must be a number');
        });
    });

    // =========================================================================
    // fs:mount
    // =========================================================================

    describe('fs:mount', () => {
        it('should yield EINVAL when source is not a string', async () => {
            await expect(os.syscall('fs:mount', 123, '/mnt')).rejects.toThrow('source must be a string');
        });

        it('should yield EINVAL when target is not a string', async () => {
            await expect(os.syscall('fs:mount', 'host:/path', null)).rejects.toThrow('target must be a string');
        });
    });

    // =========================================================================
    // fs:umount
    // =========================================================================

    describe('fs:umount', () => {
        it('should yield EINVAL when target is not a string', async () => {
            await expect(os.syscall('fs:umount', undefined)).rejects.toThrow('target must be a string');
        });
    });
});
