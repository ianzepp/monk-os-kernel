/**
 * Process Syscall Tests
 *
 * Tests for process lifecycle and environment syscall validation.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
    procSpawn, procExit, procKill, procWait,
    procGetpid, procGetppid, procCreate,
    procGetargs, procGetcwd, procChdir,
    procGetenv, procSetenv, activationGet, poolStats,
} from '@src/syscall/process.js';
import type { Process } from '@src/kernel/types.js';
import type { Kernel } from '@src/kernel/kernel.js';
import type { VFS } from '@src/vfs/vfs.js';
import type { Response } from '@src/message.js';

/**
 * Create a mock process for testing.
 */
function createMockProcess(overrides: Partial<Process> = {}): Process {
    return {
        id: 'test-proc-id',
        parent: 'parent-id',
        user: 'test',
        worker: {} as Worker,
        virtual: false,
        state: 'running',
        cmd: '/bin/test',
        cwd: '/home/test',
        env: { HOME: '/home/test', PATH: '/bin' },
        args: ['arg1', 'arg2'],
        pathDirs: new Map(),
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
 * Get first response from an async iterable.
 */
async function firstResponse(iterable: AsyncIterable<Response>): Promise<Response> {
    for await (const response of iterable) {
        return response;
    }

    throw new Error('No response received');
}

describe('Process Syscalls - procSpawn', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when entry is not a string', async () => {
        const response = await firstResponse(procSpawn(proc, mockKernel, 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('entry must be a string');
    });

    it('should yield EINVAL when entry is null', async () => {
        const response = await firstResponse(procSpawn(proc, mockKernel, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('Process Syscalls - procExit', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when code is not a number', async () => {
        const response = await firstResponse(procExit(proc, mockKernel, 'string'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('code must be a non-negative number');
    });

    it('should yield EINVAL when code is negative', async () => {
        const response = await firstResponse(procExit(proc, mockKernel, -1));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('Process Syscalls - procKill', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when targetPid is not a number', async () => {
        const response = await firstResponse(procKill(proc, mockKernel, 'string'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('pid must be a positive number');
    });

    it('should yield EINVAL when targetPid is zero', async () => {
        const response = await firstResponse(procKill(proc, mockKernel, 0));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });

    it('should yield EINVAL when targetPid is negative', async () => {
        const response = await firstResponse(procKill(proc, mockKernel, -5));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('Process Syscalls - procWait', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when targetPid is not a number', async () => {
        const response = await firstResponse(procWait(proc, mockKernel, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('pid must be a positive number');
    });

    it('should yield EINVAL when targetPid is zero', async () => {
        const response = await firstResponse(procWait(proc, mockKernel, 0));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('Process Syscalls - procGetpid', () => {
    // Note: procGetpid requires full kernel implementation (processes.get)
    // For unit testing, we just verify the syscall attempts to call getpid
    // Full integration tests are in spec/kernel/
    it('should attempt to get process ID via kernel function', async () => {
        const proc = createMockProcess({ id: 'test-pid-123', parent: '' });

        // Mock kernel with processes.get that returns undefined for no parent (init process)
        const mockKernel = {
            processes: {
                get: mock(() => undefined),
            },
        } as unknown as Kernel;

        // For init process (empty parent), getpid returns 1
        const response = await firstResponse(procGetpid(proc, mockKernel));

        expect(response.op).toBe('ok');
        expect(response.data).toBe(1); // Init is always PID 1
    });
});

describe('Process Syscalls - procGetppid', () => {
    // Note: procGetppid requires full kernel implementation
    // For init process (no parent), returns 0
    it('should return 0 for init process (no parent)', async () => {
        const proc = createMockProcess({ parent: '' });

        const mockKernel = {
            processes: {
                get: mock(() => undefined),
            },
        } as unknown as Kernel;

        const response = await firstResponse(procGetppid(proc, mockKernel));

        expect(response.op).toBe('ok');
        expect(response.data).toBe(0); // Init has no parent, returns 0
    });
});

describe('Process Syscalls - procCreate', () => {
    // Note: procCreate requires full kernel implementation (hal.entropy, processes, etc.)
    // This is an integration test - for unit test coverage, we just verify the function signature
    // Full integration tests are in spec/kernel/
    it.skip('should create virtual process via kernel function (requires full kernel)', async () => {
        // Skipped: requires full kernel integration
    });
});

describe('Process Syscalls - procGetargs', () => {
    it('should return process arguments', async () => {
        const proc = createMockProcess({ args: ['--verbose', 'file.txt'] });

        const response = await firstResponse(procGetargs(proc));

        expect(response.op).toBe('ok');
        expect(response.data).toEqual(['--verbose', 'file.txt']);
    });

    it('should return empty array when no args', async () => {
        const proc = createMockProcess({ args: [] });

        const response = await firstResponse(procGetargs(proc));

        expect(response.op).toBe('ok');
        expect(response.data).toEqual([]);
    });
});

describe('Process Syscalls - procGetcwd', () => {
    it('should return current working directory', async () => {
        const proc = createMockProcess({ cwd: '/home/alice/projects' });

        const response = await firstResponse(procGetcwd(proc));

        expect(response.op).toBe('ok');
        expect(response.data).toBe('/home/alice/projects');
    });
});

describe('Process Syscalls - procChdir', () => {
    let proc: Process;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess({ cwd: '/home/test' });
        mockVfs = {
            stat: mock(() => Promise.resolve({
                id: 'dir-id',
                model: 'folder',
                name: 'target',
                parent: null,
                owner: 'test',
                size: 0,
                mtime: Date.now(),
                ctime: Date.now(),
            })),
        } as unknown as VFS;
    });

    it('should yield EINVAL when path is not a string', async () => {
        const response = await firstResponse(procChdir(proc, mockVfs, 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('path must be a string');
    });

    it('should change cwd on success', async () => {
        const response = await firstResponse(procChdir(proc, mockVfs, '/new/dir'));

        expect(response.op).toBe('ok');
        expect(proc.cwd).toBe('/new/dir');
    });

    it('should resolve relative paths', async () => {
        proc.cwd = '/home/test';

        await firstResponse(procChdir(proc, mockVfs, 'subdir'));

        expect(proc.cwd).toBe('/home/test/subdir');
    });

    it('should resolve .. paths', async () => {
        proc.cwd = '/home/test/deep/nested';

        await firstResponse(procChdir(proc, mockVfs, '../..'));

        expect(proc.cwd).toBe('/home/test');
    });

    it('should yield ENOTDIR when path is a file', async () => {
        mockVfs.stat = mock(() => Promise.resolve({
            id: 'file-id',
            model: 'file',
            name: 'notadir',
            parent: null,
            owner: 'test',
            size: 100,
            mtime: Date.now(),
            ctime: Date.now(),
        }));

        const response = await firstResponse(procChdir(proc, mockVfs, '/file.txt'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('ENOTDIR');
    });

    it('should yield ENOENT when path does not exist', async () => {
        mockVfs.stat = mock(() => Promise.reject({ code: 'ENOENT', message: 'Not found' }));

        const response = await firstResponse(procChdir(proc, mockVfs, '/nonexistent'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('ENOENT');
    });
});

describe('Process Syscalls - procGetenv', () => {
    it('should yield EINVAL when name is not a string', async () => {
        const proc = createMockProcess();

        const response = await firstResponse(procGetenv(proc, 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('name must be a string');
    });

    it('should return environment variable value', async () => {
        const proc = createMockProcess({ env: { MY_VAR: 'my_value' } });

        const response = await firstResponse(procGetenv(proc, 'MY_VAR'));

        expect(response.op).toBe('ok');
        expect(response.data).toBe('my_value');
    });

    it('should return undefined for missing variable', async () => {
        const proc = createMockProcess({ env: {} });

        const response = await firstResponse(procGetenv(proc, 'MISSING'));

        expect(response.op).toBe('ok');
        expect(response.data).toBeUndefined();
    });
});

describe('Process Syscalls - procSetenv', () => {
    it('should yield EINVAL when name is not a string', async () => {
        const proc = createMockProcess();

        const response = await firstResponse(procSetenv(proc, null, 'value'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('name must be a string');
    });

    it('should yield EINVAL when value is not a string', async () => {
        const proc = createMockProcess();

        const response = await firstResponse(procSetenv(proc, 'NAME', 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('value must be a string');
    });

    it('should set environment variable', async () => {
        const proc = createMockProcess({ env: {} });

        const response = await firstResponse(procSetenv(proc, 'NEW_VAR', 'new_value'));

        expect(response.op).toBe('ok');
        expect(proc.env['NEW_VAR']).toBe('new_value');
    });

    it('should overwrite existing variable', async () => {
        const proc = createMockProcess({ env: { EXISTING: 'old' } });

        const response = await firstResponse(procSetenv(proc, 'EXISTING', 'new'));

        expect(response.op).toBe('ok');
        expect(proc.env['EXISTING']).toBe('new');
    });
});

describe('Process Syscalls - activationGet', () => {
    it('should return activation message when present', async () => {
        const proc = createMockProcess({
            activationMessage: { op: 'http', data: { method: 'GET', path: '/' } },
        });

        const response = await firstResponse(activationGet(proc));

        expect(response.op).toBe('ok');
        expect(response.data).toEqual({ op: 'http', data: { method: 'GET', path: '/' } });
    });

    it('should return null when no activation message', async () => {
        const proc = createMockProcess({ activationMessage: undefined });

        const response = await firstResponse(activationGet(proc));

        expect(response.op).toBe('ok');
        expect(response.data).toBeNull();
    });
});

describe('Process Syscalls - poolStats', () => {
    it('should return pool statistics', async () => {
        const mockKernel = {
            poolManager: {
                stats: mock(() => ({
                    pools: {
                        freelance: { available: 5, busy: 2, total: 7 },
                    },
                })),
            },
        } as unknown as Kernel;

        const response = await firstResponse(poolStats(mockKernel));

        expect(response.op).toBe('ok');
        expect((response.data as { pools: Record<string, unknown> }).pools).toHaveProperty('freelance');
    });
});
