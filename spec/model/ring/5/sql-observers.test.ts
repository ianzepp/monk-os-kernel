/**
 * Ring 5: SQL Observers Tests
 *
 * Tests for SqlCreate, SqlUpdate, and SqlDelete observers.
 * These observers execute the actual SQL statements in the pipeline.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SqlCreate, SqlUpdate, SqlDelete } from '@src/model/ring/5/index.js';
import { ObserverRing, EOBSSYS } from '@src/model/observers/index.js';
import type {
    ObserverContext,
    Model,
    ModelRecord,
    DatabaseAdapter,
    ModelCacheAdapter,
} from '@src/model/observers/index.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Track SQL calls made to the mock database
 */
interface SqlCall {
    sql: string;
    params?: unknown[];
}

/**
 * Create a mock database adapter that tracks calls
 */
function createMockDatabase(): DatabaseAdapter & { calls: SqlCall[]; shouldFail: boolean } {
    const calls: SqlCall[] = [];
    return {
        calls,
        shouldFail: false,
        async execute(sql: string, params?: unknown[]): Promise<number> {
            calls.push({ sql, params });
            if (this.shouldFail) {
                throw new Error('Database error: SQLITE_CONSTRAINT');
            }
            return 1;
        },
        async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
            return [];
        },
        async exec(_sql: string): Promise<void> {
            // no-op
        },
    };
}

/**
 * Create a mock cache adapter
 */
function createMockCache(): ModelCacheAdapter {
    return {
        invalidate(_modelName: string): void {
            // no-op
        },
    };
}

/**
 * Create a mock model for testing
 */
function createMockModel(name = 'test_model'): Model {
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

/**
 * Create a mock record for testing
 */
function createMockRecord(
    oldData: Record<string, unknown> = {},
    newData: Record<string, unknown> = {}
): ModelRecord {
    const merged = { ...oldData, ...newData };
    const changedFields = Object.keys(newData);

    return {
        isNew: () => Object.keys(oldData).length === 0,
        old: (field: string) => oldData[field],
        new: (field: string) => newData[field],
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
    };
}

/**
 * Create a context for testing observers
 */
function createContext(
    operation: 'create' | 'update' | 'delete',
    record: ModelRecord,
    db: DatabaseAdapter,
    modelName = 'test_model'
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
// SQL CREATE TESTS
// =============================================================================

describe('SqlCreate', () => {
    let observer: SqlCreate;
    let mockDb: ReturnType<typeof createMockDatabase>;

    beforeEach(() => {
        observer = new SqlCreate();
        mockDb = createMockDatabase();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('SqlCreate');
        });

        it('should be in Ring 5 (Database)', () => {
            expect(observer.ring).toBe(ObserverRing.Database);
        });

        it('should have priority 50', () => {
            expect(observer.priority).toBe(50);
        });

        it('should only handle create operations', () => {
            expect(observer.operations).toEqual(['create']);
        });
    });

    describe('execution', () => {
        it('should execute INSERT statement', async () => {
            const record = createMockRecord({}, {
                id: 'abc123',
                name: 'Test',
                value: 42,
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.calls.length).toBe(1);
            const call = mockDb.calls[0];
            expect(call.sql).toContain('INSERT INTO test_model');
            expect(call.sql).toContain('id');
            expect(call.sql).toContain('name');
            expect(call.sql).toContain('value');
        });

        it('should use parameterized values', async () => {
            const record = createMockRecord({}, {
                id: 'abc123',
                name: 'Test',
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            const call = mockDb.calls[0];
            expect(call.params).toContain('abc123');
            expect(call.params).toContain('Test');
        });

        it('should handle null values', async () => {
            const record = createMockRecord({}, {
                id: 'abc123',
                name: null,
            });
            const ctx = createContext('create', record, mockDb);

            await observer.execute(ctx);

            const call = mockDb.calls[0];
            expect(call.params).toContain(null);
        });

        it('should use correct table name from model', async () => {
            const record = createMockRecord({}, { id: 'abc123' });
            const ctx = createContext('create', record, mockDb, 'invoices');

            await observer.execute(ctx);

            expect(mockDb.calls[0].sql).toContain('INSERT INTO invoices');
        });
    });

    describe('error handling', () => {
        it('should throw EOBSSYS on database error', async () => {
            mockDb.shouldFail = true;
            const record = createMockRecord({}, { id: 'abc123' });
            const ctx = createContext('create', record, mockDb);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSSYS);
        });

        it('should include model and id in error message', async () => {
            mockDb.shouldFail = true;
            const record = createMockRecord({}, { id: 'my-id-123' });
            const ctx = createContext('create', record, mockDb, 'customers');

            try {
                await observer.execute(ctx);
                expect(true).toBe(false); // Should not reach
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSSYS);
                expect((err as EOBSSYS).message).toContain('customers');
                expect((err as EOBSSYS).message).toContain('my-id-123');
            }
        });
    });
});

// =============================================================================
// SQL UPDATE TESTS
// =============================================================================

describe('SqlUpdate', () => {
    let observer: SqlUpdate;
    let mockDb: ReturnType<typeof createMockDatabase>;

    beforeEach(() => {
        observer = new SqlUpdate();
        mockDb = createMockDatabase();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('SqlUpdate');
        });

        it('should be in Ring 5 (Database)', () => {
            expect(observer.ring).toBe(ObserverRing.Database);
        });

        it('should have priority 50', () => {
            expect(observer.priority).toBe(50);
        });

        it('should only handle update operations', () => {
            expect(observer.operations).toEqual(['update']);
        });
    });

    describe('execution', () => {
        it('should execute UPDATE statement', async () => {
            const record = createMockRecord(
                { id: 'abc123', name: 'Old', value: 10 },
                { name: 'New', value: 20 }
            );
            const ctx = createContext('update', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.calls.length).toBe(1);
            const call = mockDb.calls[0];
            expect(call.sql).toContain('UPDATE test_model');
            expect(call.sql).toContain('SET');
            expect(call.sql).toContain('WHERE id = ?');
        });

        it('should only update changed fields', async () => {
            const record = createMockRecord(
                { id: 'abc123', name: 'Old', unchanged: 'same' },
                { name: 'New' }
            );
            const ctx = createContext('update', record, mockDb);

            await observer.execute(ctx);

            const call = mockDb.calls[0];
            expect(call.sql).toContain('name = ?');
            expect(call.sql).not.toContain('unchanged');
        });

        it('should use id as WHERE parameter', async () => {
            const record = createMockRecord(
                { id: 'abc123', name: 'Old' },
                { name: 'New' }
            );
            const ctx = createContext('update', record, mockDb);

            await observer.execute(ctx);

            const call = mockDb.calls[0];
            // id should be the last parameter (for WHERE clause)
            expect(call.params![call.params!.length - 1]).toBe('abc123');
        });

        it('should skip execution when no changes', async () => {
            const record = createMockRecord(
                { id: 'abc123', name: 'Same' },
                {} // No changes
            );
            const ctx = createContext('update', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.calls.length).toBe(0);
        });
    });

    describe('error handling', () => {
        it('should throw EOBSSYS on database error', async () => {
            mockDb.shouldFail = true;
            const record = createMockRecord(
                { id: 'abc123', name: 'Old' },
                { name: 'New' }
            );
            const ctx = createContext('update', record, mockDb);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSSYS);
        });

        it('should include model and id in error message', async () => {
            mockDb.shouldFail = true;
            const record = createMockRecord(
                { id: 'update-id', name: 'Old' },
                { name: 'New' }
            );
            const ctx = createContext('update', record, mockDb, 'orders');

            try {
                await observer.execute(ctx);
                expect(true).toBe(false);
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSSYS);
                expect((err as EOBSSYS).message).toContain('orders');
                expect((err as EOBSSYS).message).toContain('update-id');
            }
        });
    });
});

