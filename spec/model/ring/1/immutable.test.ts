/**
 * Ring 1: Immutable Observer Tests
 *
 * Tests for the Immutable observer which blocks changes to immutable fields.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Immutable } from '@src/model/ring/1/index.js';
import { ObserverRing, EOBSIMMUT } from '@src/model/observers/index.js';
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
 * Create a mock database adapter
 */
function createMockDatabase(): DatabaseAdapter {
    return {
        async execute(_sql: string, _params?: unknown[]): Promise<number> {
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
function createMockModel(
    name = 'test_model',
    immutableFields: string[] = []
): Model {
    return {
        modelName: name,
        isFrozen: false,
        isImmutable: false,
        requiresSudo: false,
        getImmutableFields: () => new Set(immutableFields),
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
    model: Model,
    record: ModelRecord
): ObserverContext {
    return {
        system: {
            db: createMockDatabase(),
            cache: createMockCache(),
        },
        operation,
        model,
        record,
        recordIndex: 0,
        errors: [],
        warnings: [],
    };
}

// =============================================================================
// IMMUTABLE OBSERVER TESTS
// =============================================================================

describe('Immutable', () => {
    let observer: Immutable;

    beforeEach(() => {
        observer = new Immutable();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('Immutable');
        });

        it('should be in Ring 1 (InputValidation)', () => {
            expect(observer.ring).toBe(ObserverRing.InputValidation);
        });

        it('should have priority 30', () => {
            expect(observer.priority).toBe(30);
        });

        it('should only handle update operations', () => {
            expect(observer.operations).toEqual(['update']);
        });
    });

    describe('no immutable fields', () => {
        it('should allow any changes when model has no immutable fields', async () => {
            const model = createMockModel('users', []);
            const record = createMockRecord(
                { id: '123', name: 'Old Name', email: 'old@test.com' },
                { name: 'New Name', email: 'new@test.com' }
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });
    });

    describe('immutable fields - allowed changes', () => {
        it('should allow changing non-immutable fields', async () => {
            const model = createMockModel('orders', ['customer_id']);
            const record = createMockRecord(
                { id: '123', customer_id: 'cust-1', status: 'pending' },
                { status: 'completed' }
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should allow first write to immutable field (old was null)', async () => {
            const model = createMockModel('orders', ['customer_id']);
            const record = createMockRecord(
                { id: '123', customer_id: null, status: 'draft' },
                { customer_id: 'cust-1' }
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should allow first write to immutable field (old was undefined)', async () => {
            const model = createMockModel('orders', ['customer_id']);
            const record = createMockRecord(
                { id: '123', status: 'draft' }, // customer_id not present
                { customer_id: 'cust-1' }
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should allow setting immutable field to same value', async () => {
            const model = createMockModel('orders', ['customer_id']);
            const record = createMockRecord(
                { id: '123', customer_id: 'cust-1' },
                { customer_id: 'cust-1' } // Same value
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should handle deep equality for objects', async () => {
            const model = createMockModel('configs', ['settings']);
            const record = createMockRecord(
                { id: '123', settings: { theme: 'dark', lang: 'en' } },
                { settings: { theme: 'dark', lang: 'en' } } // Same object
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should handle deep equality for arrays', async () => {
            const model = createMockModel('items', ['tags']);
            const record = createMockRecord(
                { id: '123', tags: ['a', 'b', 'c'] },
                { tags: ['a', 'b', 'c'] } // Same array
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });
    });

    describe('immutable fields - blocked changes', () => {
        it('should block changing immutable string field', async () => {
            const model = createMockModel('orders', ['customer_id']);
            const record = createMockRecord(
                { id: '123', customer_id: 'cust-1' },
                { customer_id: 'cust-2' }
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSIMMUT);
        });

        it('should block changing immutable number field', async () => {
            const model = createMockModel('transactions', ['amount']);
            const record = createMockRecord(
                { id: '123', amount: 100 },
                { amount: 200 }
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSIMMUT);
        });

        it('should block changing immutable object field', async () => {
            const model = createMockModel('configs', ['settings']);
            const record = createMockRecord(
                { id: '123', settings: { theme: 'dark' } },
                { settings: { theme: 'light' } }
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSIMMUT);
        });

        it('should block changing immutable array field', async () => {
            const model = createMockModel('items', ['tags']);
            const record = createMockRecord(
                { id: '123', tags: ['a', 'b'] },
                { tags: ['a', 'b', 'c'] }
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSIMMUT);
        });

        it('should include field name in error', async () => {
            const model = createMockModel('orders', ['customer_id']);
            const record = createMockRecord(
                { id: '123', customer_id: 'cust-1' },
                { customer_id: 'cust-2' }
            );
            const ctx = createContext('update', model, record);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSIMMUT);
                expect((err as EOBSIMMUT).field).toBe('customer_id');
                expect((err as EOBSIMMUT).message).toContain('customer_id');
            }
        });

        it('should include old value in error message', async () => {
            const model = createMockModel('orders', ['customer_id']);
            const record = createMockRecord(
                { id: '123', customer_id: 'cust-1' },
                { customer_id: 'cust-2' }
            );
            const ctx = createContext('update', model, record);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect((err as EOBSIMMUT).message).toContain('cust-1');
            }
        });

        it('should have correct error code', async () => {
            const model = createMockModel('orders', ['customer_id']);
            const record = createMockRecord(
                { id: '123', customer_id: 'cust-1' },
                { customer_id: 'cust-2' }
            );
            const ctx = createContext('update', model, record);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSIMMUT);
                expect((err as EOBSIMMUT).code).toBe('EOBSIMMUT');
                expect((err as EOBSIMMUT).errno).toBe(1003);
            }
        });
    });

    describe('multiple immutable fields', () => {
        it('should allow update when no immutable fields are changed', async () => {
            const model = createMockModel('orders', ['customer_id', 'order_type']);
            const record = createMockRecord(
                { id: '123', customer_id: 'cust-1', order_type: 'sale', status: 'pending' },
                { status: 'completed' }
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should block when one of multiple immutable fields is changed', async () => {
            const model = createMockModel('orders', ['customer_id', 'order_type']);
            const record = createMockRecord(
                { id: '123', customer_id: 'cust-1', order_type: 'sale' },
                { order_type: 'return' }
            );
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSIMMUT);
        });

        it('should report first violation when multiple immutable fields changed', async () => {
            const model = createMockModel('orders', ['customer_id', 'order_type']);
            const record = createMockRecord(
                { id: '123', customer_id: 'cust-1', order_type: 'sale' },
                { customer_id: 'cust-2', order_type: 'return' }
            );
            const ctx = createContext('update', model, record);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSIMMUT);
                // Should mention both fields in the message
                expect((err as EOBSIMMUT).message).toContain('customer_id');
                expect((err as EOBSIMMUT).message).toContain('order_type');
            }
        });
    });
});
