/**
 * EntityCacheSync Observer Tests
 *
 * Tests for the Ring 8 EntityCacheSync observer which keeps the EntityCache
 * in sync with database mutations.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { EntityCacheSync } from '@src/ems/ring/8/60-entity-cache.js';
import { ObserverRing } from '@src/ems/observers/types.js';
import { ModelRecord } from '@src/ems/model-record.js';
import type { ObserverContext, Model, SystemContext } from '@src/ems/observers/interfaces.js';

// =============================================================================
// MOCK ENTITY CACHE
// =============================================================================

interface AddEntityInput {
    id: string;
    model: string;
    parent: string | null;
    pathname: string;
}

interface UpdateEntityInput {
    pathname?: string;
    parent?: string | null;
}

class MockEntityCache {
    addedEntities: AddEntityInput[] = [];
    updatedEntities: Array<{ id: string; changes: UpdateEntityInput }> = [];
    removedEntityIds: string[] = [];

    addEntity(input: AddEntityInput): void {
        this.addedEntities.push(input);
    }

    updateEntity(id: string, changes: UpdateEntityInput): void {
        this.updatedEntities.push({ id, changes });
    }

    removeEntity(id: string): void {
        this.removedEntityIds.push(id);
    }

    reset(): void {
        this.addedEntities = [];
        this.updatedEntities = [];
        this.removedEntityIds = [];
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

function createMockSystemContext(entityCache?: MockEntityCache): SystemContext & { entityCache?: MockEntityCache } {
    return {
        db: {
            execute: async () => 0,
            query: async () => [],
            exec: async () => {},
            transaction: async () => [],
        },
        cache: {
            invalidate: () => {},
        },
        entityCache,
    };
}

// =============================================================================
// TESTS
// =============================================================================

describe('EntityCacheSync', () => {
    let observer: EntityCacheSync;
    let mockCache: MockEntityCache;

    beforeEach(() => {
        observer = new EntityCacheSync();
        mockCache = new MockEntityCache();
    });

    // =========================================================================
    // CONFIGURATION TESTS
    // =========================================================================

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('EntityCacheSync');
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
        it('should add entity to cache on create', async () => {
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]).toEqual({
                id: 'entity-123',
                model: 'file',
                parent: 'parent-456',
                pathname: 'doc.txt',
            });
        });

        it('should handle root entity (null parent)', async () => {
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.parent).toBeNull();
            expect(mockCache.addedEntities[0]!.pathname).toBe('');
        });

        it('should skip entity without pathname (non-root)', async () => {
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

            expect(mockCache.addedEntities).toHaveLength(0);
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

            expect(mockCache.updatedEntities).toHaveLength(1);
            expect(mockCache.updatedEntities[0]).toEqual({
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

            expect(mockCache.updatedEntities).toHaveLength(1);
            expect(mockCache.updatedEntities[0]).toEqual({
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

            expect(mockCache.updatedEntities).toHaveLength(1);
            expect(mockCache.updatedEntities[0]!.changes.pathname).toBe('new.txt');
            expect(mockCache.updatedEntities[0]!.changes.parent).toBe('new-parent');
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

            expect(mockCache.updatedEntities).toHaveLength(0);
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

            expect(mockCache.updatedEntities).toHaveLength(0);
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

            expect(mockCache.updatedEntities).toHaveLength(1);
            expect(mockCache.updatedEntities[0]!.changes.parent).toBeNull();
        });
    });

    // =========================================================================
    // DELETE OPERATION TESTS
    // =========================================================================

    describe('delete operation', () => {
        it('should remove entity from cache on delete', async () => {
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

            expect(mockCache.removedEntityIds).toHaveLength(1);
            expect(mockCache.removedEntityIds[0]).toBe('entity-123');
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

            expect(mockCache.addedEntities).toHaveLength(0);
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

            expect(mockCache.addedEntities).toHaveLength(0);
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

            expect(mockCache.addedEntities).toHaveLength(0);
        });

        it('should skip if no entityCache on system context', async () => {
            const record = new ModelRecord({}, {
                id: 'entity-123',
                pathname: 'doc.txt',
                parent: 'parent-456',
            });

            const context: ObserverContext = {
                system: createMockSystemContext(undefined), // No entity cache
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

            expect(mockCache.addedEntities).toHaveLength(0);
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.model).toBe('folder');
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.model).toBe('invoice');
        });
    });

    // =========================================================================
    // EDGE CASES - STUPID USER TESTS
    // =========================================================================

    describe('edge cases - id variations', () => {
        it('should handle empty string id', async () => {
            const record = new ModelRecord({}, {
                id: '',
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

            // Empty string id should be skipped (falsy)
            expect(mockCache.addedEntities).toHaveLength(0);
        });

        it('should handle numeric id (unusual but possible)', async () => {
            const record = new ModelRecord({}, {
                id: 12345 as unknown as string,
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.id).toBe(12345);
        });

        it('should handle uuid-style id', async () => {
            const record = new ModelRecord({}, {
                id: '550e8400-e29b-41d4-a716-446655440000',
                pathname: 'doc.txt',
                parent: null,
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.id).toBe('550e8400-e29b-41d4-a716-446655440000');
        });

        it('should handle very long id', async () => {
            const longId = 'a'.repeat(10000);
            const record = new ModelRecord({}, {
                id: longId,
                pathname: 'doc.txt',
                parent: null,
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.id).toBe(longId);
        });
    });

    describe('edge cases - pathname variations', () => {
        it('should handle empty string pathname (root)', async () => {
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.pathname).toBe('');
        });

        it('should handle pathname with special characters', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: 'my file (1).txt',
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.pathname).toBe('my file (1).txt');
        });

        it('should handle pathname with unicode', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: '文档.txt',
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.pathname).toBe('文档.txt');
        });

        it('should handle pathname with emoji', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: '📄notes.txt',
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.pathname).toBe('📄notes.txt');
        });

        it('should handle very long pathname', async () => {
            const longPath = 'a'.repeat(10000);
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: longPath,
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.pathname).toBe(longPath);
        });

        it('should handle pathname with path separator characters', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: 'file/with/slashes.txt',
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.pathname).toBe('file/with/slashes.txt');
        });

        it('should handle whitespace-only pathname', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: '   ',
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.pathname).toBe('   ');
        });
    });

    describe('edge cases - parent variations', () => {
        it('should handle undefined parent (normalized to null)', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: 'doc.txt',
                parent: undefined,
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

            expect(mockCache.addedEntities).toHaveLength(1);
            // Observer normalizes undefined parent to null
            expect(mockCache.addedEntities[0]!.parent).toBeNull();
        });

        it('should handle empty string parent', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: 'doc.txt',
                parent: '',
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

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.parent).toBe('');
        });
    });

    describe('edge cases - update edge cases', () => {
        it('should handle update with both pathname and parent changing to same value', async () => {
            const record = new ModelRecord(
                { id: 'file-123', pathname: 'old.txt', parent: 'old-parent' },
                { pathname: 'old.txt', parent: 'old-parent' }, // Same values
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

            expect(mockCache.updatedEntities).toHaveLength(0);
        });

        it('should handle update with undefined to null parent change', async () => {
            const record = new ModelRecord(
                { id: 'file-123', pathname: 'doc.txt', parent: undefined },
                { parent: null },
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

            // undefined -> null is a change
            expect(mockCache.updatedEntities).toHaveLength(1);
        });

        it('should handle update where only id exists in record', async () => {
            const record = new ModelRecord(
                { id: 'file-123' },
                { someOtherField: 'value' },
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

            expect(mockCache.updatedEntities).toHaveLength(0);
        });
    });

    describe('edge cases - delete edge cases', () => {
        it('should handle delete with minimal record (only id in original)', async () => {
            const record = new ModelRecord({ id: 'file-123' }, {});

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

            expect(mockCache.removedEntityIds).toHaveLength(1);
            expect(mockCache.removedEntityIds[0]).toBe('file-123');
        });

        it('should handle delete with id in changes (unusual)', async () => {
            const record = new ModelRecord({}, { id: 'file-123' });

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

            expect(mockCache.removedEntityIds).toHaveLength(1);
        });
    });

    describe('edge cases - model name edge cases', () => {
        it('should handle model with uppercase name', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: 'doc.txt',
                parent: null,
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('FILE'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntities).toHaveLength(1);
            expect(mockCache.addedEntities[0]!.model).toBe('FILE');
        });

        it('should handle model with mixed case (Models)', async () => {
            const record = new ModelRecord({}, {
                id: 'model-123',
                pathname: 'test',
                parent: null,
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('Models'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            // 'Models' !== 'models', so should NOT be skipped
            expect(mockCache.addedEntities).toHaveLength(1);
        });

        it('should skip exact match meta-tables only', async () => {
            // 'models' (exact) should skip
            // 'models2' should NOT skip
            const record = new ModelRecord({}, {
                id: 'test-123',
                pathname: 'test',
                parent: null,
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('models2'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntities).toHaveLength(1);
        });
    });

    describe('edge cases - context variations', () => {
        it('should handle null errors array', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: 'doc.txt',
                parent: null,
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: null as unknown as never[],
                warnings: [],
            };

            // Should not throw
            await observer.execute(context);

            expect(mockCache.addedEntities).toHaveLength(1);
        });

        it('should handle recordIndex > 0', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: 'doc.txt',
                parent: null,
            });

            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'create',
                model: createMockModel('file'),
                record,
                recordIndex: 999,
                errors: [],
                warnings: [],
            };

            await observer.execute(context);

            expect(mockCache.addedEntities).toHaveLength(1);
        });
    });

    describe('edge cases - operation casing', () => {
        it('should handle operation as-is (case sensitive)', async () => {
            const record = new ModelRecord({}, {
                id: 'file-123',
                pathname: 'doc.txt',
                parent: null,
            });

            // Observer checks for exact 'create', 'update', 'delete'
            // If someone passes 'CREATE', behavior depends on implementation
            const context: ObserverContext = {
                system: createMockSystemContext(mockCache),
                operation: 'CREATE' as 'create',
                model: createMockModel('file'),
                record,
                recordIndex: 0,
                errors: [],
                warnings: [],
            };

            // This tests what happens with non-standard operation
            await observer.execute(context);

            // Observer may or may not process based on implementation
            // The test documents the actual behavior
        });
    });
});
