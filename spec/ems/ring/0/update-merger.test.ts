/**
 * Ring 0: UpdateMerger Observer Tests
 *
 * Tests for the UpdateMerger observer which prepares record data
 * for UPDATE operations by setting the updated_at timestamp.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { UpdateMerger } from '@src/ems/ring/0/index.js';
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
 * Create a mock record for testing with mutable state
 */
function createMockRecord(
    oldData: Record<string, unknown> = {},
    newData: Record<string, unknown> = {}
): ModelRecord & { _newData: Record<string, unknown> } {
    const _newData = { ...newData };
    const merged = { ...oldData, ..._newData };

    return {
        _newData,
        isNew: () => Object.keys(oldData).length === 0,
        old: (field: string) => oldData[field],
        get: (field: string) => (field in _newData ? _newData[field] : oldData[field]),
        has: (field: string) => field in _newData,
        set: (field: string, value: unknown) => {
            _newData[field] = value;
            merged[field] = value;
        },
        getChangedFields: () => Object.keys(_newData),
        toRecord: () => ({ ...oldData, ..._newData }),
        toChanges: () => ({ ..._newData }),
        getDiff: () => {
            const diff: Record<string, { old: unknown; new: unknown }> = {};
            for (const field of Object.keys(_newData)) {
                diff[field] = { old: oldData[field], new: _newData[field] };
            }
            return diff;
        },
        getDiffForFields: (fields: Set<string>) => {
            const diff: Record<string, { old: unknown; new: unknown }> = {};
            for (const field of Object.keys(_newData)) {
                if (!fields.has(field)) continue;
                if (oldData[field] !== _newData[field]) {
                    diff[field] = { old: oldData[field], new: _newData[field] };
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
    record: ModelRecord,
    modelName = 'test_model'
): ObserverContext {
    return {
        system: {
            db: createMockDatabase(),
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
// UPDATE MERGER TESTS
// =============================================================================

describe('UpdateMerger', () => {
    let observer: UpdateMerger;

    beforeEach(() => {
        observer = new UpdateMerger();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('UpdateMerger');
        });

        it('should be in Ring 0 (DataPreparation)', () => {
            expect(observer.ring).toBe(ObserverRing.DataPreparation);
        });

        it('should have priority 50', () => {
            expect(observer.priority).toBe(50);
        });

        it('should only handle update operations', () => {
            expect(observer.operations).toEqual(['update']);
            expect(observer.operations).toHaveLength(1);
        });

        it('should not have model filter (runs for all models)', () => {
            expect(observer.models).toBeUndefined();
        });
    });

    describe('updated_at handling', () => {
        it('should set updated_at when not provided', async () => {
            const record = createMockRecord(
                { id: 'abc123', name: 'Old' },
                { name: 'New' }
            );
            const ctx = createContext('update', record);

            await observer.execute(ctx);

            // updated_at should now be set
            expect(record.has('updated_at')).toBe(true);
            expect(record.get('updated_at')).toBeDefined();
        });

        it('should NOT overwrite updated_at if explicitly provided', async () => {
            const explicitTimestamp = '2025-01-01T00:00:00.000Z';
            const record = createMockRecord(
                { id: 'abc123', name: 'Old' },
                { name: 'New', updated_at: explicitTimestamp }
            );
            const ctx = createContext('update', record);

            await observer.execute(ctx);

            // Should keep the explicit timestamp
            expect(record.get('updated_at')).toBe(explicitTimestamp);
        });

        it('should set updated_at as ISO 8601 string', async () => {
            const record = createMockRecord(
                { id: 'abc123', name: 'Old' },
                { name: 'New' }
            );
            const ctx = createContext('update', record);

            await observer.execute(ctx);

            const updatedAt = record.get('updated_at') as string;
            // ISO 8601 format: 2024-01-15T10:30:00.000Z
            expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        });

        it('should set updated_at to current time', async () => {
            const before = new Date().toISOString();

            const record = createMockRecord(
                { id: 'abc123', name: 'Old' },
                { name: 'New' }
            );
            const ctx = createContext('update', record);

            await observer.execute(ctx);

            const after = new Date().toISOString();
            const updatedAt = record.get('updated_at') as string;

            // updated_at should be between before and after
            expect(updatedAt >= before).toBe(true);
            expect(updatedAt <= after).toBe(true);
        });
    });

    describe('edge cases', () => {
        it('should handle record with no changes', async () => {
            const record = createMockRecord(
                { id: 'abc123', name: 'Same' },
                {} // No changes
            );
            const ctx = createContext('update', record);

            // Should not throw
            await expect(observer.execute(ctx)).resolves.toBeUndefined();

            // updated_at should still be set
            expect(record.has('updated_at')).toBe(true);
        });

        it('should handle record with only id', async () => {
            const record = createMockRecord(
                { id: 'abc123' },
                {}
            );
            const ctx = createContext('update', record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
            expect(record.has('updated_at')).toBe(true);
        });

        it('should work with any model', async () => {
            const record = createMockRecord(
                { id: 'abc123', data: 'test' },
                { data: 'updated' }
            );

            // Test with different model names
            for (const modelName of ['users', 'invoices', 'products', 'models', 'fields']) {
                const ctx = createContext('update', record, modelName);
                await expect(observer.execute(ctx)).resolves.toBeUndefined();
            }
        });
    });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Ring 0 Integration', () => {
    it('should export UpdateMerger from index', async () => {
        const exports = await import('@src/ems/ring/0/index.js');
        expect(exports.UpdateMerger).toBeDefined();
    });

    it('should be importable from registry', async () => {
        // Verify the registry imports and uses UpdateMerger
        const { createObserverRunner } = await import('@src/ems/observers/registry.js');
        const runner = createObserverRunner();

        // Runner should be created without errors
        expect(runner).toBeDefined();
    });
});
