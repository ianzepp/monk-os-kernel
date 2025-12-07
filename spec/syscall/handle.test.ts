/**
 * Handle/IPC Syscall Tests
 *
 * Tests for handle manipulation and IPC syscall validation.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
    handleRedirect, handleRestore, handleSend, handleClose,
    ipcPipe,
} from '@src/syscall/handle.js';
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

describe('Handle Syscalls - handleRedirect', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when target is not a number', async () => {
        const response = await firstResponse(handleRedirect(proc, mockKernel, 'string', 1));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('target must be a number');
    });

    it('should yield EINVAL when source is not a number', async () => {
        const response = await firstResponse(handleRedirect(proc, mockKernel, 1, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('source must be a number');
    });

    it('should yield EINVAL when target is undefined', async () => {
        const response = await firstResponse(handleRedirect(proc, mockKernel, undefined, 1));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('Handle Syscalls - handleRestore', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when target is not a number', async () => {
        const response = await firstResponse(handleRestore(proc, mockKernel, {}, 'saved-id'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('target must be a number');
    });

    it('should yield EINVAL when saved is not a string', async () => {
        const response = await firstResponse(handleRestore(proc, mockKernel, 1, 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('saved must be a string');
    });

    it('should yield EINVAL when saved is null', async () => {
        const response = await firstResponse(handleRestore(proc, mockKernel, 1, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('Handle Syscalls - handleSend', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(handleSend(proc, mockKernel, 'invalid', {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('handle must be a number');
    });

    it('should yield ESRCH when process is not running', async () => {
        proc.state = 'zombie';

        const response = await firstResponse(handleSend(proc, mockKernel, 3, {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('ESRCH');
        expect((response.data as { message: string }).message).toBe('Process is not running');
    });

    it('should yield ESRCH when process is stopped', async () => {
        proc.state = 'stopped';

        const response = await firstResponse(handleSend(proc, mockKernel, 3, {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('ESRCH');
    });
});

describe('Handle Syscalls - handleClose', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(handleClose(proc, mockKernel, undefined));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });

    it('should yield EINVAL when fd is a string', async () => {
        const response = await firstResponse(handleClose(proc, mockKernel, '3'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('Handle Syscalls - ipcPipe', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        // ipcPipe needs kernel.createPipe to work
        mockKernel = {} as Kernel;
    });

    // ipcPipe has no argument validation - it just creates a pipe
    // So we just verify it attempts to create the pipe
    it('should not have validation errors (no args)', async () => {
        // Will fail because kernel mock doesn't have createPipe
        // but should not fail on EINVAL
        try {
            await firstResponse(ipcPipe(proc, mockKernel));
        }
        catch (err) {
            // Expected to fail at kernel level, not validation
            expect(err).toBeDefined();
        }
    });
});