// =============================================================================
// SQL DELETE TESTS
// =============================================================================

describe('SqlDelete', () => {
    let observer: SqlDelete;
    let mockDb: ReturnType<typeof createMockDatabase>;

    beforeEach(() => {
        observer = new SqlDelete();
        mockDb = createMockDatabase();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('SqlDelete');
        });

        it('should be in Ring 5 (Database)', () => {
            expect(observer.ring).toBe(ObserverRing.Database);
        });

        it('should have priority 50', () => {
            expect(observer.priority).toBe(50);
        });

        it('should only handle delete operations', () => {
            expect(observer.operations).toEqual(['delete']);
        });
    });

    describe('execution', () => {
        it('should execute UPDATE statement (soft delete)', async () => {
            const trashedAt = new Date().toISOString();
            const record = createMockRecord(
                { id: 'abc123', name: 'Test' },
                { trashed_at: trashedAt }
            );
            const ctx = createContext('delete', record, mockDb);

            await observer.execute(ctx);

            expect(mockDb.calls.length).toBe(1);
            const call = mockDb.calls[0];
            expect(call.sql).toContain('UPDATE test_model');
            expect(call.sql).toContain('SET trashed_at = ?');
            expect(call.sql).toContain('WHERE id = ?');
        });

        it('should NOT execute DELETE statement (soft delete only)', async () => {
            const record = createMockRecord(
                { id: 'abc123' },
                { trashed_at: new Date().toISOString() }
            );
            const ctx = createContext('delete', record, mockDb);

            await observer.execute(ctx);

            const call = mockDb.calls[0];
            expect(call.sql).not.toContain('DELETE FROM');
            expect(call.sql).toContain('UPDATE');
        });

        it('should use trashed_at value from record', async () => {
            const trashedAt = '2025-01-15T12:00:00.000Z';
            const record = createMockRecord(
                { id: 'abc123' },
                { trashed_at: trashedAt }
            );
            const ctx = createContext('delete', record, mockDb);

            await observer.execute(ctx);

            const call = mockDb.calls[0];
            expect(call.params).toContain(trashedAt);
        });
    });

    describe('error handling', () => {
        it('should throw EOBSSYS on database error', async () => {
            mockDb.shouldFail = true;
            const record = createMockRecord(
                { id: 'abc123' },
                { trashed_at: new Date().toISOString() }
            );
            const ctx = createContext('delete', record, mockDb);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSSYS);
        });

        it('should include model and id in error message', async () => {
            mockDb.shouldFail = true;
            const record = createMockRecord(
                { id: 'delete-id' },
                { trashed_at: new Date().toISOString() }
            );
            const ctx = createContext('delete', record, mockDb, 'products');

            try {
                await observer.execute(ctx);
                expect(true).toBe(false);
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSSYS);
                expect((err as EOBSSYS).message).toContain('products');
                expect((err as EOBSSYS).message).toContain('delete-id');
            }
        });
    });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Ring 5 Integration', () => {
    it('should export all observers from index', async () => {
        const exports = await import('@src/model/ring/5/index.js');
        expect(exports.SqlCreate).toBeDefined();
        expect(exports.SqlUpdate).toBeDefined();
        expect(exports.SqlDelete).toBeDefined();
    });

    it('should export observers from main observers index', async () => {
        const exports = await import('@src/model/observers/index.js');
        expect(exports.SqlCreate).toBeDefined();
        expect(exports.SqlUpdate).toBeDefined();
        expect(exports.SqlDelete).toBeDefined();
    });
});

