/**
 * Ring 1: Frozen Observer Tests
 *
 * Tests for the Frozen observer which blocks all changes to frozen models.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Frozen } from '@src/ems/ring/1/index.js';
import { ObserverRing, EOBSFROZEN } from '@src/ems/observers/index.js';
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
        async transaction(_statements: Array<{ sql: string; params?: unknown[] }>): Promise<number[]> {
            return [];
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
function createMockModel(name = 'test_model', frozen = false): Model {
    return {
        modelName: name,
        isFrozen: frozen,
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
    model: Model,
    record?: ModelRecord
): ObserverContext {
    return {
        system: {
            db: createMockDatabase(),
            cache: createMockCache(),
        },
        operation,
        model,
        record: record ?? createMockRecord({}, { id: 'test-id' }),
        recordIndex: 0,
        errors: [],
        warnings: [],
    };
}

// =============================================================================
// FROZEN OBSERVER TESTS
// =============================================================================

describe('Frozen', () => {
    let observer: Frozen;

    beforeEach(() => {
        observer = new Frozen();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('Frozen');
        });

        it('should be in Ring 1 (InputValidation)', () => {
            expect(observer.ring).toBe(ObserverRing.InputValidation);
        });

        it('should have priority 10', () => {
            expect(observer.priority).toBe(10);
        });

        it('should handle create, update, and delete operations', () => {
            expect(observer.operations).toContain('create');
            expect(observer.operations).toContain('update');
            expect(observer.operations).toContain('delete');
            expect(observer.operations).toHaveLength(3);
        });
    });

    describe('non-frozen models', () => {
        it('should allow create on non-frozen model', async () => {
            const model = createMockModel('users', false);
            const ctx = createContext('create', model);

            // Should not throw
            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should allow update on non-frozen model', async () => {
            const model = createMockModel('users', false);
            const ctx = createContext('update', model);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should allow delete on non-frozen model', async () => {
            const model = createMockModel('users', false);
            const ctx = createContext('delete', model);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });
    });

    describe('frozen models', () => {
        it('should block create on frozen model', async () => {
            const model = createMockModel('audit_logs', true);
            const ctx = createContext('create', model);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSFROZEN);
        });

        it('should block update on frozen model', async () => {
            const model = createMockModel('audit_logs', true);
            const ctx = createContext('update', model);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSFROZEN);
        });

        it('should block delete on frozen model', async () => {
            const model = createMockModel('audit_logs', true);
            const ctx = createContext('delete', model);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSFROZEN);
        });

        it('should include model name in error message', async () => {
            const model = createMockModel('historical_data', true);
            const ctx = createContext('create', model);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSFROZEN);
                expect((err as EOBSFROZEN).message).toContain('historical_data');
                expect((err as EOBSFROZEN).message).toContain('frozen');
            }
        });

        it('should have correct error code', async () => {
            const model = createMockModel('frozen_model', true);
            const ctx = createContext('update', model);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSFROZEN);
                expect((err as EOBSFROZEN).code).toBe('EOBSFROZEN');
                expect((err as EOBSFROZEN).errno).toBe(1002);
            }
        });
    });
});
