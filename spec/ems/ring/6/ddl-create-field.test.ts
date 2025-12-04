/**
 * Ring 6: DdlCreateField Observer Tests
 *
 * Tests for the DdlCreateField observer which adds columns for new fields.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DdlCreateField } from '@src/ems/ring/6/index.js';
import { ObserverRing, EOBSSYS } from '@src/ems/observers/index.js';
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
function createMockDatabase(): DatabaseAdapter & {
    execCalls: string[];
    shouldFail: boolean;
    failMessage: string;
} {
    const execCalls: string[] = [];
    return {
        execCalls,
        shouldFail: false,
        failMessage: 'SQLITE_ERROR: no such table',
        async execute(_sql: string, _params?: unknown[]): Promise<number> {
            return 1;
        },
        async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
            return [];
        },
        async exec(sql: string): Promise<void> {
            execCalls.push(sql);
            if (this.shouldFail) {
                throw new Error(this.failMessage);
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

function createMockModel(name = 'fields'): Model {
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
    newData: Record<string, unknown> = {}
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
                if (!fields.has(field)) continue;
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
    modelName = 'fields'
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
// DDL CREATE FIELD TESTS
// =============================================================================

describe('DdlCreateField', () => {
    let observer: DdlCreateField;
    let mockDb: ReturnType<typeof createMockDatabase>;

    beforeEach(() => {
        observer = new DdlCreateField();
        mockDb = createMockDatabase();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('DdlCreateField');
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

        it('should only run for fields table', () => {
            expect(observer.models).toEqual(['fields']);
        });
    });

    describe('execution', () => {
        it('should execute ALTER TABLE ADD COLUMN statement', async () => {
            const record = createMockRecord({}, {
                model_name: 'invoices',
                field_name: 'amount',
                type: 'numeric',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls).toHaveLength(1);
            expect(mockDb.execCalls[0]).toContain('ALTER TABLE invoices ADD COLUMN amount');
        });
    });

    describe('type mapping', () => {
        it('should map text to TEXT', async () => {
            const record = createMockRecord({}, {
                model_name: 'users',
                field_name: 'name',
                type: 'text',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('name TEXT');
        });

        it('should map uuid to TEXT', async () => {
            const record = createMockRecord({}, {
                model_name: 'users',
                field_name: 'external_id',
                type: 'uuid',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('external_id TEXT');
        });

        it('should map timestamp to TEXT', async () => {
            const record = createMockRecord({}, {
                model_name: 'events',
                field_name: 'occurred_at',
                type: 'timestamp',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('occurred_at TEXT');
        });

        it('should map date to TEXT', async () => {
            const record = createMockRecord({}, {
                model_name: 'users',
                field_name: 'birth_date',
                type: 'date',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('birth_date TEXT');
        });

        it('should map integer to INTEGER', async () => {
            const record = createMockRecord({}, {
                model_name: 'items',
                field_name: 'quantity',
                type: 'integer',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('quantity INTEGER');
        });

        it('should map numeric to REAL', async () => {
            const record = createMockRecord({}, {
                model_name: 'items',
                field_name: 'price',
                type: 'numeric',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('price REAL');
        });

        it('should map boolean to INTEGER', async () => {
            const record = createMockRecord({}, {
                model_name: 'users',
                field_name: 'active',
                type: 'boolean',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('active INTEGER');
        });

        it('should map binary to BLOB', async () => {
            const record = createMockRecord({}, {
                model_name: 'files',
                field_name: 'content',
                type: 'binary',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('content BLOB');
        });

        it('should map jsonb to TEXT', async () => {
            const record = createMockRecord({}, {
                model_name: 'configs',
                field_name: 'data',
                type: 'jsonb',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('data TEXT');
        });

        it('should map unknown type to TEXT', async () => {
            const record = createMockRecord({}, {
                model_name: 'test',
                field_name: 'unknown',
                type: 'some_unknown_type',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.execCalls[0]).toContain('unknown TEXT');
        });
    });

    describe('error handling', () => {
        it('should throw EOBSSYS when model_name is missing', async () => {
            const record = createMockRecord({}, {
                field_name: 'amount',
                type: 'numeric',
            });
            const ctx = createContext('create', record, mockDb);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSSYS);
        });

        it('should throw EOBSSYS when field_name is missing', async () => {
            const record = createMockRecord({}, {
                model_name: 'invoices',
                type: 'numeric',
            });
            const ctx = createContext('create', record, mockDb);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSSYS);
        });

        it('should ignore duplicate column errors', async () => {
            mockDb.shouldFail = true;
            mockDb.failMessage = 'SQLITE_ERROR: duplicate column name: amount';
            const record = createMockRecord({}, {
                model_name: 'invoices',
                field_name: 'amount',
                type: 'numeric',
            });
            const ctx = createContext('create', record, mockDb);

            // Should not throw - duplicate column is ignored
            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should throw EOBSSYS for other database errors', async () => {
            mockDb.shouldFail = true;
            mockDb.failMessage = 'SQLITE_ERROR: no such table: invoices';
            const record = createMockRecord({}, {
                model_name: 'invoices',
                field_name: 'amount',
                type: 'numeric',
            });
            const ctx = createContext('create', record, mockDb);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSSYS);
        });

        it('should include model and field name in error message', async () => {
            mockDb.shouldFail = true;
            mockDb.failMessage = 'SQLITE_ERROR: table is locked';
            const record = createMockRecord({}, {
                model_name: 'orders',
                field_name: 'status',
                type: 'text',
            });
            const ctx = createContext('create', record, mockDb);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSSYS);
                expect((err as EOBSSYS).message).toContain('orders');
                expect((err as EOBSSYS).message).toContain('status');
            }
        });

        it('should have correct error code', async () => {
            mockDb.shouldFail = true;
            mockDb.failMessage = 'SQLITE_ERROR: database is locked';
            const record = createMockRecord({}, {
                model_name: 'test',
                field_name: 'col',
                type: 'text',
            });
            const ctx = createContext('create', record, mockDb);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSSYS);
                expect((err as EOBSSYS).code).toBe('EOBSSYS');
                expect((err as EOBSSYS).errno).toBe(1030);
            }
        });
    });
});
