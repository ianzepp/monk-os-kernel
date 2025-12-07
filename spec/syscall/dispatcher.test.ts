/**
 * SyscallDispatcher Tests
 *
 * Tests for the syscall routing layer.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SyscallDispatcher } from '@src/syscall/dispatcher.js';
import type { Process } from '@src/kernel/types.js';
import type { Kernel } from '@src/kernel/kernel.js';
import type { VFS } from '@src/vfs/vfs.js';
import type { EMS } from '@src/ems/ems.js';
import type { HAL } from '@src/hal/index.js';
import type { Response } from '@src/message.js';

/**
 * Create a mock process for testing.
 */
function createMockProcess(overrides: Partial<Process> = {}): Process {
    return {
        id: crypto.randomUUID(),
        parent: '',
        user: 'test',
        worker: {} as Worker,
        virtual: false,
        state: 'running',
        cmd: '/bin/test',
        cwd: '/home/test',
        env: { HOME: '/home/test', PATH: '/bin' },
        args: [],
        pathDirs: new Map([['00-bin', '/bin']]),
        handles: new Map(),
        nextHandle: 3,
        children: new Map(),
        nextPid: 1,
        activeStreams: new Map(),
        streamPingHandlers: new Map(),
        ...overrides,
    };
}

/**
 * Create minimal mock dependencies.
 */
function createMockDeps() {
    const mockKernel = {
        processes: {
            get: mock(() => undefined),
            all: mock(() => []),
        },
        vfs: {},
        poolManager: {
            stats: mock(() => ({ pools: {} })),
        },
    } as unknown as Kernel;

    const mockVfs = {
        stat: mock(() => Promise.resolve({})),
        mkdir: mock(() => Promise.resolve()),
        unlink: mock(() => Promise.resolve()),
        symlink: mock(() => Promise.resolve()),
        access: mock(() => Promise.resolve(null)),
        setAccess: mock(() => Promise.resolve()),
        readdir: mock(() => (async function* () { /* empty */ })()),
    } as unknown as VFS;

    const mockEms = {
        ops: {
            selectAny: mock(() => (async function* () { /* empty */ })()),
            createAll: mock(() => (async function* () { /* empty */ })()),
            updateAll: mock(() => (async function* () { /* empty */ })()),
            deleteIds: mock(() => (async function* () { /* empty */ })()),
            revertAll: mock(() => (async function* () { /* empty */ })()),
            expireAll: mock(() => (async function* () { /* empty */ })()),
        },
    } as unknown as EMS;

    const mockHal = {} as HAL;

    return { mockKernel, mockVfs, mockEms, mockHal };
}

/**
 * Collect all responses from a dispatch.
 */
async function collectResponses(
    dispatcher: SyscallDispatcher,
    proc: Process,
    name: string,
    args: unknown[],
): Promise<Response[]> {
    const responses: Response[] = [];

    for await (const response of dispatcher.dispatch(proc, name, args)) {
        responses.push(response);
    }

    return responses;
}

/**
 * Get first response from a dispatch.
 */
async function firstResponse(
    dispatcher: SyscallDispatcher,
    proc: Process,
    name: string,
    args: unknown[],
): Promise<Response> {
    for await (const response of dispatcher.dispatch(proc, name, args)) {
        return response;
    }

    throw new Error('No response received');
}

