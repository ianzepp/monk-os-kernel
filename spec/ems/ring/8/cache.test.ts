/**
 * Ring 8: Cache Observer Tests
 *
 * Tests for the Cache observer which invalidates model metadata
 * when records in 'models' or 'fields' tables are modified.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Cache } from '@src/ems/ring/8/index.js';
import { ObserverRing } from '@src/ems/observers/index.js';
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
 * Create a mock cache adapter that tracks invalidations
 */
function createMockCache(): ModelCacheAdapter & { invalidatedModels: string[] } {
    const invalidatedModels: string[] = [];
    return {
        invalidatedModels,
        invalidate(modelName: string): void {
            invalidatedModels.push(modelName);
        },
    };
}

/**
 * Create a mock model for testing
 */
function createMockModel(name: string): Model {
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

/**
 * Create a context for testing observers
 */
function createContext(
    operation: 'create' | 'update' | 'delete',
    modelName: string,
    record: ModelRecord,
    cache: ModelCacheAdapter
): ObserverContext {
    return {
        system: {
            db: createMockDatabase(),
            cache,
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
// CACHE OBSERVER TESTS
// =============================================================================

describe('Cache', () => {
    let observer: Cache;
    let mockCache: ReturnType<typeof createMockCache>;

    beforeEach(() => {
        observer = new Cache();
        mockCache = createMockCache();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('Cache');
        });

        it('should be in Ring 8 (Integration)', () => {
            expect(observer.ring).toBe(ObserverRing.Integration);
        });

        it('should have priority 50', () => {
            expect(observer.priority).toBe(50);
        });

        it('should handle create, update, and delete operations', () => {
            expect(observer.operations).toContain('create');
            expect(observer.operations).toContain('update');
            expect(observer.operations).toContain('delete');
            expect(observer.operations).toHaveLength(3);
        });

        it('should only run for models and fields tables', () => {
            expect(observer.models).toContain('models');
            expect(observer.models).toContain('fields');
            expect(observer.models).toHaveLength(2);
        });
    });

    describe('cache invalidation on models table', () => {
        it('should invalidate cache on model create', async () => {
            const record = createMockRecord({}, {
                id: 'model-123',
                model_name: 'invoices',
            });
            const ctx = createContext('create', 'models', record, mockCache);

            await observer.execute(ctx);

            expect(mockCache.invalidatedModels).toContain('invoices');
            expect(mockCache.invalidatedModels).toHaveLength(1);
        });

        it('should invalidate cache on model update', async () => {
            // The get() method returns merged, so model_name is available
            const mergedRecord = createMockRecord(
                { id: 'model-123', model_name: 'invoices', frozen: 0 },
                { frozen: 1 }
            );
            // Override get to return from merged
            (mergedRecord as unknown as { get: (f: string) => unknown }).get = (field: string) => {
                const merged = { id: 'model-123', model_name: 'invoices', frozen: 1 };
                return merged[field as keyof typeof merged];
            };

            const ctx = createContext('update', 'models', mergedRecord, mockCache);

            await observer.execute(ctx);

            expect(mockCache.invalidatedModels).toContain('invoices');
        });

        it('should invalidate cache on model delete', async () => {
            const record = createMockRecord(
                { id: 'model-123', model_name: 'old_table' },
                { trashed_at: new Date().toISOString() }
            );
            // Override get for merged access
            (record as unknown as { get: (f: string) => unknown }).get = (field: string) => {
                if (field === 'model_name') return 'old_table';
                if (field === 'trashed_at') return new Date().toISOString();
                return undefined;
            };

            const ctx = createContext('delete', 'models', record, mockCache);

            await observer.execute(ctx);

            expect(mockCache.invalidatedModels).toContain('old_table');
        });
    });

    describe('cache invalidation on fields table', () => {
        it('should invalidate parent model cache on field create', async () => {
            const record = createMockRecord({}, {
                id: 'field-123',
                model_name: 'invoices',
                field_name: 'amount',
                type: 'number',
            });
            const ctx = createContext('create', 'fields', record, mockCache);

            await observer.execute(ctx);

            // Should invalidate the parent model 'invoices', not 'fields'
            expect(mockCache.invalidatedModels).toContain('invoices');
            expect(mockCache.invalidatedModels).not.toContain('fields');
        });

        it('should invalidate parent model cache on field update', async () => {
            const record = createMockRecord(
                { id: 'field-123', model_name: 'products', field_name: 'price' },
                { required: 1 }
            );
            // Override get for merged access
            (record as unknown as { get: (f: string) => unknown }).get = (field: string) => {
                if (field === 'model_name') return 'products';
                return undefined;
            };

            const ctx = createContext('update', 'fields', record, mockCache);

            await observer.execute(ctx);

            expect(mockCache.invalidatedModels).toContain('products');
        });

        it('should invalidate parent model cache on field delete', async () => {
            const record = createMockRecord(
                { id: 'field-123', model_name: 'customers', field_name: 'obsolete_field' },
                { trashed_at: new Date().toISOString() }
            );
            // Override get for merged access
            (record as unknown as { get: (f: string) => unknown }).get = (field: string) => {
                if (field === 'model_name') return 'customers';
                return undefined;
            };

            const ctx = createContext('delete', 'fields', record, mockCache);

            await observer.execute(ctx);

            expect(mockCache.invalidatedModels).toContain('customers');
        });
    });

    describe('edge cases', () => {
        it('should not throw when model_name is missing', async () => {
            const record = createMockRecord({}, {
                id: 'bad-record',
                // model_name intentionally missing
            });
            const ctx = createContext('create', 'models', record, mockCache);

            // Should not throw
            await expect(observer.execute(ctx)).resolves.toBeUndefined();

            // Should not have invalidated anything
            expect(mockCache.invalidatedModels).toHaveLength(0);
        });

        it('should not throw when model_name is null', async () => {
            const record = createMockRecord({}, {
                id: 'null-model',
                model_name: null,
            });
            const ctx = createContext('create', 'models', record, mockCache);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
            expect(mockCache.invalidatedModels).toHaveLength(0);
        });

        it('should not throw when model_name is empty string', async () => {
            const record = createMockRecord({}, {
                id: 'empty-model',
                model_name: '',
            });
            const ctx = createContext('create', 'models', record, mockCache);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
            // Empty string is falsy, so no invalidation
            expect(mockCache.invalidatedModels).toHaveLength(0);
        });

        it('should be idempotent - multiple invalidations are fine', async () => {
            // Simulate creating multiple fields for the same model
            for (let i = 0; i < 3; i++) {
                const record = createMockRecord({}, {
                    id: `field-${i}`,
                    model_name: 'invoices',
                    field_name: `field_${i}`,
                });
                const ctx = createContext('create', 'fields', record, mockCache);
                await observer.execute(ctx);
            }

            // All three should have invalidated 'invoices'
            expect(mockCache.invalidatedModels).toEqual(['invoices', 'invoices', 'invoices']);
        });
    });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Ring 8 Integration', () => {
    it('should export Cache from index', async () => {
        const exports = await import('@src/ems/ring/8/index.js');
        expect(exports.Cache).toBeDefined();
    });

    it('should be importable from registry', async () => {
        // Verify the registry imports and uses Cache
        const { createObserverRunner } = await import('@src/ems/observers/registry.js');
        const runner = createObserverRunner();

        // Runner should be created without errors
        expect(runner).toBeDefined();
    });

    it('should have correct ring ordering (Ring 8 > Ring 6 > Ring 5)', () => {
        // Verify ring enum values enforce correct ordering
        const { ObserverRing } = require('@src/ems/observers/index.js');

        // Ring 8 (Integration) should be greater than Ring 6 (PostDatabase)
        expect(ObserverRing.Integration).toBeGreaterThan(ObserverRing.PostDatabase);

        // Ring 6 (PostDatabase) should be greater than Ring 5 (Database)
        expect(ObserverRing.PostDatabase).toBeGreaterThan(ObserverRing.Database);
    });
});

// =============================================================================
// PROOF THAT CACHE IS INVALIDATED CORRECTLY
// =============================================================================

describe('Cache invalidation proof', () => {
    it('should invalidate cache when model metadata changes', async () => {
        // This test verifies that the Cache observer properly clears
        // cached model definitions when they change

        const { Cache } = await import('@src/ems/ring/8/index.js');
        const cache = createMockCache();
        const observer = new Cache();

        // Simulate updating a model's frozen flag
        const record = createMockRecord(
            { id: 'model-1', model_name: 'invoices', frozen: 0 },
            { frozen: 1 }
        );
        (record as unknown as { get: (f: string) => unknown }).get = (field: string) => {
            if (field === 'model_name') return 'invoices';
            if (field === 'frozen') return 1;
            return undefined;
        };

        const ctx = createContext('update', 'models', record, cache);
        await observer.execute(ctx);

        // The 'invoices' model should be invalidated
        expect(cache.invalidatedModels).toContain('invoices');

        // This means next access to ModelCache.get('invoices') will
        // reload fresh data from the database
    });

    it('should invalidate cache when field is added to model', async () => {
        const { Cache } = await import('@src/ems/ring/8/index.js');
        const cache = createMockCache();
        const observer = new Cache();

        // Simulate adding a new field to 'products' model
        const record = createMockRecord({}, {
            id: 'field-new',
            model_name: 'products',
            field_name: 'discount',
            type: 'number',
        });

        const ctx = createContext('create', 'fields', record, cache);
        await observer.execute(ctx);

        // The 'products' model should be invalidated (not 'fields')
        expect(cache.invalidatedModels).toContain('products');
        expect(cache.invalidatedModels).not.toContain('fields');
    });
});
