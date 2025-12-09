/**
 * Process Syscall Tests
 *
 * Tests for process lifecycle and environment syscall validation.
 *
 * WHY: These tests validate the syscall layer through the real dispatch chain.
 * Uses TestOS with dispatcher layer to test syscall validation and behavior
 * without mocks, ensuring real integration between syscall handlers and kernel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestOS } from '@src/os/test.js';

describe('Process Syscalls', () => {
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
    // proc:spawn
    // =========================================================================

    describe('proc:spawn', () => {
        it('should yield EINVAL when entry is not a string', async () => {
            await expect(os.syscall('proc:spawn', 123)).rejects.toThrow('entry must be a string');
        });

        it('should yield EINVAL when entry is null', async () => {
            await expect(os.syscall('proc:spawn', null)).rejects.toThrow('entry must be a string');
        });
    });

    // =========================================================================
    // proc:exit
    // =========================================================================

    describe('proc:exit', () => {
        it('should yield EINVAL when code is not a number', async () => {
            await expect(os.syscall('proc:exit', 'string')).rejects.toThrow('code must be a non-negative number');
        });

        it('should yield EINVAL when code is negative', async () => {
            await expect(os.syscall('proc:exit', -1)).rejects.toThrow('code must be a non-negative number');
        });
    });

    // =========================================================================
    // proc:kill
    // =========================================================================

    describe('proc:kill', () => {
        it('should yield EINVAL when targetPid is not a number', async () => {
            await expect(os.syscall('proc:kill', 'string')).rejects.toThrow('pid must be a positive number');
        });

        it('should yield EINVAL when targetPid is zero', async () => {
            await expect(os.syscall('proc:kill', 0)).rejects.toThrow('pid must be a positive number');
        });

        it('should yield EINVAL when targetPid is negative', async () => {
            await expect(os.syscall('proc:kill', -5)).rejects.toThrow('pid must be a positive number');
        });
    });

    // =========================================================================
    // proc:wait
    // =========================================================================

    describe('proc:wait', () => {
        it('should yield EINVAL when targetPid is not a number', async () => {
            await expect(os.syscall('proc:wait', null)).rejects.toThrow('pid must be a positive number');
        });

        it('should yield EINVAL when targetPid is zero', async () => {
            await expect(os.syscall('proc:wait', 0)).rejects.toThrow('pid must be a positive number');
        });
    });

    // =========================================================================
    // proc:getpid
    // =========================================================================

    describe('proc:getpid', () => {
        it('should return process ID', async () => {
            const pid = await os.syscall<number>('proc:getpid');

            expect(typeof pid).toBe('number');
            expect(pid).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // proc:getppid
    // =========================================================================

    describe('proc:getppid', () => {
        it('should return parent process ID', async () => {
            const ppid = await os.syscall<number>('proc:getppid');

            expect(typeof ppid).toBe('number');
            expect(ppid).toBeGreaterThanOrEqual(0);
        });
    });

    // =========================================================================
    // proc:getargs
    // =========================================================================

    describe('proc:getargs', () => {
        it('should return process arguments', async () => {
            const args = await os.syscall<string[]>('proc:getargs');

            expect(Array.isArray(args)).toBe(true);
        });
    });

    // =========================================================================
    // proc:getcwd
    // =========================================================================

    describe('proc:getcwd', () => {
        it('should return current working directory', async () => {
            const cwd = await os.syscall<string>('proc:getcwd');

            expect(typeof cwd).toBe('string');
            expect(cwd).toBeTruthy();
        });
    });

    // =========================================================================
    // proc:chdir
    // =========================================================================

    describe('proc:chdir', () => {
        it('should yield EINVAL when path is not a string', async () => {
            await expect(os.syscall('proc:chdir', 123)).rejects.toThrow('path must be a string');
        });

        it('should change cwd on success', async () => {
            await os.syscall('file:mkdir', '/test-chdir');

            await os.syscall('proc:chdir', '/test-chdir');

            const cwd = await os.syscall<string>('proc:getcwd');

            expect(cwd).toBe('/test-chdir');
        });

        it('should resolve relative paths', async () => {
            await os.syscall('file:mkdir', '/base');
            await os.syscall('file:mkdir', '/base/subdir');
            await os.syscall('proc:chdir', '/base');

            await os.syscall('proc:chdir', 'subdir');

            const cwd = await os.syscall<string>('proc:getcwd');

            expect(cwd).toBe('/base/subdir');
        });

        it('should resolve .. paths', async () => {
            await os.syscall('file:mkdir', '/parent');
            await os.syscall('file:mkdir', '/parent/child');
            await os.syscall('file:mkdir', '/parent/child/grandchild');
            await os.syscall('proc:chdir', '/parent/child/grandchild');

            await os.syscall('proc:chdir', '../..');

            const cwd = await os.syscall<string>('proc:getcwd');

            expect(cwd).toBe('/parent');
        });

        it('should yield ENOENT when path does not exist', async () => {
            await expect(os.syscall('proc:chdir', '/nonexistent')).rejects.toThrow('No such file');
        });
    });

    // =========================================================================
    // proc:getenv
    // =========================================================================

    describe('proc:getenv', () => {
        it('should yield EINVAL when name is not a string', async () => {
            await expect(os.syscall('proc:getenv', 123)).rejects.toThrow('name must be a string');
        });

        it('should return environment variable value', async () => {
            await os.syscall('proc:setenv', 'TEST_VAR', 'test_value');

            const value = await os.syscall<string>('proc:getenv', 'TEST_VAR');

            expect(value).toBe('test_value');
        });

        it('should return undefined for missing variable', async () => {
            const value = await os.syscall<string | undefined>('proc:getenv', 'NONEXISTENT_VAR');

            expect(value).toBeUndefined();
        });
    });

    // =========================================================================
    // proc:setenv
    // =========================================================================

    describe('proc:setenv', () => {
        it('should yield EINVAL when name is not a string', async () => {
            await expect(os.syscall('proc:setenv', null, 'value')).rejects.toThrow('name must be a string');
        });

        it('should yield EINVAL when value is not a string', async () => {
            await expect(os.syscall('proc:setenv', 'NAME', 123)).rejects.toThrow('value must be a string');
        });

        it('should set environment variable', async () => {
            await os.syscall('proc:setenv', 'NEW_VAR', 'new_value');

            const value = await os.syscall<string>('proc:getenv', 'NEW_VAR');

            expect(value).toBe('new_value');
        });

        it('should overwrite existing variable', async () => {
            await os.syscall('proc:setenv', 'EXISTING', 'old');
            await os.syscall('proc:setenv', 'EXISTING', 'new');

            const value = await os.syscall<string>('proc:getenv', 'EXISTING');

            expect(value).toBe('new');
        });
    });

    // =========================================================================
    // activation:get
    // =========================================================================

    describe('activation:get', () => {
        it('should return activation message or null', async () => {
            const activation = await os.syscall('activation:get');

            // WHY: Activation message may or may not be present depending on process context
            // For test process, it should be null
            expect(activation).toBeNull();
        });
    });

    // =========================================================================
    // pool:stats
    // =========================================================================

    describe('pool:stats', () => {
        it('should return pool statistics', async () => {
            const stats = await os.syscall<Array<{ name: string; idle: number; busy: number; total: number; waiting: number }>>('pool:stats');

            expect(Array.isArray(stats)).toBe(true);
            expect(stats.length).toBeGreaterThanOrEqual(0);
        });
    });
});
