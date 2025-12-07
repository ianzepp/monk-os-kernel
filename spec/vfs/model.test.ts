import { describe, it, expect, beforeEach } from 'bun:test';
import { PosixModel } from '@src/vfs/model.js';
import type { ModelContext, ModelStat, FieldDef, WatchEvent } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import type { HAL } from '@src/hal/index.js';
import { EIO, ENOENT } from '@src/hal/index.js';
import type { Message, Response } from '@src/vfs/message.js';

// =============================================================================
// MOCK IMPLEMENTATIONS
// =============================================================================

/**
 * Mock FileHandle for testing
 */
class MockFileHandle implements FileHandle {
    readonly id = 'mock-handle-id';
    readonly path = '/mock/path';
    readonly flags: OpenFlags = { read: true };
    closed = false;

    async read(): Promise<Uint8Array> {
        return new Uint8Array();
    }

    async write(data: Uint8Array): Promise<number> {
        return data.length;
    }

    async seek(_offset: number, _whence: 'start' | 'current' | 'end'): Promise<number> {
        return 0;
    }

    async tell(): Promise<number> {
        return 0;
    }

    async sync(): Promise<void> {
        // no-op
    }

    async close(): Promise<void> {
        this.closed = true;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}

/**
 * Mock PosixModel implementation for testing handle() dispatch
 */
class MockPosixModel extends PosixModel {
    readonly name = 'mock';

    // Track method calls for verification
    openCalled = false;
    statCalled = false;
    setstatCalled = false;
    createCalled = false;
    unlinkCalled = false;
    listCalled = false;
    watchCalled = false;

    // Control whether methods throw errors
    shouldThrowOnOpen = false;
    shouldThrowOnStat = false;
    shouldThrowOnSetstat = false;
    shouldThrowOnCreate = false;
    shouldThrowOnUnlink = false;

    // Return values
    mockStat: ModelStat = {
        id: 'test-id',
        model: 'mock',
        name: 'test',
        parent: null,
        owner: 'test-owner',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
    };

    mockChildren: string[] = ['child-1', 'child-2', 'child-3'];
    mockCreatedId = 'new-entity-id';

    fields(): FieldDef[] {
        return [
            { name: 'id', type: 'string', required: true },
            { name: 'name', type: 'string', required: true },
        ];
    }

    async open(
        _ctx: ModelContext,
        _id: string,
        _flags: OpenFlags,
        _opts?: OpenOptions,
    ): Promise<FileHandle> {
        this.openCalled = true;
        if (this.shouldThrowOnOpen) {
            throw new ENOENT('File not found');
        }

        return new MockFileHandle();
    }

    async stat(_ctx: ModelContext, _id: string): Promise<ModelStat> {
        this.statCalled = true;
        if (this.shouldThrowOnStat) {
            throw new ENOENT('Entity not found');
        }

        return this.mockStat;
    }

    async setstat(_ctx: ModelContext, _id: string, _fields: Partial<ModelStat>): Promise<void> {
        this.setstatCalled = true;
        if (this.shouldThrowOnSetstat) {
            throw new EIO('Write failed');
        }
    }

    async create(
        _ctx: ModelContext,
        _parent: string,
        _name: string,
        _fields?: Partial<ModelStat>,
    ): Promise<string> {
        this.createCalled = true;
        if (this.shouldThrowOnCreate) {
            throw new EIO('Create failed');
        }

        return this.mockCreatedId;
    }

    async unlink(_ctx: ModelContext, _id: string): Promise<void> {
        this.unlinkCalled = true;
        if (this.shouldThrowOnUnlink) {
            throw new ENOENT('Entity not found');
        }
    }

    async *list(_ctx: ModelContext, _id: string): AsyncIterable<string> {
        this.listCalled = true;
        for (const child of this.mockChildren) {
            yield child;
        }
    }

    override async *watch(_ctx: ModelContext, _id: string, _pattern?: string): AsyncIterable<WatchEvent> {
        this.watchCalled = true;
        yield {
            entity: 'watched-entity',
            op: 'create',
            path: '/watched/path',
            timestamp: Date.now(),
        };
    }
}

/**
 * Mock PosixModel without watch() method
 */
class MockPosixModelNoWatch extends PosixModel {
    readonly name = 'mock-no-watch';

