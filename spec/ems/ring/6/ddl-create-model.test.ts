/**
 * Ring 6: DdlCreateModel Observer Tests
 *
 * Tests for the DdlCreateModel observer which creates tables for new models.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DdlCreateModel } from '@src/ems/ring/6/index.js';
import { ObserverRing, EOBSSYS } from '@src/ems/observers/index.js';
import { getDialect } from '@src/ems/dialect.js';
import type {
    ObserverContext,
    Model,
    ModelRecord,
    DatabaseAdapter,
    ModelCacheAdapter,
} from '@src/ems/observers/index.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock database adapter that tracks exec() calls
 */
function createMockDatabase(): DatabaseAdapter & { execCalls: string[]; shouldFail: boolean } {
    const execCalls: string[] = [];

    return {
        execCalls,
        shouldFail: false,
        dialect: getDialect('sqlite'),
        async execute(_sql: string, _params?: unknown[]): Promise<number> {
            return 1;
        },
        async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
            return [];
        },
        async exec(sql: string): Promise<void> {
            execCalls.push(sql);
            if (this.shouldFail) {
                throw new Error('SQLITE_ERROR: database is locked');
            }
        },
        async transaction(_statements: Array<{ sql: string; params?: unknown[] }>): Promise<number[]> {
            return [];
        },
    };
}

function createMockCache(): ModelCacheAdapter {
    return {
        invalidate(_modelName: string): void {},
    };
}

function createMockModel(name = 'models'): Model {
    return {
        modelName: name,
        isFrozen: false,
        isImmutable: false,
        requiresSudo: false,
        getImmutableFields: () => new Set(),
        getTrackedFields: () => new Set(),
        getTransformFields: () => new Map(),
        getValidationFields: () => [],
        getFields: () => [],
    };
}

function createMockRecord(
    oldData: Record<string, unknown> = {},
    newData: Record<string, unknown> = {},
): ModelRecord {
    const merged = { ...oldData, ...newData };
    const changedFields = Object.keys(newData);

    return {
        isNew: () => Object.keys(oldData).length === 0,
        old: (field: string) => oldData[field],
        get: (field: string) => merged[field],
        has: (field: string) => field in newData,
        set: (field: string, value: unknown) => {
            newData[field] = value;
            merged[field] = value;
        },
        getChangedFields: () => changedFields,
        toRecord: () => ({ ...merged }),
        toChanges: () => ({ ...newData }),
        getDiff: () => {
            const diff: Record<string, { old: unknown; new: unknown }> = {};

            for (const field of changedFields) {
                diff[field] = { old: oldData[field], new: newData[field] };
            }

            return diff;
        },
        getDiffForFields: (fields: Set<string>) => {
            const diff: Record<string, { old: unknown; new: unknown }> = {};

            for (const field of changedFields) {
                if (!fields.has(field)) {
                    continue;
                }

                if (oldData[field] !== newData[field]) {
                    diff[field] = { old: oldData[field], new: newData[field] };
                }
            }

            return diff;
        },
    };
}

function createContext(
    operation: 'create' | 'update' | 'delete',
    record: ModelRecord,
    db: DatabaseAdapter & { execCalls: string[] },
    modelName = 'models',
): ObserverContext {
    return {
        system: {
            db,
            cache: createMockCache(),
        },
        operation,
        model: createMockModel(modelName),
        record,
        recordIndex: 0,
        errors: [],
        warnings: [],
    };
}

// =============================================================================
// DDL CREATE MODEL TESTS
// =============================================================================

describe('DdlCreateModel', () => {
    let observer: DdlCreateModel;
    let mockDb: ReturnType<typeof createMockDatabase>;

    beforeEach(() => {
        observer = new DdlCreateModel();
        mockDb = createMockDatabase();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('DdlCreateModel');
        });

        it('should be in Ring 6 (PostDatabase)', () => {
            expect(observer.ring).toBe(ObserverRing.PostDatabase);
        });

        it('should have priority 10', () => {
            expect(observer.priority).toBe(10);
        });

        it('should only handle create operations', () => {
            expect(observer.operations).toEqual(['create']);
        });

        it('should only run for models table', () => {
            expect(observer.models).toEqual(['models']);
        });
    });

    describe('execution', () => {
        it('should execute CREATE TABLE statement', async () => {
            const record = createMockRecord({}, {
                id: 'model-123',
                model_name: 'invoices',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls).toHaveLength(1);
            expect(mockDb.execCalls[0]).toContain('CREATE TABLE IF NOT EXISTS invoices');
        });

        it('should include id column with default', async () => {
            const record = createMockRecord({}, { model_name: 'orders' });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('id');
            expect(mockDb.execCalls[0]).toContain('TEXT PRIMARY KEY');
            expect(mockDb.execCalls[0]).toContain('randomblob');
        });

        it('should include created_at column', async () => {
            const record = createMockRecord({}, { model_name: 'orders' });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('created_at');
            expect(mockDb.execCalls[0]).toContain("datetime('now')");
        });

        it('should include updated_at column', async () => {
            const record = createMockRecord({}, { model_name: 'orders' });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('updated_at');
        });

        it('should include trashed_at column', async () => {
            const record = createMockRecord({}, { model_name: 'orders' });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('trashed_at');
        });

        it('should include expired_at column', async () => {
            const record = createMockRecord({}, { model_name: 'orders' });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('expired_at');
        });

        it('should use IF NOT EXISTS for idempotency', async () => {
            const record = createMockRecord({}, { model_name: 'customers' });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('IF NOT EXISTS');
        });

        it('should handle model names with underscores', async () => {
            const record = createMockRecord({}, { model_name: 'order_line_items' });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('CREATE TABLE IF NOT EXISTS order_line_items');
        });
    });

    describe('error handling', () => {
        it('should throw EOBSSYS when model_name is missing', async () => {
            const record = createMockRecord({}, { id: 'model-123' }); // no model_name
            const ctx = createContext('create', record, mockDb);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSSYS);
        });

        it('should throw EOBSSYS when database fails', async () => {
            mockDb.shouldFail = true;
            const record = createMockRecord({}, { model_name: 'test_model' });
            const ctx = createContext('create', record, mockDb);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSSYS);
        });

        it('should include model name in error message', async () => {
            mockDb.shouldFail = true;
            const record = createMockRecord({}, { model_name: 'failed_model' });
            const ctx = createContext('create', record, mockDb);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSSYS);
                expect((err as EOBSSYS).message).toContain('failed_model');
            }
        });

        it('should have correct error code', async () => {
            mockDb.shouldFail = true;
            const record = createMockRecord({}, { model_name: 'test' });
            const ctx = createContext('create', record, mockDb);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSSYS);
                expect((err as EOBSSYS).code).toBe('EOBSSYS');
                expect((err as EOBSSYS).errno).toBe(1030);
            }
        });
    });
});
