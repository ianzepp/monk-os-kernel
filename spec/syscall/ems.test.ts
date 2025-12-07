/**
 * EMS Syscall Tests
 *
 * Tests for Entity Management System syscall validation.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
    emsSelect, emsCreate, emsUpdate,
    emsDelete, emsRevert, emsExpire,
} from '@src/syscall/ems.js';
import type { Process } from '@src/kernel/types.js';
import type { EMS } from '@src/ems/ems.js';
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

/**
 * Collect all responses from an async iterable.
 */
async function collectResponses(iterable: AsyncIterable<Response>): Promise<Response[]> {
    const responses: Response[] = [];

    for await (const response of iterable) {
        responses.push(response);
    }

    return responses;
}

describe('EMS Syscalls - emsSelect', () => {
    let proc: Process;
    let mockEms: EMS;

    beforeEach(() => {
        proc = createMockProcess();
        mockEms = {
            ops: {
                selectAny: mock(() => (async function* () {
                    yield { id: '1', name: 'entity1' };
                    yield { id: '2', name: 'entity2' };
                })()),
            },
        } as unknown as EMS;
    });

    it('should yield EINVAL when model is not a string', async () => {
        const response = await firstResponse(emsSelect(proc, mockEms, 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('model must be a string');
    });

    it('should yield EINVAL when model is null', async () => {
        const response = await firstResponse(emsSelect(proc, mockEms, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });

    it('should stream entities as items', async () => {
        const responses = await collectResponses(emsSelect(proc, mockEms, 'user', {}));

        expect(responses.length).toBe(3);
        expect(responses[0]!.op).toBe('item');
        expect(responses[0]!.data).toEqual({ id: '1', name: 'entity1' });
        expect(responses[1]!.op).toBe('item');
        expect(responses[1]!.data).toEqual({ id: '2', name: 'entity2' });
        expect(responses[2]!.op).toBe('done');
    });

    it('should handle empty filter', async () => {
        const responses = await collectResponses(emsSelect(proc, mockEms, 'user'));

        expect(responses.length).toBe(3);
    });

    it('should pass filter to ops.selectAny', async () => {
        await collectResponses(emsSelect(proc, mockEms, 'user', { where: { active: true } }));

        expect(mockEms.ops.selectAny).toHaveBeenCalledWith('user', { where: { active: true } });
    });

    it('should yield error on exception', async () => {
        mockEms.ops.selectAny = mock(() => (async function* () {
            throw new Error('Database error');
        })());

        const responses = await collectResponses(emsSelect(proc, mockEms, 'user', {}));

        expect(responses.length).toBe(1);
        expect(responses[0]!.op).toBe('error');
        expect((responses[0]!.data as { code: string }).code).toBe('EIO');
    });
});

describe('EMS Syscalls - emsCreate', () => {
    let proc: Process;
    let mockEms: EMS;

    beforeEach(() => {
        proc = createMockProcess();
        mockEms = {
            ops: {
                createAll: mock(() => (async function* () {
                    yield { id: 'new-id', name: 'created' };
                })()),
            },
        } as unknown as EMS;
    });

    it('should yield EINVAL when model is not a string', async () => {
        const response = await firstResponse(emsCreate(proc, mockEms, 123, {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('model must be a string');
    });

    it('should yield EINVAL when fields is not an object', async () => {
        const response = await firstResponse(emsCreate(proc, mockEms, 'user', 'invalid'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fields must be an object');
    });

    it('should yield EINVAL when fields is null', async () => {
        const response = await firstResponse(emsCreate(proc, mockEms, 'user', null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });

    it('should yield ok with created entity', async () => {
        const response = await firstResponse(emsCreate(proc, mockEms, 'user', { name: 'Alice' }));

        expect(response.op).toBe('ok');
        expect((response.data as { id: string }).id).toBe('new-id');
    });

    it('should pass fields to ops.createAll', async () => {
        await firstResponse(emsCreate(proc, mockEms, 'user', { name: 'Bob', email: 'bob@test.com' }));

        expect(mockEms.ops.createAll).toHaveBeenCalledWith('user', [{ name: 'Bob', email: 'bob@test.com' }]);
    });

    it('should yield EIO when no record created', async () => {
        mockEms.ops.createAll = mock(() => (async function* () { /* empty */ })());

        const response = await firstResponse(emsCreate(proc, mockEms, 'user', { name: 'Test' }));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EIO');
    });
});

describe('EMS Syscalls - emsUpdate', () => {
    let proc: Process;
    let mockEms: EMS;

    beforeEach(() => {
        proc = createMockProcess();
        mockEms = {
            ops: {
                updateAll: mock(() => (async function* () {
                    yield { id: 'update-id', name: 'updated' };
                })()),
            },
        } as unknown as EMS;
    });

    it('should yield EINVAL when model is not a string', async () => {
        const response = await firstResponse(emsUpdate(proc, mockEms, null, 'id', {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('model must be a string');
    });

    it('should yield EINVAL when id is not a string', async () => {
        const response = await firstResponse(emsUpdate(proc, mockEms, 'user', 123, {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('id must be a string');
    });

    it('should yield EINVAL when changes is not an object', async () => {
        const response = await firstResponse(emsUpdate(proc, mockEms, 'user', 'id', 'invalid'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('changes must be an object');
    });

    it('should yield ok with updated entity', async () => {
        const response = await firstResponse(emsUpdate(proc, mockEms, 'user', 'entity-id', { name: 'NewName' }));

        expect(response.op).toBe('ok');
    });

    it('should yield ENOENT when entity not found', async () => {
        mockEms.ops.updateAll = mock(() => (async function* () { /* empty */ })());

        const response = await firstResponse(emsUpdate(proc, mockEms, 'user', 'missing-id', { name: 'Test' }));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('ENOENT');
    });
});

describe('EMS Syscalls - emsDelete', () => {
    let proc: Process;
    let mockEms: EMS;

    beforeEach(() => {
        proc = createMockProcess();
        mockEms = {
            ops: {
                deleteIds: mock(() => (async function* () {
                    yield { id: 'deleted-id' };
                })()),
            },
        } as unknown as EMS;
    });

    it('should yield EINVAL when model is not a string', async () => {
        const response = await firstResponse(emsDelete(proc, mockEms, undefined, 'id'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('model must be a string');
    });

    it('should yield EINVAL when id is not a string', async () => {
        const response = await firstResponse(emsDelete(proc, mockEms, 'user', null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('id must be a string');
    });

    it('should yield ok on successful delete', async () => {
        const response = await firstResponse(emsDelete(proc, mockEms, 'user', 'entity-id'));

        expect(response.op).toBe('ok');
    });

    it('should yield ENOENT when entity not found', async () => {
        mockEms.ops.deleteIds = mock(() => (async function* () { /* empty */ })());

        const response = await firstResponse(emsDelete(proc, mockEms, 'user', 'missing-id'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('ENOENT');
    });
});

describe('EMS Syscalls - emsRevert', () => {
    let proc: Process;
    let mockEms: EMS;

    beforeEach(() => {
        proc = createMockProcess();
        mockEms = {
            ops: {
                revertAll: mock(() => (async function* () {
                    yield { id: 'reverted-id' };
                })()),
            },
        } as unknown as EMS;
    });

    it('should yield EINVAL when model is not a string', async () => {
        const response = await firstResponse(emsRevert(proc, mockEms, {}, 'id'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });

    it('should yield EINVAL when id is not a string', async () => {
        const response = await firstResponse(emsRevert(proc, mockEms, 'user', 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });

    it('should yield ok on successful revert', async () => {
        const response = await firstResponse(emsRevert(proc, mockEms, 'user', 'entity-id'));

        expect(response.op).toBe('ok');
    });

    it('should yield ENOENT when entity not found', async () => {
        mockEms.ops.revertAll = mock(() => (async function* () { /* empty */ })());

        const response = await firstResponse(emsRevert(proc, mockEms, 'user', 'missing-id'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('ENOENT');
    });
});

describe('EMS Syscalls - emsExpire', () => {
    let proc: Process;
    let mockEms: EMS;

    beforeEach(() => {
        proc = createMockProcess();
        mockEms = {
            ops: {
                expireAll: mock(() => (async function* () {
                    yield { id: 'expired-id' };
                })()),
            },
        } as unknown as EMS;
    });

    it('should yield EINVAL when model is not a string', async () => {
        const response = await firstResponse(emsExpire(proc, mockEms, [], 'id'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });

    it('should yield EINVAL when id is not a string', async () => {
        const response = await firstResponse(emsExpire(proc, mockEms, 'user', undefined));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });

    it('should yield ok on successful expire', async () => {
        const response = await firstResponse(emsExpire(proc, mockEms, 'user', 'entity-id'));

        expect(response.op).toBe('ok');
    });

    it('should yield ENOENT when entity not found', async () => {
        mockEms.ops.expireAll = mock(() => (async function* () { /* empty */ })());

        const response = await firstResponse(emsExpire(proc, mockEms, 'user', 'missing-id'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('ENOENT');
    });
});