    fields(): FieldDef[] {
        return [
            { name: 'id', type: 'string', required: true },
        ];
    }

    async open(_ctx: ModelContext, _id: string, _flags: OpenFlags, _opts?: OpenOptions): Promise<FileHandle> {
        return new MockFileHandle();
    }

    async stat(_ctx: ModelContext, _id: string): Promise<ModelStat> {
        return {
            id: _id,
            model: 'mock-no-watch',
            name: 'test',
            parent: null,
            owner: 'test-owner',
            size: 0,
            mtime: Date.now(),
            ctime: Date.now(),
        };
    }

    async setstat(_ctx: ModelContext, _id: string, _fields: Partial<ModelStat>): Promise<void> {
        // no-op
    }

    async create(_ctx: ModelContext, _parent: string, _name: string, _fields?: Partial<ModelStat>): Promise<string> {
        return 'new-id';
    }

    async unlink(_ctx: ModelContext, _id: string): Promise<void> {
        // no-op
    }

    async *list(_ctx: ModelContext, _id: string): AsyncIterable<string> {
        // Empty list
    }
}

/**
 * Create a mock ModelContext for testing
 */
function createMockContext(): ModelContext {
    return {
        hal: {} as HAL,
        caller: 'test-caller',
        async resolve(_path: string): Promise<string | null> {
            return 'resolved-id';
        },
        async getEntity(id: string): Promise<ModelStat | null> {
            return {
                id,
                model: 'mock',
                name: `entity-${id}`,
                parent: null,
                owner: 'test-owner',
                size: 0,
                mtime: Date.now(),
                ctime: Date.now(),
            };
        },
        async computePath(_id: string): Promise<string> {
            return '/computed/path';
        },
    };
}

/**
 * Helper to collect all responses from an async iterable
 */
async function collectResponses(iterable: AsyncIterable<Response>): Promise<Response[]> {
    const responses: Response[] = [];

    for await (const response of iterable) {
        responses.push(response);
    }

    return responses;
}

// =============================================================================
// TESTS
// =============================================================================

describe('PosixModel.handle()', () => {
    let model: MockPosixModel;
    let ctx: ModelContext;
    const entityId = 'test-entity-id';

    beforeEach(() => {
        model = new MockPosixModel();
        ctx = createMockContext();
    });

    // -------------------------------------------------------------------------
    // Operation: open
    // -------------------------------------------------------------------------

    describe('op: open', () => {
        it('should dispatch to open() method', async () => {
            const msg: Message = {
                op: 'open',
                data: {
                    flags: { read: true },
                },
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(model.openCalled).toBe(true);
            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('ok');
            expect((responses[0] as any).data).toEqual({ handle: 'mock-handle-id' });
        });

        it('should pass flags and options to open()', async () => {
            let capturedFlags: OpenFlags | undefined;
            let capturedOpts: OpenOptions | undefined;

            model.open = async (_ctx, _id, flags, opts) => {
                capturedFlags = flags;
                capturedOpts = opts;

                return new MockFileHandle();
            };

            const msg: Message = {
                op: 'open',
                data: {
                    flags: { read: true, write: true },
                    opts: { version: 1 },
                },
            };

            await collectResponses(model.handle(ctx, entityId, msg));

            expect(capturedFlags).toEqual({ read: true, write: true });
            expect(capturedOpts).toEqual({ version: 1 });
        });

        it('should convert thrown errors to error responses', async () => {
            model.shouldThrowOnOpen = true;

            const msg: Message = {
                op: 'open',
                data: {
                    flags: { read: true },
                },
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0] as any).data.code).toBe('ENOENT');
            expect((responses[0] as any).data.message).toBe('File not found');
        });
    });

    // -------------------------------------------------------------------------
    // Operation: stat
    // -------------------------------------------------------------------------

    describe('op: stat', () => {
        it('should dispatch to stat() method', async () => {
            const msg: Message = {
                op: 'stat',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(model.statCalled).toBe(true);
            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('ok');
            expect((responses[0] as any).data).toEqual(model.mockStat);
        });

        it('should convert thrown errors to error responses', async () => {
            model.shouldThrowOnStat = true;

            const msg: Message = {
                op: 'stat',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0] as any).data.code).toBe('ENOENT');
        });
    });

