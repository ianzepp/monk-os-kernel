/**
 * PathCacheSync Observer Tests
 *
 * Tests for the Ring 8 PathCacheSync observer which keeps the PathCache
 * in sync with database mutations.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { PathCacheSync } from '@src/ems/ring/8/60-path-cache.js';
import { ObserverRing } from '@src/ems/observers/types.js';
import { ModelRecord } from '@src/ems/model-record.js';
import { getDialect } from '@src/hal/dialect.js';
import type { ObserverContext, Model, SystemContext } from '@src/ems/observers/interfaces.js';

// =============================================================================
// MOCK PATH CACHE
// =============================================================================

interface AddEntryInput {
    id: string;
    model: string;
    parent: string | null;
    pathname: string;
}

interface UpdateEntryInput {
    pathname?: string;
    parent?: string | null;
}

class MockPathCache {
    addedEntries: AddEntryInput[] = [];
    updatedEntries: Array<{ id: string; changes: UpdateEntryInput }> = [];
    removedEntryIds: string[] = [];

    addEntry(input: AddEntryInput): void {
        this.addedEntries.push(input);
    }

    updateEntry(id: string, changes: UpdateEntryInput): void {
        this.updatedEntries.push({ id, changes });
    }

    removeEntry(id: string): void {
        this.removedEntryIds.push(id);
    }

    reset(): void {
        this.addedEntries = [];
        this.updatedEntries = [];
        this.removedEntryIds = [];
    }
}

// =============================================================================
// MOCK MODEL
// =============================================================================

function createMockModel(modelName: string): Model {
    return {
        modelName,
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

// =============================================================================
// MOCK SYSTEM CONTEXT
// =============================================================================

function createMockSystemContext(pathCache?: MockPathCache): SystemContext & { pathCache?: MockPathCache } {
    return {
        db: {
            dialect: getDialect('sqlite'),
            execute: async () => 0,
            query: async () => [],
            exec: async () => {},
            transaction: async () => [],
        },
        cache: {
            invalidate: () => {},
        },
        pathCache,
    };
}

// =============================================================================
// TESTS
// =============================================================================

describe('PathCacheSync', () => {
    let observer: PathCacheSync;
    let mockCache: MockPathCache;

    beforeEach(() => {
        observer = new PathCacheSync();
        mockCache = new MockPathCache();
    });

    // =========================================================================
    // CONFIGURATION TESTS
    // =========================================================================

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('PathCacheSync');
        });

        it('should be in Ring 8 (Integration)', () => {
            expect(observer.ring).toBe(ObserverRing.Integration);
        });

        it('should have priority 60', () => {
            expect(observer.priority).toBe(60);
        });

        it('should handle create, update, delete operations', () => {
            expect(observer.operations).toContain('create');
            expect(observer.operations).toContain('update');
            expect(observer.operations).toContain('delete');
        });
    });

    // =========================================================================
    // CREATE OPERATION TESTS
    // =========================================================================

    describe('create operation', () => {
        it('should add entry to cache on create', async () => {
            const record = new ModelRecord({}, {
                id: 'entity-123',
                pathname: 'doc.txt',
                parent: 'parent-456',
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntries).toHaveLength(1);
            expect(mockCache.addedEntries[0]).toEqual({
                id: 'entity-123',
                model: 'file',
                parent: 'parent-456',
                pathname: 'doc.txt',
            });
        });

        it('should handle root entry (null parent)', async () => {
            const record = new ModelRecord({}, {
                id: 'root-123',
                pathname: '',
                parent: null,
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('folder'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntries).toHaveLength(1);
            expect(mockCache.addedEntries[0]!.parent).toBeNull();
            expect(mockCache.addedEntries[0]!.pathname).toBe('');
        });

        it('should skip entry without pathname (non-root)', async () => {
            const record = new ModelRecord({}, {
                id: 'entity-123',
                pathname: undefined,
                parent: 'parent-456',
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntries).toHaveLength(0);
        });
    });

    // =========================================================================
    // UPDATE OPERATION TESTS
    // =========================================================================

    describe('update operation', () => {
        it('should update cache on pathname change (rename)', async () => {
            const record = new ModelRecord(
                { id: 'entity-123', pathname: 'old.txt', parent: 'parent-456' },
                { pathname: 'new.txt' },
            );

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'update',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.updatedEntries).toHaveLength(1);
            expect(mockCache.updatedEntries[0]).toEqual({
                id: 'entity-123',
                changes: { pathname: 'new.txt' },
            });
        });

        it('should update cache on parent change (move)', async () => {
            const record = new ModelRecord(
                { id: 'entity-123', pathname: 'doc.txt', parent: 'old-parent' },
                { parent: 'new-parent' },
            );

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'update',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.updatedEntries).toHaveLength(1);
            expect(mockCache.updatedEntries[0]).toEqual({
                id: 'entity-123',
                changes: { parent: 'new-parent' },
            });
        });

        it('should update cache on both rename and move', async () => {
            const record = new ModelRecord(
                { id: 'entity-123', pathname: 'old.txt', parent: 'old-parent' },
                { pathname: 'new.txt', parent: 'new-parent' },
            );

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'update',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.updatedEntries).toHaveLength(1);
            expect(mockCache.updatedEntries[0]!.changes.pathname).toBe('new.txt');
            expect(mockCache.updatedEntries[0]!.changes.parent).toBe('new-parent');
        });

        it('should skip update if pathname unchanged', async () => {
            const record = new ModelRecord(
                { id: 'entity-123', pathname: 'same.txt', parent: 'parent-456' },
                { pathname: 'same.txt' }, // Same value
            );

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'update',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.updatedEntries).toHaveLength(0);
        });

        it('should skip update if no path-related changes', async () => {
            const record = new ModelRecord(
                { id: 'entity-123', pathname: 'doc.txt', parent: 'parent-456', owner: 'alice' },
                { owner: 'bob' }, // Non-path change
            );

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'update',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.updatedEntries).toHaveLength(0);
        });

        it('should handle move to null parent (move to root)', async () => {
            const record = new ModelRecord(
                { id: 'entity-123', pathname: 'doc.txt', parent: 'old-parent' },
                { parent: null },
            );

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'update',
                model: createMockModel('folder'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.updatedEntries).toHaveLength(1);
            expect(mockCache.updatedEntries[0]!.changes.parent).toBeNull();
        });
    });

    // =========================================================================
    // DELETE OPERATION TESTS
    // =========================================================================

    describe('delete operation', () => {
        it('should remove entry from cache on delete', async () => {
            const record = new ModelRecord(
                { id: 'entity-123', pathname: 'doc.txt', parent: 'parent-456' },
                {},
            );

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'delete',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.removedEntryIds).toHaveLength(1);
            expect(mockCache.removedEntryIds[0]).toBe('entity-123');
        });
    });

    // =========================================================================
    // SKIP CONDITION TESTS
    // =========================================================================

    describe('skip conditions', () => {
        it('should skip meta-tables (models)', async () => {
            const record = new ModelRecord({}, {
                id: 'model-123',
                pathname: 'file',
                parent: null,
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('models'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntries).toHaveLength(0);
        });

        it('should skip meta-tables (fields)', async () => {
            const record = new ModelRecord({}, {
                id: 'field-123',
                pathname: 'name',
                parent: 'model-123',
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('fields'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntries).toHaveLength(0);
        });

        it('should skip meta-tables (tracked)', async () => {
            const record = new ModelRecord({}, {
                id: 'tracked-123',
                pathname: 'audit',
                parent: null,
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('tracked'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntries).toHaveLength(0);
        });

        it('should skip if no pathCache on system context', async () => {
            const record = new ModelRecord({}, {
                id: 'entity-123',
                pathname: 'doc.txt',
                parent: 'parent-456',
            });

            const context: ObserverContext = {
                system: createMockSystemContext(undefined), // No path cache
                operation: 'create',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            // Should not throw
            await observer.execute(context);
        });

        it('should skip if record has no id', async () => {
            const record = new ModelRecord({}, {
                pathname: 'doc.txt',
                parent: 'parent-456',
                // No id
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntries).toHaveLength(0);
        });
    });

    // =========================================================================
    // INTEGRATION TESTS
    // =========================================================================

    describe('integration', () => {
        it('should work with folder model', async () => {
            const record = new ModelRecord({}, {
                id: 'folder-123',
                pathname: 'documents',
                parent: null,
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('folder'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntries).toHaveLength(1);
            expect(mockCache.addedEntries[0]!.model).toBe('folder');
        });

        it('should work with custom entity models', async () => {
            const record = new ModelRecord({}, {
                id: 'invoice-123',
                pathname: 'INV-001',
                parent: 'customer-456',
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('invoice'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntries).toHaveLength(1);
            expect(mockCache.addedEntries[0]!.model).toBe('invoice');
        });
    });
});
