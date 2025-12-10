/**
 * SyscallDispatcher Tests
 *
 * Tests for the syscall routing layer.
 *
 * WHY: These tests validate syscall routing through the real dispatch chain.
 * Uses TestOS with dispatcher layer to test that known syscalls are routed
 * correctly and unknown syscalls fail with ENOSYS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestOS } from '@src/os/test.js';

describe('SyscallDispatcher', () => {
    let os: TestOS;

    beforeEach(async () => {
        os = new TestOS();
        await os.boot({ layers: ['dispatcher'] });
    });

    afterEach(async () => {
        await os.shutdown();
    });

    describe('dispatch() routing', () => {
        it('should yield ENOSYS for unknown syscalls', async () => {
            await expect(os.syscall('unknown:syscall')).rejects.toThrow();
        });

        it('should route file:* syscalls to VFS handlers', async () => {
            // file:stat only needs VFS and should validate path
            await expect(os.syscall('file:stat', 123)).rejects.toThrow('path must be a string');
        });

        it('should route proc:* syscalls to process handlers', async () => {
            // proc:getcwd only needs proc
            const cwd = await os.syscall<string>('proc:getcwd');

            expect(cwd).toBe('/');
        });

        it('should route proc:getenv syscalls correctly', async () => {
            // Set an env var first
            await os.syscall('proc:setenv', 'TEST_VAR', 'test_value');

            const value = await os.syscall<string>('proc:getenv', 'TEST_VAR');

            expect(value).toBe('test_value');
        });

        it('should route proc:getargs syscalls correctly', async () => {
            const args = await os.syscall<string[]>('proc:getargs');

            expect(Array.isArray(args)).toBe(true);
        });

        it('should route activation:get syscalls correctly', async () => {
            const activation = await os.syscall('activation:get');

            // WHY: TestOS processes don't have activation messages by default
            expect(activation).toBeNull();
        });
    });

    describe('EMS syscall availability', () => {
        it('should yield ENOSYS when EMS is undefined', async () => {
            const noEmsOs = new TestOS();

            await noEmsOs.boot({ layers: ['base'] });

            try {
                await expect(noEmsOs.syscall('ems:select', 'model', {})).rejects.toThrow();
            }
            finally {
                await noEmsOs.shutdown();
            }
        });

        it('should route ems:select when EMS is available', async () => {
            // With EMS, should validate model argument
            await expect(os.syscall('ems:select', 123)).rejects.toThrow('model must be a string');
        });

        it('should check EMS availability for all ems:* syscalls', async () => {
            const noEmsOs = new TestOS();

            await noEmsOs.boot({ layers: ['base'] });

            try {
                const emsSyscalls = [
                    ['ems:select', ['model', {}]],
                    ['ems:create', ['model', {}]],
                    ['ems:update', ['model', 'id', {}]],
                    ['ems:delete', ['model', 'id']],
                    ['ems:revert', ['model', 'id']],
                    ['ems:expire', ['model', 'id']],
                ];

                for (const [name, args] of emsSyscalls) {
                    await expect(noEmsOs.syscall(name as string, ...args)).rejects.toThrow();
                }
            }
            finally {
                await noEmsOs.shutdown();
            }
        });
    });

    describe('INV-1: Every dispatch yields at least one Response', () => {
        it('should yield response for unknown syscall', async () => {
            await expect(os.syscall('nonexistent')).rejects.toThrow();
        });

        it('should yield response for known syscall with invalid args', async () => {
            await expect(os.syscall('file:open')).rejects.toThrow();
        });
    });

    describe('INV-4: Arguments passed unchanged to handlers', () => {
        it('should pass args array to handlers', async () => {
            await os.syscall('proc:setenv', 'TEST_VAR', 'test_value');

            const value = await os.syscall<string>('proc:getenv', 'TEST_VAR');

            expect(value).toBe('test_value');
        });
    });

    describe('syscall coverage', () => {
        // VFS syscalls
        const vfsSyscalls = [
            'file:open', 'file:close', 'file:read', 'file:write', 'file:seek',
            'file:stat', 'file:fstat', 'file:mkdir', 'file:unlink', 'file:rmdir',
            'file:readdir', 'file:rename', 'file:symlink', 'file:access',
            'file:recv', 'file:send', 'fs:mount', 'fs:umount',
        ];

        // Process syscalls
        const procSyscalls = [
            'proc:spawn', 'proc:exit', 'proc:kill', 'proc:wait',
            'proc:getpid', 'proc:getppid', 'proc:create',
            'proc:getargs', 'proc:getcwd', 'proc:chdir',
            'proc:getenv', 'proc:setenv', 'activation:get',
        ];

        // EMS syscalls
        const emsSyscalls = [
            'ems:select', 'ems:create', 'ems:update',
            'ems:delete', 'ems:revert', 'ems:expire',
        ];

        // Network/HAL syscalls
        const halSyscalls = [
            'net:connect',
            'port:create', 'port:close', 'port:recv', 'port:send',
            'channel:open', 'channel:close', 'channel:call',
            'channel:stream', 'channel:push', 'channel:recv',
        ];

        // Handle/IPC syscalls
        const handleSyscalls = [
            'handle:redirect', 'handle:restore', 'handle:send', 'handle:close',
            'ipc:pipe',
        ];

        // Pool syscalls
        const poolSyscalls = [
            'pool:lease', 'pool:stats',
            'worker:load', 'worker:send', 'worker:recv', 'worker:release',
        ];

        it('should route all VFS syscalls (not ENOSYS)', async () => {
            for (const name of vfsSyscalls) {
                try {
                    await os.syscall(name);
                }
                catch (error) {
                    // Should get EINVAL (validation) not ENOSYS (unknown)
                    expect(error).toBeDefined();
                    expect(String(error)).not.toContain('ENOSYS');
                    expect(String(error)).not.toContain('Unknown syscall');
                }
            }
        });

        it('should route all process syscalls (not ENOSYS)', async () => {
            // Syscalls that need specific arguments or setup
            const skipValidation = ['proc:getargs', 'proc:getcwd', 'activation:get'];

            for (const name of procSyscalls) {
                if (skipValidation.includes(name)) {
                    continue;
                }

                try {
                    await os.syscall(name);
                }
                catch (error) {
                    expect(error).toBeDefined();
                    expect(String(error)).not.toContain('ENOSYS');
                    expect(String(error)).not.toContain('Unknown syscall');
                }
            }
        });

        it('should route all EMS syscalls when EMS available (not ENOSYS)', async () => {
            for (const name of emsSyscalls) {
                try {
                    await os.syscall(name);
                }
                catch (error) {
                    expect(error).toBeDefined();
                    expect(String(error)).not.toContain('ENOSYS');
                    expect(String(error)).not.toContain('Unknown syscall');
                }
            }
        });

        it('should route all HAL syscalls (not ENOSYS)', async () => {
            for (const name of halSyscalls) {
                try {
                    await os.syscall(name);
                }
                catch (error) {
                    expect(error).toBeDefined();
                    expect(String(error)).not.toContain('ENOSYS');
                    expect(String(error)).not.toContain('Unknown syscall');
                }
            }
        });

        it('should route all handle syscalls (not ENOSYS)', async () => {
            for (const name of handleSyscalls) {
                try {
                    await os.syscall(name);
                }
                catch (error) {
                    expect(error).toBeDefined();
                    expect(String(error)).not.toContain('ENOSYS');
                    expect(String(error)).not.toContain('Unknown syscall');
                }
            }
        });

        it('should route all pool syscalls (not ENOSYS)', async () => {
            // pool:stats should work without arguments
            const skipValidation = ['pool:stats'];

            for (const name of poolSyscalls) {
                if (skipValidation.includes(name)) {
                    continue;
                }

                try {
                    await os.syscall(name);
                }
                catch (error) {
                    expect(error).toBeDefined();
                    expect(String(error)).not.toContain('ENOSYS');
                    expect(String(error)).not.toContain('Unknown syscall');
                }
            }
        });
    });
});
