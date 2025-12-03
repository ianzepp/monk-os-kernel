/**
 * Ring 7: Tracked Observer Tests
 *
 * Tests for the Tracked observer which records changes to fields
 * marked with tracked=1 in the fields table.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Tracked } from '@src/model/ring/7/index.js';
import { ObserverRing } from '@src/model/observers/index.js';
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
 * Create a mock database adapter that tracks operations
 */
function createMockDatabase(): DatabaseAdapter & {
    executedQueries: Array<{ sql: string; params?: unknown[] }>;
    nextChangeId: number;
} {
    const executedQueries: Array<{ sql: string; params?: unknown[] }> = [];

    return {
        executedQueries,
        nextChangeId: 1, // configurable for tests
        async execute(sql: string, params?: unknown[]): Promise<number> {
            executedQueries.push({ sql, params });
            return 1;
        },
        async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
            executedQueries.push({ sql, params });
            // Return configured change_id for COALESCE query
            if (sql.includes('COALESCE(MAX(change_id)')) {
                return [{ next_id: this.nextChangeId }] as T[];
            }
            return [] as T[];
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
function createMockModel(
    name: string,
    trackedFields: Set<string> = new Set()
): Model {
    return {
        modelName: name,
        isFrozen: false,
        isImmutable: false,
        requiresSudo: false,
        getImmutableFields: () => new Set(),
        getTrackedFields: () => trackedFields,
        getTransformFields: () => new Map(),
        getValidationFields: () => [],
        getFields: () => [],
    };
}

/**
 * Create a mock record for testing with getDiffForFields support
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
                if (oldData[field] !== newData[field]) {
                    diff[field] = { old: oldData[field], new: newData[field] };
                }
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

/**
 * Create a context for testing observers
 */
function createContext(
    operation: 'create' | 'update' | 'delete',
    modelName: string,
    record: ModelRecord,
    db: DatabaseAdapter,
    trackedFields: Set<string> = new Set()
): ObserverContext {
    return {
        system: {
            db,
            cache: createMockCache(),
        },
        operation,
        model: createMockModel(modelName, trackedFields),
        record,
        recordIndex: 0,
        errors: [],
        warnings: [],
    };
}

// =============================================================================
// TRACKED OBSERVER TESTS
// =============================================================================

describe('Tracked', () => {
    let observer: Tracked;
    let mockDb: ReturnType<typeof createMockDatabase>;

    beforeEach(() => {
        observer = new Tracked();
        mockDb = createMockDatabase();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('Tracked');
        });

        it('should be in Ring 7 (Audit)', () => {
            expect(observer.ring).toBe(ObserverRing.Audit);
        });

        it('should have priority 60', () => {
            expect(observer.priority).toBe(60);
        });

        it('should handle create, update, and delete operations', () => {
            expect(observer.operations).toContain('create');
            expect(observer.operations).toContain('update');
            expect(observer.operations).toContain('delete');
            expect(observer.operations).toHaveLength(3);
        });

        it('should not have model filter (runs for all models)', () => {
            expect(observer.models).toBeUndefined();
        });
    });

    describe('skipping conditions', () => {
        it('should skip when model has no tracked fields', async () => {
            const record = createMockRecord(
                { id: 'abc123', name: 'Old' },
                { name: 'New' }
            );
            const ctx = createContext('update', 'invoices', record, mockDb, new Set());

            await observer.execute(ctx);

            // No queries should be executed
            expect(mockDb.executedQueries).toHaveLength(0);
        });

        it('should skip when no tracked fields were changed', async () => {
            const trackedFields = new Set(['amount']); // track 'amount', not 'name'
            const record = createMockRecord(
                { id: 'abc123', name: 'Old', amount: 100 },
                { name: 'New' } // only 'name' changed, not 'amount'
            );
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);

            await observer.execute(ctx);

            // No insert should happen (only the change_id query would be skipped too)
            const inserts = mockDb.executedQueries.filter(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            expect(inserts).toHaveLength(0);
        });

        it('should skip when record has no id', async () => {
            const trackedFields = new Set(['name']);
            const record = createMockRecord(
                { name: 'Old' }, // no id
                { name: 'New' }
            );
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);

            await observer.execute(ctx);

            const inserts = mockDb.executedQueries.filter(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            expect(inserts).toHaveLength(0);
        });
    });

    describe('audit on create', () => {
        it('should record tracked field values on create', async () => {
            const trackedFields = new Set(['amount', 'status']);
            const record = createMockRecord(
                {}, // new record
                { id: 'inv-123', amount: 100, status: 'pending', notes: 'test' }
            );
            const ctx = createContext('create', 'invoices', record, mockDb, trackedFields);

            await observer.execute(ctx);

            // Should have 2 queries: change_id SELECT and INSERT
            expect(mockDb.executedQueries).toHaveLength(2);

            const insert = mockDb.executedQueries.find(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            expect(insert).toBeDefined();
            expect(insert!.params).toContain('invoices');
            expect(insert!.params).toContain('inv-123');
            expect(insert!.params).toContain('create');

            // Changes should only include tracked fields
            const changesJson = insert!.params![5] as string;
            const changes = JSON.parse(changesJson);
            expect(changes).toHaveProperty('amount');
            expect(changes).toHaveProperty('status');
            expect(changes).not.toHaveProperty('notes'); // not tracked
        });
    });

    describe('audit on update', () => {
        it('should record old and new values for tracked fields', async () => {
            const trackedFields = new Set(['amount']);
            const record = createMockRecord(
                { id: 'inv-123', amount: 100, name: 'Invoice 1' },
                { amount: 200 }
            );
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);

            await observer.execute(ctx);

            const insert = mockDb.executedQueries.find(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            expect(insert).toBeDefined();
            expect(insert!.params).toContain('update');

            const changesJson = insert!.params![5] as string;
            const changes = JSON.parse(changesJson);
            expect(changes.amount).toEqual({ old: 100, new: 200 });
        });

        it('should only record tracked fields that changed', async () => {
            const trackedFields = new Set(['amount', 'status']);
            const record = createMockRecord(
                { id: 'inv-123', amount: 100, status: 'pending' },
                { amount: 200 } // only amount changed, not status
            );
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);

            await observer.execute(ctx);

            const insert = mockDb.executedQueries.find(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            const changesJson = insert!.params![5] as string;
            const changes = JSON.parse(changesJson);

            expect(changes).toHaveProperty('amount');
            expect(changes).not.toHaveProperty('status'); // not changed
        });
    });

    describe('audit on delete', () => {
        it('should record final state on delete', async () => {
            const trackedFields = new Set(['amount']);
            const record = createMockRecord(
                { id: 'inv-123', amount: 100 },
                { trashed_at: '2025-01-01T00:00:00.000Z' }
            );
            // For delete, we track the trashed_at or other changes
            const ctx = createContext('delete', 'invoices', record, mockDb, new Set(['trashed_at']));

            await observer.execute(ctx);

            const insert = mockDb.executedQueries.find(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            expect(insert).toBeDefined();
            expect(insert!.params).toContain('delete');
        });
    });

    describe('change_id handling', () => {
        it('should calculate next change_id for record', async () => {
            const trackedFields = new Set(['amount']);
            const record = createMockRecord(
                { id: 'inv-123', amount: 100 },
                { amount: 200 }
            );
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);

            // Configure mock to return existing change_id
            mockDb.nextChangeId = 5;

            await observer.execute(ctx);

            const insert = mockDb.executedQueries.find(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            // change_id should be 5 (second parameter after id)
            expect(insert!.params![1]).toBe(5);
        });

        it('should start at 1 for first change to record', async () => {
            const trackedFields = new Set(['amount']);
            const record = createMockRecord(
                { id: 'inv-new', amount: 100 },
                { amount: 200 }
            );
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);

            // Default mock returns next_id = 1

            await observer.execute(ctx);

            const insert = mockDb.executedQueries.find(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            expect(insert!.params![1]).toBe(1);
        });
    });

    describe('generated fields', () => {
        it('should generate unique id for audit record', async () => {
            const trackedFields = new Set(['amount']);

            // Create two records
            const record1 = createMockRecord(
                { id: 'inv-1', amount: 100 },
                { amount: 200 }
            );
            const record2 = createMockRecord(
                { id: 'inv-2', amount: 300 },
                { amount: 400 }
            );

            const ctx1 = createContext('update', 'invoices', record1, mockDb, trackedFields);
            const ctx2 = createContext('update', 'invoices', record2, mockDb, trackedFields);

            await observer.execute(ctx1);
            await observer.execute(ctx2);

            const inserts = mockDb.executedQueries.filter(q =>
                q.sql.includes('INSERT INTO tracked')
            );

            // IDs should be different (first param)
            const id1 = inserts[0].params![0] as string;
            const id2 = inserts[1].params![0] as string;
            expect(id1).not.toBe(id2);
        });

        it('should generate id without hyphens', async () => {
            const trackedFields = new Set(['amount']);
            const record = createMockRecord(
                { id: 'inv-123', amount: 100 },
                { amount: 200 }
            );
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);

            await observer.execute(ctx);

            const insert = mockDb.executedQueries.find(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            const id = insert!.params![0] as string;
            expect(id).not.toContain('-');
            expect(id).toHaveLength(32); // UUID without hyphens
        });
    });

    describe('edge cases', () => {
        it('should handle null to value change', async () => {
            const trackedFields = new Set(['amount']);
            const record = createMockRecord(
                { id: 'inv-123', amount: null },
                { amount: 100 }
            );
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);

            await observer.execute(ctx);

            const insert = mockDb.executedQueries.find(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            const changesJson = insert!.params![5] as string;
            const changes = JSON.parse(changesJson);
            expect(changes.amount).toEqual({ old: null, new: 100 });
        });

        it('should handle value to null change', async () => {
            const trackedFields = new Set(['amount']);
            const record = createMockRecord(
                { id: 'inv-123', amount: 100 },
                { amount: null }
            );
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);

            await observer.execute(ctx);

            const insert = mockDb.executedQueries.find(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            const changesJson = insert!.params![5] as string;
            const changes = JSON.parse(changesJson);
            expect(changes.amount).toEqual({ old: 100, new: null });
        });

        it('should handle multiple tracked fields changing', async () => {
            const trackedFields = new Set(['amount', 'status', 'priority']);
            const record = createMockRecord(
                { id: 'inv-123', amount: 100, status: 'pending', priority: 1 },
                { amount: 200, status: 'paid', priority: 2 }
            );
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);

            await observer.execute(ctx);

            const insert = mockDb.executedQueries.find(q =>
                q.sql.includes('INSERT INTO tracked')
            );
            const changesJson = insert!.params![5] as string;
            const changes = JSON.parse(changesJson);

            expect(Object.keys(changes)).toHaveLength(3);
            expect(changes.amount).toEqual({ old: 100, new: 200 });
            expect(changes.status).toEqual({ old: 'pending', new: 'paid' });
            expect(changes.priority).toEqual({ old: 1, new: 2 });
        });
    });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Ring 7 Integration', () => {
    it('should export Tracked from index', async () => {
        const exports = await import('@src/model/ring/7/index.js');
        expect(exports.Tracked).toBeDefined();
    });

    it('should be importable from registry', async () => {
        const { createObserverRunner } = await import('@src/model/observers/registry.js');
        const runner = createObserverRunner();

        // Runner should be created without errors
        expect(runner).toBeDefined();
    });

    it('should have correct ring ordering (Ring 7 > Ring 6 > Ring 5)', () => {
        // Verify ring enum values enforce correct ordering
        const { ObserverRing } = require('@src/model/observers/index.js');

        // Ring 7 (Audit) should be greater than Ring 6 (PostDatabase)
        expect(ObserverRing.Audit).toBeGreaterThan(ObserverRing.PostDatabase);

        // Ring 6 (PostDatabase) should be greater than Ring 5 (Database)
        expect(ObserverRing.PostDatabase).toBeGreaterThan(ObserverRing.Database);
    });
});

// =============================================================================
// PROOF TESTS
// =============================================================================

describe('Audit proof', () => {
    it('should create complete audit trail for tracked field changes', async () => {
        const { Tracked } = await import('@src/model/ring/7/index.js');
        const mockDb = createMockDatabase();
        const observer = new Tracked();

        const trackedFields = new Set(['amount', 'status']);

        // Simulate multiple updates to same record
        const updates = [
            { old: { id: 'inv-1', amount: 100, status: 'draft' }, new: { amount: 150 } },
            { old: { id: 'inv-1', amount: 150, status: 'draft' }, new: { status: 'pending' } },
            { old: { id: 'inv-1', amount: 150, status: 'pending' }, new: { amount: 200, status: 'paid' } },
        ];

        for (const update of updates) {
            // Increment change_id for each update
            mockDb.nextChangeId++;
            const record = createMockRecord(update.old, update.new);
            const ctx = createContext('update', 'invoices', record, mockDb, trackedFields);
            await observer.execute(ctx);
        }

        // Should have 3 inserts (6 queries total: 3 selects + 3 inserts)
        const inserts = mockDb.executedQueries.filter(q =>
            q.sql.includes('INSERT INTO tracked')
        );
        expect(inserts).toHaveLength(3);

        // Each insert should have the correct operation
        for (const insert of inserts) {
            expect(insert.params).toContain('update');
            expect(insert.params).toContain('invoices');
            expect(insert.params).toContain('inv-1');
        }
    });
});