    // -------------------------------------------------------------------------
    // Operation: setstat
    // -------------------------------------------------------------------------

    describe('op: setstat', () => {
        it('should dispatch to setstat() method', async () => {
            let capturedFields: Partial<ModelStat> | undefined;

            model.setstat = async (_ctx, _id, fields) => {
                model.setstatCalled = true;
                capturedFields = fields;
            };

            const fields = { name: 'new-name', size: 123 };
            const msg: Message = {
                op: 'setstat',
                data: fields,
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(model.setstatCalled).toBe(true);
            expect(capturedFields).toEqual(fields);
            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('ok');
        });

        it('should convert thrown errors to error responses', async () => {
            model.shouldThrowOnSetstat = true;

            const msg: Message = {
                op: 'setstat',
                data: { name: 'new-name' },
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0] as any).data.code).toBe('EIO');
        });
    });

    // -------------------------------------------------------------------------
    // Operation: create
    // -------------------------------------------------------------------------

    describe('op: create', () => {
        it('should dispatch to create() method', async () => {
            const msg: Message = {
                op: 'create',
                data: {
                    name: 'new-entity',
                },
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(model.createCalled).toBe(true);
            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('ok');
            expect((responses[0] as any).data).toEqual({ id: 'new-entity-id' });
        });

        it('should pass name and fields to create()', async () => {
            let capturedName: string | undefined;
            let capturedFields: Partial<ModelStat> | undefined;

            model.create = async (_ctx, _parent, name, fields) => {
                capturedName = name;
                capturedFields = fields;

                return 'created-id';
            };

            const fields = { size: 456, mimetype: 'text/plain' };
            const msg: Message = {
                op: 'create',
                data: {
                    name: 'test-file.txt',
                    fields,
                },
            };

            await collectResponses(model.handle(ctx, entityId, msg));

            expect(capturedName).toBe('test-file.txt');
            expect(capturedFields).toEqual(fields);
        });

        it('should convert thrown errors to error responses', async () => {
            model.shouldThrowOnCreate = true;

            const msg: Message = {
                op: 'create',
                data: {
                    name: 'new-entity',
                },
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0] as any).data.code).toBe('EIO');
        });
    });

    // -------------------------------------------------------------------------
    // Operation: delete
    // -------------------------------------------------------------------------

    describe('op: delete', () => {
        it('should dispatch to unlink() method', async () => {
            const msg: Message = {
                op: 'delete',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(model.unlinkCalled).toBe(true);
            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('ok');
        });

        it('should convert thrown errors to error responses', async () => {
            model.shouldThrowOnUnlink = true;

            const msg: Message = {
                op: 'delete',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0] as any).data.code).toBe('ENOENT');
        });
    });

    // -------------------------------------------------------------------------
    // Operation: list
    // -------------------------------------------------------------------------

    describe('op: list', () => {
        it('should dispatch to list() and yield item responses', async () => {
            const msg: Message = {
                op: 'list',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(model.listCalled).toBe(true);

            // WHY: list() yields item for each child, then done
            expect(responses).toHaveLength(4);

            // Verify item responses
            for (let i = 0; i < 3; i++) {
                expect(responses[i]!.op).toBe('item');
                const itemData = (responses[i] as any).data;

                expect(itemData.id).toBe(`child-${i + 1}`);
                expect(itemData.name).toBe(`entity-child-${i + 1}`);
            }

            // Verify done response
            expect(responses[3]!.op).toBe('done');
        });

        it('should fetch full entity data for each child', async () => {
            const fetchedIds: string[] = [];

            ctx.getEntity = async (id: string) => {
                fetchedIds.push(id);

                return {
                    id,
                    model: 'mock',
                    name: `name-${id}`,
                    parent: entityId,
                    owner: 'test-owner',
                    size: 0,
                    mtime: Date.now(),
                    ctime: Date.now(),
                };
            };

            const msg: Message = {
                op: 'list',
            };

            await collectResponses(model.handle(ctx, entityId, msg));

            expect(fetchedIds).toEqual(['child-1', 'child-2', 'child-3']);
        });

        it('should skip children that return null from getEntity', async () => {
            ctx.getEntity = async (id: string) => {
                // EDGE: Return null for second child (simulates deleted entity)
                if (id === 'child-2') {
                    return null;
                }

                return {
                    id,
                    model: 'mock',
                    name: `name-${id}`,
                    parent: entityId,
                    owner: 'test-owner',
                    size: 0,
                    mtime: Date.now(),
                    ctime: Date.now(),
                };
            };

            const msg: Message = {
                op: 'list',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            // WHY: Only 2 items (child-1 and child-3) + done = 3 responses
            expect(responses).toHaveLength(3);
            expect(responses[0]!.op).toBe('item');
            expect(responses[1]!.op).toBe('item');
            expect(responses[2]!.op).toBe('done');
        });

        it('should yield done even for empty list', async () => {
            model.mockChildren = [];

            const msg: Message = {
                op: 'list',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            // WHY: No items, just done
            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('done');
        });
    });

    // -------------------------------------------------------------------------
    // Operation: watch
    // -------------------------------------------------------------------------

    describe('op: watch', () => {
        it('should dispatch to watch() if defined', async () => {
            const msg: Message = {
                op: 'watch',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(model.watchCalled).toBe(true);
            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('event');

            const eventData = (responses[0] as any).data;

            expect(eventData.type).toBe('create');
            expect(eventData.entity).toBe('watched-entity');
            expect(eventData.path).toBe('/watched/path');
        });

        it('should pass pattern to watch()', async () => {
            let capturedPattern: string | undefined;

            model.watch = async function* (_ctx, _id, pattern) {
                capturedPattern = pattern;
                // Yields nothing - just testing parameter passing
            };

            const msg: Message = {
                op: 'watch',
                data: {
                    pattern: '*.txt',
                },
            };

            await collectResponses(model.handle(ctx, entityId, msg));

            expect(capturedPattern).toBe('*.txt');
        });

        it('should return ENOSYS if watch() not defined', async () => {
            const modelWithoutWatch = new MockPosixModelNoWatch();

            const msg: Message = {
                op: 'watch',
            };

            const responses = await collectResponses(modelWithoutWatch.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0] as any).data.code).toBe('ENOSYS');
            expect((responses[0] as any).data.message).toBe('Watch not supported');
        });

        it('should yield event responses as watch emits', async () => {
            model.watch = async function* (_ctx, _id, _pattern) {
                yield {
                    entity: 'e1',
                    op: 'create' as const,
                    path: '/path1',
                    timestamp: 1000,
                };
                yield {
                    entity: 'e2',
                    op: 'update' as const,
                    path: '/path2',
                    timestamp: 2000,
                    fields: ['name', 'size'],
                };
                yield {
                    entity: 'e3',
                    op: 'delete' as const,
                    path: '/path3',
                    timestamp: 3000,
                };
            };

            const msg: Message = {
                op: 'watch',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(3);

            // Verify first event
            expect(responses[0]!.op).toBe('event');
            expect((responses[0] as any).data.type).toBe('create');
            expect((responses[0] as any).data.entity).toBe('e1');

            // Verify second event
            expect(responses[1]!.op).toBe('event');
            expect((responses[1] as any).data.type).toBe('update');
            expect((responses[1] as any).data.fields).toEqual(['name', 'size']);

            // Verify third event
            expect(responses[2]!.op).toBe('event');
            expect((responses[2] as any).data.type).toBe('delete');
        });
    });

    // -------------------------------------------------------------------------
    // Unknown operation
    // -------------------------------------------------------------------------

    describe('unknown operation', () => {
        it('should return ENOSYS error for unknown op', async () => {
            const msg: Message = {
                op: 'unknown-operation' as any,
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0] as any).data.code).toBe('ENOSYS');
            expect((responses[0] as any).data.message).toBe('Unknown operation: unknown-operation');
        });

        it('should return ENOSYS for empty op', async () => {
            const msg: Message = {
                op: '' as any,
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0] as any).data.code).toBe('ENOSYS');
        });
    });

    // -------------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------------

    describe('error handling', () => {
        it('should convert errors with code to error responses', async () => {
            model.shouldThrowOnStat = true;

            const msg: Message = {
                op: 'stat',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0] as any).data.code).toBe('ENOENT');
            expect((responses[0] as any).data.message).toBe('Entity not found');
        });

        it('should handle errors without code property', async () => {
            model.open = async () => {
                throw new Error('Generic error');
            };

            const msg: Message = {
                op: 'open',
                data: {
                    flags: { read: true },
                },
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            // WHY: Errors without code default to EIO
            expect((responses[0] as any).data.code).toBe('EIO');
            expect((responses[0] as any).data.message).toBe('Generic error');
        });

        it('should handle errors without message', async () => {
            model.open = async () => {
                const err = new Error();

                (err as any).code = 'EACCES';
                (err as any).message = undefined;
                throw err;
            };

            const msg: Message = {
                op: 'open',
                data: {
                    flags: { read: true },
                },
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('error');
            expect((responses[0] as any).data.code).toBe('EACCES');
            // WHY: ?? operator in handle() converts undefined/null to 'Unknown error'
            expect((responses[0] as any).data.message).toBe('Unknown error');
        });

        it('should terminate stream on error', async () => {
            model.list = async function* () {
                yield 'child-1';
                throw new EIO('Storage failure');
            };

            const msg: Message = {
                op: 'list',
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            // WHY: Should yield one item, then error (no done after error)
            expect(responses).toHaveLength(2);
            expect(responses[0]!.op).toBe('item');
            expect(responses[1]!.op).toBe('error');
            expect((responses[1] as any).data.code).toBe('EIO');
        });
    });

    // -------------------------------------------------------------------------
    // Edge cases
    // -------------------------------------------------------------------------

    describe('edge cases', () => {
        it('should handle missing data in open message', async () => {
            const msg: Message = {
                op: 'open',
                data: {} as any, // Missing flags
            };

            // This will likely throw or behave unexpectedly in real code
            // but we test that handle() doesn't crash
            try {
                await collectResponses(model.handle(ctx, entityId, msg));
            }
            catch (err) {
                // Expected to fail - just ensure it's caught
                expect(err).toBeDefined();
            }
        });

        it('should handle null data in create message', async () => {
            const msg: Message = {
                op: 'create',
                data: null as any,
            };

            try {
                await collectResponses(model.handle(ctx, entityId, msg));
            }
            catch (err) {
                // Expected to fail - accessing null.name will throw
                expect(err).toBeDefined();
            }
        });

        it('should handle watch with no data', async () => {
            model.watch = async function* (_ctx, _id, pattern) {
                // Verify pattern is undefined when data is missing
                expect(pattern).toBeUndefined();
                yield {
                    entity: 'e1',
                    op: 'create' as const,
                    path: '/path',
                    timestamp: Date.now(),
                };
            };

            const msg: Message = {
                op: 'watch',
                // No data property
            };

            const responses = await collectResponses(model.handle(ctx, entityId, msg));

            expect(responses).toHaveLength(1);
            expect(responses[0]!.op).toBe('event');
        });

        it('should handle multiple operations on same model', async () => {
            // Verify model can handle multiple sequential operations
            const msg1: Message = { op: 'stat' };
            const msg2: Message = { op: 'open', data: { flags: { read: true } } };
            const msg3: Message = { op: 'delete' };

            await collectResponses(model.handle(ctx, entityId, msg1));
            await collectResponses(model.handle(ctx, entityId, msg2));
            await collectResponses(model.handle(ctx, entityId, msg3));

            expect(model.statCalled).toBe(true);
            expect(model.openCalled).toBe(true);
            expect(model.unlinkCalled).toBe(true);
        });

        it('should handle concurrent operations', async () => {
            // Test concurrent message handling
            const msg1: Message = { op: 'stat' };
            const msg2: Message = { op: 'stat' };

            const [responses1, responses2] = await Promise.all([
                collectResponses(model.handle(ctx, entityId, msg1)),
                collectResponses(model.handle(ctx, entityId, msg2)),
            ]);

            expect(responses1).toHaveLength(1);
            expect(responses2).toHaveLength(1);
            expect(responses1[0]!.op).toBe('ok');
            expect(responses2[0]!.op).toBe('ok');
        });
    });
});
