/**
 * EntityCache Tests
 *
 * Tests for the EntityCache class which provides O(1) path resolution
 * and model dispatch via in-memory entity indexing.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { EntityCache, ROOT_ID, type CachedEntity } from '@src/model/entity-cache.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock database connection for testing loadFromDatabase.
 */
function createMockDb(tables: Record<string, Array<{ id: string; parent: string | null; name: string }>>) {
    return {
        async query<T>(sql: string, _params?: unknown[]): Promise<T[]> {
            // Check if this is a models query
            if (sql.includes('FROM models')) {
                return Object.keys(tables).map((name) => ({ model_name: name })) as T[];
            }

            // Check if this is a table query
            for (const [tableName, rows] of Object.entries(tables)) {
                if (sql.includes(`FROM ${tableName}`)) {
                    return rows as T[];
                }
            }

            return [];
        },
        async queryOne<T>(_sql: string, _params?: unknown[]): Promise<T | null> {
            return null;
        },
        async execute(_sql: string, _params?: unknown[]): Promise<number> {
            return 0;
        },
        async exec(_sql: string): Promise<void> {},
        async close(): Promise<void> {},
    };
}

/**
 * Create a test entity.
 */
function createEntity(
    id: string,
    model: string,
    name: string,
    parent: string | null = null
): { id: string; model: string; parent: string | null; name: string } {
    return { id, model, parent, name };
}

// =============================================================================
// CONSTRUCTOR TESTS
// =============================================================================