// =============================================================================
// PROOF THAT RING 5 IS REQUIRED
// =============================================================================

describe('Ring 5 is required for persistence', () => {
    // This test proves that SQL execution ONLY happens through Ring 5 observers.
    // Without them, records are NOT persisted.

    it('should NOT persist records when Ring 5 observers are missing', async () => {
        const { BunHAL } = await import('@src/hal/index.js');
        const { createDatabase } = await import('@src/model/connection.js');
        const { ModelCache } = await import('@src/model/model-cache.js');
        const { DatabaseService } = await import('@src/model/database.js');
        const { ObserverRunner } = await import('@src/model/observers/runner.js');
        const { EIO } = await import('@src/hal/errors.js');

        // Setup
        const hal = new BunHAL();
        await hal.init();
        const db = await createDatabase(hal.channel, hal.file);
        const cache = new ModelCache(db);

        // EMPTY runner - no Ring 5 observers registered
        const emptyRunner = new ObserverRunner();
        const service = new DatabaseService(db, cache, emptyRunner);

        // Attempt to create a record - pipeline runs but no SQL executes
        // Since no INSERT happened, the re-read finds nothing, and createOne throws EIO
        try {
            await service.createOne('file', {
                name: 'ghost-file.txt',
                owner: 'ghost',
            });
            // Should not reach here
            expect(true).toBe(false);
        } catch (err) {
            // Expected: EIO because no record was persisted
            expect(err).toBeInstanceOf(EIO);
            expect((err as Error).message).toBe('Create failed');
        }

        // Double-check: verify ghost file is NOT in database
        const rows = await db.query('SELECT * FROM file WHERE name = ?', ['ghost-file.txt']);
        expect(rows.length).toBe(0);

        // Cleanup
        await db.close();
        await hal.shutdown();
    });

    it('should persist records when Ring 5 observers ARE registered', async () => {
        const { BunHAL } = await import('@src/hal/index.js');
        const { createDatabase } = await import('@src/model/connection.js');
        const { ModelCache } = await import('@src/model/model-cache.js');
        const { DatabaseService } = await import('@src/model/database.js');
        const { createObserverRunner } = await import('@src/model/observers/registry.js');

        // Setup
        const hal = new BunHAL();
        await hal.init();
        const db = await createDatabase(hal.channel, hal.file);
        const cache = new ModelCache(db);

        // Runner WITH Ring 5 observers
        const runner = createObserverRunner();
        const service = new DatabaseService(db, cache, runner);

        // Create a record - Ring 5 observers execute SQL
        const created = await service.createOne('file', {
            name: 'real-file.txt',
            owner: 'real-owner',
        });

        // The record should exist and have all fields
        expect(created).toBeDefined();
        expect(created.id).toBeTruthy();
        expect(created.name).toBe('real-file.txt');
        expect(created.owner).toBe('real-owner');

        // Verify it's actually in the database via direct query
        const rows = await db.query('SELECT * FROM file WHERE name = ?', ['real-file.txt']);
        expect(rows.length).toBe(1);

        // Cleanup
        await db.close();
        await hal.shutdown();
    });
});
