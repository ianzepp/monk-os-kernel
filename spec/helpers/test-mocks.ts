import { mock } from 'bun:test';
import type { DatabaseOps, DbRecord, SelectOptions, DeleteFilter } from '@src/model/database-ops.js';
import type { EntityCache, CachedEntity } from '@src/model/entity-cache.js';
import { VFS } from '@src/vfs/vfs.js';
import type { HAL } from '@src/hal/index.js';

// =============================================================================
// VFS TEST HELPERS
// =============================================================================

/**
 * In-memory record storage for mock DatabaseOps.
 */
class MockRecordStore {
    private records: Map<string, Map<string, DbRecord>> = new Map();
    private nextId = 1;

    getTable(model: string): Map<string, DbRecord> {
        if (!this.records.has(model)) {
            this.records.set(model, new Map());
        }
        return this.records.get(model)!;
    }

    generateId(): string {
        return `mock-${this.nextId++}`;
    }
}

/**
 * Create a mock DatabaseOps that stores records in memory.
 *
 * This provides a minimal implementation for testing FileModel/FolderModel
 * without requiring a real database connection.
 */
export function createMockDatabaseOps(): DatabaseOps {
    const store = new MockRecordStore();
    const now = () => new Date().toISOString();

    return {
        async *selectAny<T extends DbRecord>(
            model: string,
            options?: SelectOptions
        ): AsyncGenerator<T> {
            const table = store.getTable(model);
            for (const record of table.values()) {
                if (options?.where) {
                    // Simple WHERE matching
                    const match = Object.entries(options.where).every(
                        ([key, value]) => (record as Record<string, unknown>)[key] === value
                    );
                    if (!match) continue;
                }
                yield record as T;
                if (options?.limit && options.limit === 1) break;
            }
        },

        async *createAll<T extends DbRecord>(
            model: string,
            records: Array<Partial<T> & { pathname?: string; parent?: string | null }>
        ): AsyncGenerator<T> {
            const table = store.getTable(model);
            for (const input of records) {
                const id = store.generateId();
                const record: DbRecord = {
                    id,
                    created_at: now(),
                    updated_at: now(),
                    deleted_at: null,
                    ...input,
                };
                table.set(id, record);
                yield record as T;
            }
        },

        async *updateAll<T extends DbRecord>(
            model: string,
            updates: Array<{ id: string; changes: Partial<T> }>
        ): AsyncGenerator<T> {
            const table = store.getTable(model);
            for (const { id, changes } of updates) {
                const existing = table.get(id);
                if (existing) {
                    const updated = {
                        ...existing,
                        ...changes,
                        updated_at: now(),
                    };
                    table.set(id, updated);
                    yield updated as T;
                }
            }
        },

        async *deleteAll<T extends DbRecord>(
            model: string,
            filters: DeleteFilter[]
        ): AsyncGenerator<T> {
            const table = store.getTable(model);
            for (const filter of filters) {
                const id = filter.id;
                const existing = table.get(id);
                if (existing) {
                    // Soft delete
                    const deleted = {
                        ...existing,
                        deleted_at: now(),
                        updated_at: now(),
                    };
                    table.set(id, deleted);
                    yield deleted as T;
                }
            }
        },
    } as DatabaseOps;
}

/**
 * Create a mock EntityCache that stores entities in memory.
 *
 * This provides a minimal implementation for testing FileModel/FolderModel
 * without requiring database-backed entity resolution.
 */
export function createMockEntityCache(): EntityCache {
    const entities: Map<string, CachedEntity> = new Map();
    const children: Map<string, string[]> = new Map();

    return {
        get size(): number {
            return entities.size;
        },

        getEntity(id: string): CachedEntity | undefined {
            return entities.get(id);
        },

        listChildren(parentId: string): string[] {
            return children.get(parentId) || [];
        },

        getChild(parentId: string, pathname: string): string | undefined {
            const childIds = children.get(parentId) || [];
            for (const childId of childIds) {
                const entity = entities.get(childId);
                if (entity && entity.pathname === pathname) {
                    return childId;
                }
            }
            return undefined;
        },

        // Method to add entities for testing
        addEntity(entity: CachedEntity): void {
            entities.set(entity.id, entity);
            if (entity.parent) {
                const parentChildren = children.get(entity.parent) || [];
                if (!parentChildren.includes(entity.id)) {
                    parentChildren.push(entity.id);
                    children.set(entity.parent, parentChildren);
                }
            }
        },

        // Method to update entities (rename/move)
        updateEntity(id: string, changes: { pathname?: string; parent?: string | null }): void {
            const entity = entities.get(id);
            if (!entity) return;

            // Handle parent change (move)
            if (changes.parent !== undefined && changes.parent !== entity.parent) {
                // Remove from old parent's children list
                if (entity.parent) {
                    const oldChildren = children.get(entity.parent) || [];
                    const idx = oldChildren.indexOf(id);
                    if (idx >= 0) oldChildren.splice(idx, 1);
                }
                // Add to new parent's children list
                if (changes.parent) {
                    const newChildren = children.get(changes.parent) || [];
                    if (!newChildren.includes(id)) {
                        newChildren.push(id);
                        children.set(changes.parent, newChildren);
                    }
                }
                entity.parent = changes.parent;
            }

            // Handle pathname change (rename)
            if (changes.pathname !== undefined) {
                entity.pathname = changes.pathname;
            }

            entities.set(id, entity);
        },

        // Required by interface but not needed for basic tests
        async loadFromDatabase(): Promise<void> {},
        async resolvePath(): Promise<string | undefined> { return undefined; },
        async resolveParent(): Promise<string | undefined> { return undefined; },
    } as EntityCache;
}

/**
 * Create a VFS instance configured for testing.
 *
 * Sets up VFS with mock DatabaseOps and EntityCache, and registers
 * FileModel and FolderModel. This allows tests to use VFS without
 * requiring a full database layer.
 *
 * @param hal - HAL instance (must be initialized)
 * @returns Configured VFS ready for testing
 */
export async function createTestVfs(hal: HAL): Promise<VFS> {
    const vfs = new VFS(hal);
    await vfs.init();

    const mockDbOps = createMockDatabaseOps();
    const mockEntityCache = createMockEntityCache();

    vfs.registerFileModel(mockDbOps, mockEntityCache);
    vfs.registerFolderModel(mockDbOps, mockEntityCache);

    return vfs;
}