describe('EntityCache', () => {
    describe('constructor', () => {
        it('should create an empty cache', () => {
            const cache = new EntityCache();
            expect(cache.size).toBe(0);
        });

        it('should enable childrenOf by default', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, name: 'root' });
            cache.addEntity({ id: 'child', model: 'file', parent: 'parent', name: 'file.txt' });

            // childrenOf should be maintained
            const children = cache.listChildren('parent');
            expect(children).toContain('child');
        });

        it('should allow disabling childrenOf index', () => {
            const cache = new EntityCache({ maintainChildrenOf: false });
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, name: 'root' });
            cache.addEntity({ id: 'child', model: 'file', parent: 'parent', name: 'file.txt' });

            // listChildren still works (falls back to scan)
            const children = cache.listChildren('parent');
            expect(children).toContain('child');
        });
    });

    // =========================================================================
    // ENTITY OPERATIONS
    // =========================================================================

    describe('addEntity', () => {
        let cache: EntityCache;

        beforeEach(() => {
            cache = new EntityCache();
        });

        it('should add entity to byId index', () => {
            cache.addEntity({ id: 'test-1', model: 'file', parent: 'root', name: 'test.txt' });

            const entity = cache.getEntity('test-1');
            expect(entity).toBeDefined();
            expect(entity!.id).toBe('test-1');
            expect(entity!.model).toBe('file');
            expect(entity!.parent).toBe('root');
            expect(entity!.name).toBe('test.txt');
        });

        it('should add entity to childIndex', () => {
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, name: 'home' });
            cache.addEntity({ id: 'child', model: 'file', parent: 'parent', name: 'file.txt' });

            const childId = cache.getChild('parent', 'file.txt');
            expect(childId).toBe('child');
        });

        it('should not add to childIndex for root entities', () => {
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });

            // Root has no parent, so no childIndex entry
            const entity = cache.getEntity(ROOT_ID);
            expect(entity).toBeDefined();
            expect(entity!.parent).toBeNull();
        });

        it('should coerce undefined parent to null', () => {
            cache.addEntity({ id: 'test', model: 'file', name: 'orphan.txt' });

            const entity = cache.getEntity('test');
            expect(entity!.parent).toBeNull();
        });

        it('should add to childrenOf index', () => {
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, name: 'home' });
            cache.addEntity({ id: 'child1', model: 'file', parent: 'parent', name: 'a.txt' });
            cache.addEntity({ id: 'child2', model: 'file', parent: 'parent', name: 'b.txt' });

            const children = cache.listChildren('parent');
            expect(children).toHaveLength(2);
            expect(children).toContain('child1');
            expect(children).toContain('child2');
        });
    });

    describe('updateEntity', () => {
        let cache: EntityCache;

        beforeEach(() => {
            cache = new EntityCache();
            cache.addEntity({ id: 'parent1', model: 'folder', parent: null, name: 'home' });
            cache.addEntity({ id: 'parent2', model: 'folder', parent: null, name: 'tmp' });
            cache.addEntity({ id: 'file1', model: 'file', parent: 'parent1', name: 'old.txt' });
        });

        it('should handle rename', () => {
            cache.updateEntity('file1', { name: 'new.txt' });

            // Old name should not resolve
            expect(cache.getChild('parent1', 'old.txt')).toBeUndefined();

            // New name should resolve
            expect(cache.getChild('parent1', 'new.txt')).toBe('file1');

            // Entity should have new name
            const entity = cache.getEntity('file1');
            expect(entity!.name).toBe('new.txt');
        });

        it('should handle move (parent change)', () => {
            cache.updateEntity('file1', { parent: 'parent2' });

            // Should not be child of old parent
            expect(cache.getChild('parent1', 'old.txt')).toBeUndefined();

            // Should be child of new parent
            expect(cache.getChild('parent2', 'old.txt')).toBe('file1');

            // Entity should have new parent
            const entity = cache.getEntity('file1');
            expect(entity!.parent).toBe('parent2');
        });

        it('should handle move to root (parent = null)', () => {
            cache.updateEntity('file1', { parent: null });

            // Should not be child of old parent
            expect(cache.getChild('parent1', 'old.txt')).toBeUndefined();

            // Entity should have no parent
            const entity = cache.getEntity('file1');
            expect(entity!.parent).toBeNull();
        });

        it('should be idempotent for unchanged values', () => {
            cache.updateEntity('file1', { name: 'old.txt' }); // Same name

            // Should still resolve
            expect(cache.getChild('parent1', 'old.txt')).toBe('file1');
        });

        it('should handle non-existent entity gracefully', () => {
            // Should not throw
            cache.updateEntity('non-existent', { name: 'foo.txt' });
        });
    });

    describe('removeEntity', () => {
        let cache: EntityCache;

        beforeEach(() => {
            cache = new EntityCache();
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, name: 'home' });
            cache.addEntity({ id: 'child', model: 'file', parent: 'parent', name: 'file.txt' });
        });

        it('should remove from byId', () => {
            cache.removeEntity('child');
            expect(cache.getEntity('child')).toBeUndefined();
        });

        it('should remove from childIndex', () => {
            cache.removeEntity('child');
            expect(cache.getChild('parent', 'file.txt')).toBeUndefined();
        });

        it('should remove from childrenOf', () => {
            cache.removeEntity('child');
            const children = cache.listChildren('parent');
            expect(children).not.toContain('child');
        });

        it('should handle non-existent entity gracefully', () => {
            // Should not throw
            cache.removeEntity('non-existent');
        });

        it('should remove childrenOf entry for parent being removed', () => {
            cache.removeEntity('parent');

            // The parent itself should be gone
            expect(cache.hasEntity('parent')).toBe(false);
        });
    });

    // =========================================================================
    // PATH RESOLUTION
    // =========================================================================

    describe('resolvePath', () => {
        let cache: EntityCache;

        beforeEach(() => {
            cache = new EntityCache();
            // Build a tree: / -> home -> user -> docs -> file.txt
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });
            cache.addEntity({ id: 'home-id', model: 'folder', parent: ROOT_ID, name: 'home' });
            cache.addEntity({ id: 'user-id', model: 'folder', parent: 'home-id', name: 'user' });
            cache.addEntity({ id: 'docs-id', model: 'folder', parent: 'user-id', name: 'docs' });
            cache.addEntity({ id: 'file-id', model: 'file', parent: 'docs-id', name: 'file.txt' });
        });

        it('should resolve root path "/"', () => {
            expect(cache.resolvePath('/')).toBe(ROOT_ID);
        });

        it('should resolve empty path as root', () => {
            expect(cache.resolvePath('')).toBe(ROOT_ID);
        });

        it('should resolve single component path', () => {
            expect(cache.resolvePath('/home')).toBe('home-id');
        });

        it('should resolve multi-component path', () => {
            expect(cache.resolvePath('/home/user/docs/file.txt')).toBe('file-id');
        });

        it('should return null for non-existent path', () => {
            expect(cache.resolvePath('/home/user/missing')).toBeNull();
        });

        it('should return null for non-existent intermediate component', () => {
            expect(cache.resolvePath('/home/missing/docs')).toBeNull();
        });

        it('should handle trailing slashes', () => {
            // Trailing slashes produce empty components which are filtered
            expect(cache.resolvePath('/home/')).toBe('home-id');
        });
    });

    describe('computePath', () => {
        let cache: EntityCache;

        beforeEach(() => {
            cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });
            cache.addEntity({ id: 'home-id', model: 'folder', parent: ROOT_ID, name: 'home' });
            cache.addEntity({ id: 'user-id', model: 'folder', parent: 'home-id', name: 'user' });
            cache.addEntity({ id: 'file-id', model: 'file', parent: 'user-id', name: 'file.txt' });
        });

        it('should compute root path', () => {
            expect(cache.computePath(ROOT_ID)).toBe('/');
        });

        it('should compute single level path', () => {
            expect(cache.computePath('home-id')).toBe('/home');
        });

        it('should compute multi-level path', () => {
            expect(cache.computePath('file-id')).toBe('/home/user/file.txt');
        });

        it('should return null for non-existent entity', () => {
            expect(cache.computePath('non-existent')).toBeNull();
        });
    });

    describe('resolveParent', () => {
        let cache: EntityCache;

        beforeEach(() => {
            cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });
            cache.addEntity({ id: 'home-id', model: 'folder', parent: ROOT_ID, name: 'home' });
        });

        it('should resolve parent and name', () => {
            const result = cache.resolveParent('/home/newfile.txt');
            expect(result).toEqual({ parentId: 'home-id', name: 'newfile.txt' });
        });

        it('should resolve root as parent for top-level files', () => {
            const result = cache.resolveParent('/topfile.txt');
            expect(result).toEqual({ parentId: ROOT_ID, name: 'topfile.txt' });
        });

        it('should return null for root path', () => {
            expect(cache.resolveParent('/')).toBeNull();
        });

        it('should return null if parent does not exist', () => {
            expect(cache.resolveParent('/missing/file.txt')).toBeNull();
        });
    });

    // =========================================================================
    // ENTITY LOOKUP
    // =========================================================================

    describe('getEntity', () => {
        it('should return entity if exists', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'test', model: 'file', parent: null, name: 'test.txt' });

            const entity = cache.getEntity('test');
            expect(entity).toBeDefined();
            expect(entity!.id).toBe('test');
        });

        it('should return undefined if not exists', () => {
            const cache = new EntityCache();
            expect(cache.getEntity('missing')).toBeUndefined();
        });
    });

    describe('getModel', () => {
        it('should return model name', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'test', model: 'video', parent: null, name: 'clip.mp4' });

            expect(cache.getModel('test')).toBe('video');
        });

        it('should return undefined for missing entity', () => {
            const cache = new EntityCache();
            expect(cache.getModel('missing')).toBeUndefined();
        });
    });

    describe('hasEntity', () => {
        it('should return true if entity exists', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'test', model: 'file', parent: null, name: 'test.txt' });

            expect(cache.hasEntity('test')).toBe(true);
        });

        it('should return false if entity does not exist', () => {
            const cache = new EntityCache();
            expect(cache.hasEntity('missing')).toBe(false);
        });
    });

    describe('listChildren', () => {
        let cache: EntityCache;

        beforeEach(() => {
            cache = new EntityCache();
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, name: 'home' });
            cache.addEntity({ id: 'child1', model: 'file', parent: 'parent', name: 'a.txt' });
            cache.addEntity({ id: 'child2', model: 'file', parent: 'parent', name: 'b.txt' });
            cache.addEntity({ id: 'child3', model: 'folder', parent: 'parent', name: 'subdir' });
        });

        it('should return all children', () => {
            const children = cache.listChildren('parent');
            expect(children).toHaveLength(3);
            expect(children).toContain('child1');
            expect(children).toContain('child2');
            expect(children).toContain('child3');
        });

        it('should return empty array for leaf entities', () => {
            const children = cache.listChildren('child1');
            expect(children).toHaveLength(0);
        });

        it('should return empty array for non-existent parent', () => {
            const children = cache.listChildren('non-existent');
            expect(children).toHaveLength(0);
        });
    });

    // =========================================================================
    // BULK LOADING
    // =========================================================================

    describe('loadFromDatabase', () => {
        it('should load entities from all model tables', async () => {
            const cache = new EntityCache();
            const mockDb = createMockDb({
                file: [
                    { id: 'file1', parent: ROOT_ID, name: 'doc.txt' },
                    { id: 'file2', parent: ROOT_ID, name: 'image.png' },
                ],
                folder: [
                    { id: 'folder1', parent: ROOT_ID, name: 'home' },
                ],
            });

            await cache.loadFromDatabase(mockDb as any);

            expect(cache.size).toBe(3);
            expect(cache.getModel('file1')).toBe('file');
            expect(cache.getModel('folder1')).toBe('folder');
        });

        it('should clear existing cache before loading', async () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'existing', model: 'file', parent: null, name: 'old.txt' });

            const mockDb = createMockDb({
                file: [{ id: 'new', parent: null, name: 'new.txt' }],
            });

            await cache.loadFromDatabase(mockDb as any);

            expect(cache.hasEntity('existing')).toBe(false);
            expect(cache.hasEntity('new')).toBe(true);
        });

        it('should handle empty tables', async () => {
            const cache = new EntityCache();
            const mockDb = createMockDb({
                file: [],
                folder: [],
            });

            await cache.loadFromDatabase(mockDb as any);

            expect(cache.size).toBe(0);
        });
    });

    // =========================================================================
    // STATISTICS
    // =========================================================================

    describe('getStats', () => {
        it('should return accurate statistics', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, name: 'home' });
            cache.addEntity({ id: 'child1', model: 'file', parent: 'parent', name: 'a.txt' });
            cache.addEntity({ id: 'child2', model: 'file', parent: 'parent', name: 'b.txt' });

            const stats = cache.getStats();

            expect(stats.entityCount).toBe(3);
            expect(stats.childIndexSize).toBe(2); // Only children have childIndex entries
            expect(stats.childrenOfSize).toBe(1); // Only 'parent' has children
            expect(stats.estimatedMemoryBytes).toBeGreaterThan(0);
        });
    });

    describe('clear', () => {
        it('should remove all entities', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'a', model: 'file', parent: null, name: 'a.txt' });
            cache.addEntity({ id: 'b', model: 'file', parent: null, name: 'b.txt' });

            cache.clear();

            expect(cache.size).toBe(0);
            expect(cache.getEntity('a')).toBeUndefined();
            expect(cache.getEntity('b')).toBeUndefined();
        });
    });

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    describe('getAllIds', () => {
        it('should return all entity IDs', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'a', model: 'file', parent: null, name: 'a.txt' });
            cache.addEntity({ id: 'b', model: 'file', parent: null, name: 'b.txt' });

            const ids = cache.getAllIds();
            expect(ids).toHaveLength(2);
            expect(ids).toContain('a');
            expect(ids).toContain('b');
        });
    });

    describe('getAllEntities', () => {
        it('should return all entities', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'a', model: 'file', parent: null, name: 'a.txt' });
            cache.addEntity({ id: 'b', model: 'folder', parent: null, name: 'dir' });

            const entities = cache.getAllEntities();
            expect(entities).toHaveLength(2);

            const models = entities.map((e) => e.model);
            expect(models).toContain('file');
            expect(models).toContain('folder');
        });
    });

    // =========================================================================
    // EDGE CASES
    // =========================================================================

    describe('edge cases', () => {
        it('should handle deeply nested paths', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });

            // Create 100-level deep path
            let parentId = ROOT_ID;
            for (let i = 0; i < 100; i++) {
                const id = `level-${i}`;
                cache.addEntity({ id, model: 'folder', parent: parentId, name: `dir${i}` });
                parentId = id;
            }
            cache.addEntity({ id: 'leaf', model: 'file', parent: parentId, name: 'deep.txt' });

            // Should be able to resolve
            const path = '/dir0/' + Array.from({ length: 99 }, (_, i) => `dir${i + 1}`).join('/') + '/deep.txt';
            expect(cache.resolvePath(path)).toBe('leaf');

            // Should be able to compute path
            const computed = cache.computePath('leaf');
            expect(computed).toBe(path);
        });

        it('should handle special characters in names', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });
            cache.addEntity({
                id: 'special',
                model: 'file',
                parent: ROOT_ID,
                name: 'file with spaces & special!@#.txt',
            });

            expect(cache.resolvePath('/file with spaces & special!@#.txt')).toBe('special');
        });

        it('should handle unicode names', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });
            cache.addEntity({ id: 'unicode', model: 'file', parent: ROOT_ID, name: '日本語ファイル.txt' });

            expect(cache.resolvePath('/日本語ファイル.txt')).toBe('unicode');
        });

        it('should handle empty name for root', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });

            expect(cache.getEntity(ROOT_ID)!.name).toBe('');
            expect(cache.computePath(ROOT_ID)).toBe('/');
        });
    });

    // =========================================================================
    // CONSISTENCY TESTS
    // =========================================================================

    describe('consistency', () => {
        it('should maintain byId and childIndex consistency after operations', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });
            cache.addEntity({ id: 'file', model: 'file', parent: ROOT_ID, name: 'test.txt' });

            // Verify consistency
            expect(cache.getEntity('file')).toBeDefined();
            expect(cache.getChild(ROOT_ID, 'test.txt')).toBe('file');
            expect(cache.resolvePath('/test.txt')).toBe('file');
            expect(cache.computePath('file')).toBe('/test.txt');

            // Rename
            cache.updateEntity('file', { name: 'renamed.txt' });

            // Verify consistency after rename
            expect(cache.getEntity('file')!.name).toBe('renamed.txt');
            expect(cache.getChild(ROOT_ID, 'test.txt')).toBeUndefined();
            expect(cache.getChild(ROOT_ID, 'renamed.txt')).toBe('file');
            expect(cache.resolvePath('/test.txt')).toBeNull();
            expect(cache.resolvePath('/renamed.txt')).toBe('file');
            expect(cache.computePath('file')).toBe('/renamed.txt');

            // Remove
            cache.removeEntity('file');

            // Verify consistency after remove
            expect(cache.getEntity('file')).toBeUndefined();
            expect(cache.getChild(ROOT_ID, 'renamed.txt')).toBeUndefined();
            expect(cache.resolvePath('/renamed.txt')).toBeNull();
            expect(cache.computePath('file')).toBeNull();
        });
    });
});