describe('SyscallDispatcher', () => {
    let dispatcher: SyscallDispatcher;
    let mockKernel: Kernel;
    let mockVfs: VFS;
    let mockEms: EMS;
    let mockHal: HAL;
    let proc: Process;

    beforeEach(() => {
        const mocks = createMockDeps();

        mockKernel = mocks.mockKernel;
        mockVfs = mocks.mockVfs;
        mockEms = mocks.mockEms;
        mockHal = mocks.mockHal;

        dispatcher = new SyscallDispatcher(mockKernel, mockVfs, mockEms, mockHal);
        proc = createMockProcess();
    });

    describe('dispatch() routing', () => {
        it('should yield ENOSYS for unknown syscalls', async () => {
            const response = await firstResponse(dispatcher, proc, 'unknown:syscall', []);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('ENOSYS');
            expect((response.data as { message: string }).message).toContain('Unknown syscall');
        });

        it('should route file:* syscalls to VFS handlers', async () => {
            // file:stat only needs VFS and should validate path
            const response = await firstResponse(dispatcher, proc, 'file:stat', [123]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
        });

        it('should route proc:* syscalls to process handlers', async () => {
            // proc:getcwd only needs proc
            const response = await firstResponse(dispatcher, proc, 'proc:getcwd', []);

            expect(response.op).toBe('ok');
            expect(response.data).toBe('/home/test');
        });

        it('should route proc:getenv syscalls correctly', async () => {
            const response = await firstResponse(dispatcher, proc, 'proc:getenv', ['HOME']);

            expect(response.op).toBe('ok');
            expect(response.data).toBe('/home/test');
        });

        it('should route proc:getargs syscalls correctly', async () => {
            proc.args = ['arg1', 'arg2'];
            const response = await firstResponse(dispatcher, proc, 'proc:getargs', []);

            expect(response.op).toBe('ok');
            expect(response.data).toEqual(['arg1', 'arg2']);
        });

        it('should route activation:get syscalls correctly', async () => {
            proc.activationMessage = { op: 'test', data: 'payload' };
            const response = await firstResponse(dispatcher, proc, 'activation:get', []);

            expect(response.op).toBe('ok');
            expect(response.data).toEqual({ op: 'test', data: 'payload' });
        });
    });

    describe('EMS syscall availability', () => {
        it('should yield ENOSYS when EMS is undefined', async () => {
            const noEmsDispatcher = new SyscallDispatcher(mockKernel, mockVfs, undefined, mockHal);

            const response = await firstResponse(noEmsDispatcher, proc, 'ems:select', ['model', {}]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('ENOSYS');
            expect((response.data as { message: string }).message).toBe('EMS not available');
        });

        it('should route ems:select when EMS is available', async () => {
            // With mock EMS, should validate model argument
            const response = await firstResponse(dispatcher, proc, 'ems:select', [123]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
        });

        it('should check EMS availability for all ems:* syscalls', async () => {
            const noEmsDispatcher = new SyscallDispatcher(mockKernel, mockVfs, undefined, mockHal);
            const emsSyscalls = [
                ['ems:select', ['model', {}]],
                ['ems:create', ['model', {}]],
                ['ems:update', ['model', 'id', {}]],
                ['ems:delete', ['model', 'id']],
                ['ems:revert', ['model', 'id']],
                ['ems:expire', ['model', 'id']],
            ];

            for (const [name, args] of emsSyscalls) {
                const response = await firstResponse(noEmsDispatcher, proc, name as string, args as unknown[]);

                expect(response.op).toBe('error');
                expect((response.data as { code: string }).code).toBe('ENOSYS');
            }
        });
    });

    describe('INV-1: Every dispatch yields at least one Response', () => {
        it('should yield response for unknown syscall', async () => {
            const responses = await collectResponses(dispatcher, proc, 'nonexistent', []);

            expect(responses.length).toBeGreaterThanOrEqual(1);
        });

        it('should yield response for known syscall with invalid args', async () => {
            const responses = await collectResponses(dispatcher, proc, 'file:open', []);

            expect(responses.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('INV-4: Arguments passed unchanged to handlers', () => {
        it('should pass args array to handlers', async () => {
            // proc:setenv expects [name, value]
            const response = await firstResponse(dispatcher, proc, 'proc:setenv', ['TEST_VAR', 'test_value']);

            expect(response.op).toBe('ok');
            expect(proc.env['TEST_VAR']).toBe('test_value');
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
                const response = await firstResponse(dispatcher, proc, name, []);

                // Should get EINVAL (validation) not ENOSYS (unknown)
                if (response.op === 'error') {
                    expect((response.data as { code: string }).code).not.toBe('ENOSYS');
                }
            }
        });

        it('should route all process syscalls (not ENOSYS)', async () => {
            // Syscalls that need full kernel implementation are tested separately
            const requiresKernelIntegration = ['proc:spawn', 'proc:exit', 'proc:kill', 'proc:wait', 'proc:create'];

            for (const name of procSyscalls) {
                if (requiresKernelIntegration.includes(name)) {
                    continue; // Skip syscalls that need full kernel
                }

                const response = await firstResponse(dispatcher, proc, name, []);

                if (response.op === 'error') {
                    expect((response.data as { code: string }).code).not.toBe('ENOSYS');
                }
            }
        });

        it('should route all EMS syscalls when EMS available (not ENOSYS)', async () => {
            for (const name of emsSyscalls) {
                const response = await firstResponse(dispatcher, proc, name, []);

                if (response.op === 'error') {
                    expect((response.data as { code: string }).code).not.toBe('ENOSYS');
                }
            }
        });

        it('should route all HAL syscalls (not ENOSYS)', async () => {
            for (const name of halSyscalls) {
                const response = await firstResponse(dispatcher, proc, name, []);

                if (response.op === 'error') {
                    expect((response.data as { code: string }).code).not.toBe('ENOSYS');
                }
            }
        });

        it('should route all handle syscalls (not ENOSYS)', async () => {
            // ipc:pipe needs kernel.hal.entropy
            const requiresKernelIntegration = ['ipc:pipe'];

            for (const name of handleSyscalls) {
                if (requiresKernelIntegration.includes(name)) {
                    continue;
                }

                const response = await firstResponse(dispatcher, proc, name, []);

                if (response.op === 'error') {
                    expect((response.data as { code: string }).code).not.toBe('ENOSYS');
                }
            }
        });

        it('should route all pool syscalls (not ENOSYS)', async () => {
            // pool:lease needs kernel.poolManager, pool:stats works with mock
            const requiresKernelIntegration = ['pool:lease', 'worker:load', 'worker:send', 'worker:recv', 'worker:release'];

            for (const name of poolSyscalls) {
                if (requiresKernelIntegration.includes(name)) {
                    continue;
                }

                const response = await firstResponse(dispatcher, proc, name, []);

                if (response.op === 'error') {
                    expect((response.data as { code: string }).code).not.toBe('ENOSYS');
                }
            }
        });
    });
});
