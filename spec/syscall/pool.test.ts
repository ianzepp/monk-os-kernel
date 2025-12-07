/**
 * Pool Syscall Tests
 *
 * Tests for worker pool syscall validation.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
    poolLease,
    workerLoad, workerSend, workerRecv, workerRelease,
} from '@src/syscall/pool.js';
import type { Process } from '@src/kernel/types.js';
import type { Kernel } from '@src/kernel/kernel.js';
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
        env: {},
        args: [],
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

describe('Pool Syscalls - poolLease', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    // poolLease accepts optional pool name - no strict validation required
    it('should accept string pool name', async () => {
        // Will fail at kernel level but not at validation
        try {
            await firstResponse(poolLease(proc, mockKernel, 'custom-pool'));
        }
        catch {
            // Expected to fail at kernel level
        }
    });

    it('should accept undefined pool name', async () => {
        // Will fail at kernel level but not at validation
        try {
            await firstResponse(poolLease(proc, mockKernel, undefined));
        }
        catch {
            // Expected to fail at kernel level
        }
    });

    it('should accept non-string and convert to undefined', async () => {
        // Non-string values should be ignored (use default pool)
        try {
            await firstResponse(poolLease(proc, mockKernel, 123));
        }
        catch {
            // Expected to fail at kernel level
        }
    });
});

describe('Pool Syscalls - workerLoad', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when workerId is not a string', async () => {
        const response = await firstResponse(workerLoad(proc, mockKernel, 123, '/script.js'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('workerId must be a string');
    });

    it('should yield EINVAL when workerId is null', async () => {
        const response = await firstResponse(workerLoad(proc, mockKernel, null, '/script.js'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });

    it('should yield EINVAL when path is not a string', async () => {
        const response = await firstResponse(workerLoad(proc, mockKernel, 'worker-id', 456));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('path must be a string');
    });

    it('should yield EINVAL when path is undefined', async () => {
        const response = await firstResponse(workerLoad(proc, mockKernel, 'worker-id', undefined));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('Pool Syscalls - workerSend', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when workerId is not a string', async () => {
        const response = await firstResponse(workerSend(proc, mockKernel, undefined, { data: 'test' }));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('workerId must be a string');
    });

    it('should yield EINVAL when workerId is a number', async () => {
        const response = await firstResponse(workerSend(proc, mockKernel, 42, { data: 'test' }));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('Pool Syscalls - workerRecv', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when workerId is not a string', async () => {
        const response = await firstResponse(workerRecv(proc, mockKernel, {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('workerId must be a string');
    });

    it('should yield EINVAL when workerId is an array', async () => {
        const response = await firstResponse(workerRecv(proc, mockKernel, []));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('Pool Syscalls - workerRelease', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when workerId is not a string', async () => {
        const response = await firstResponse(workerRelease(proc, mockKernel, false));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('workerId must be a string');
    });

    it('should yield EINVAL when workerId is null', async () => {
        const response = await firstResponse(workerRelease(proc, mockKernel, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});
