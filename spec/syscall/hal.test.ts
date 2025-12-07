/**
 * HAL Syscall Tests
 *
 * Tests for network and channel syscall validation.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
    netConnect,
    portCreate, portClose, portRecv, portSend,
    channelOpen, channelClose, channelCall,
    channelStream, channelPush, channelRecv,
} from '@src/syscall/hal.js';
import type { Process } from '@src/kernel/types.js';
import type { Kernel } from '@src/kernel/kernel.js';
import type { HAL } from '@src/hal/index.js';
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

describe('HAL Syscalls - netConnect', () => {
    let proc: Process;
    let mockKernel: Kernel;
    let mockHal: HAL;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
        mockHal = {} as HAL;
    });

    it('should yield EINVAL when proto is not a string', async () => {
        const response = await firstResponse(netConnect(proc, mockKernel, mockHal, 123, 'localhost', 80));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('proto must be a string');
    });

    it('should yield EINVAL when host is not a string', async () => {
        const response = await firstResponse(netConnect(proc, mockKernel, mockHal, 'tcp', null, 80));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('host must be a string');
    });

    it('should yield EINVAL when port is not a number for tcp', async () => {
        const response = await firstResponse(netConnect(proc, mockKernel, mockHal, 'tcp', 'localhost', 'invalid'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('port must be a number');
    });

    it('should yield EINVAL for unsupported protocol', async () => {
        const response = await firstResponse(netConnect(proc, mockKernel, mockHal, 'invalid', 'localhost', 80));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toContain('unsupported protocol');
    });
});

describe('HAL Syscalls - portCreate', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when type is not a string', async () => {
        const response = await firstResponse(portCreate(proc, mockKernel, 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('type must be a string');
    });

    it('should yield EINVAL when type is null', async () => {
        const response = await firstResponse(portCreate(proc, mockKernel, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('HAL Syscalls - portClose', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(portClose(proc, mockKernel, 'invalid'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('HAL Syscalls - portRecv', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(portRecv(proc, mockKernel, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('HAL Syscalls - portSend', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(portSend(proc, mockKernel, 'invalid', 'addr', new Uint8Array()));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });

    it('should yield EINVAL when to is not a string', async () => {
        const response = await firstResponse(portSend(proc, mockKernel, 5, null, new Uint8Array()));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('to must be a string');
    });

    it('should yield EINVAL when data is not Uint8Array', async () => {
        const response = await firstResponse(portSend(proc, mockKernel, 5, 'addr', 'string data'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('data must be Uint8Array');
    });
});

describe('HAL Syscalls - channelOpen', () => {
    let proc: Process;
    let mockKernel: Kernel;
    let mockHal: HAL;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
        mockHal = {} as HAL;
    });

    it('should yield EINVAL when proto is not a string', async () => {
        const response = await firstResponse(channelOpen(proc, mockKernel, mockHal, 123, 'http://test'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('proto must be a string');
    });

    it('should yield EINVAL when url is not a string', async () => {
        const response = await firstResponse(channelOpen(proc, mockKernel, mockHal, 'http', null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('url must be a string');
    });
});

describe('HAL Syscalls - channelClose', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(channelClose(proc, mockKernel, {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('HAL Syscalls - channelCall', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(channelCall(proc, mockKernel, 'string', {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('HAL Syscalls - channelStream', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(channelStream(proc, mockKernel, undefined, {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('HAL Syscalls - channelPush', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(channelPush(proc, mockKernel, [], {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('HAL Syscalls - channelRecv', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(channelRecv(proc, mockKernel, false));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});
