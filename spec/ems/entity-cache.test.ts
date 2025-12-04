/**
 * EntityCache Tests
 *
 * Tests for the EntityCache class which provides O(1) path resolution
 * and model dispatch via in-memory entity indexing.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { EntityCache, ROOT_ID } from '@src/ems/entity-cache.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock database connection for testing loadFromDatabase.
 * Now queries the entities table directly instead of individual model tables.
 */
function createMockDb(entities: Array<{ id: string; model: string; parent: string | null; pathname: string }>) {
    return {
        async query<T>(sql: string, _params?: unknown[]): Promise<T[]> {
            // loadFromDatabase queries: SELECT id, model, parent, pathname FROM entities
            if (sql.includes('FROM entities')) {
                return entities as T[];
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
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, pathname: 'root' });
            cache.addEntity({ id: 'child', model: 'file', parent: 'parent', pathname: 'file.txt' });

            // childrenOf should be maintained
            const children = cache.listChildren('parent');
            expect(children).toContain('child');
        });

        it('should allow disabling childrenOf index', () => {
            const cache = new EntityCache({ maintainChildrenOf: false });
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, pathname: 'root' });
            cache.addEntity({ id: 'child', model: 'file', parent: 'parent', pathname: 'file.txt' });

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
            cache.addEntity({ id: 'test-1', model: 'file', parent: 'root', pathname: 'test.txt' });

            const entity = cache.getEntity('test-1');
            expect(entity).toBeDefined();
            expect(entity!.id).toBe('test-1');
            expect(entity!.model).toBe('file');
            expect(entity!.parent).toBe('root');
            expect(entity!.pathname).toBe('test.txt');
        });

        it('should add entity to childIndex', () => {
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntity({ id: 'child', model: 'file', parent: 'parent', pathname: 'file.txt' });

            const childId = cache.getChild('parent', 'file.txt');
            expect(childId).toBe('child');
        });

        it('should not add to childIndex for root entities', () => {
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

            // Root has no parent, so no childIndex entry
            const entity = cache.getEntity(ROOT_ID);
            expect(entity).toBeDefined();
            expect(entity!.parent).toBeNull();
        });

        it('should coerce undefined parent to null', () => {
            cache.addEntity({ id: 'test', model: 'file', pathname: 'orphan.txt' });

            const entity = cache.getEntity('test');
            expect(entity!.parent).toBeNull();
        });

        it('should add to childrenOf index', () => {
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntity({ id: 'child1', model: 'file', parent: 'parent', pathname: 'a.txt' });
            cache.addEntity({ id: 'child2', model: 'file', parent: 'parent', pathname: 'b.txt' });

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
            cache.addEntity({ id: 'parent1', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntity({ id: 'parent2', model: 'folder', parent: null, pathname: 'tmp' });
            cache.addEntity({ id: 'file1', model: 'file', parent: 'parent1', pathname: 'old.txt' });
        });

        it('should handle rename', () => {
            cache.updateEntity('file1', { pathname: 'new.txt' });

            // Old name should not resolve
            expect(cache.getChild('parent1', 'old.txt')).toBeUndefined();

            // New name should resolve
            expect(cache.getChild('parent1', 'new.txt')).toBe('file1');

            // Entity should have new name
            const entity = cache.getEntity('file1');
            expect(entity!.pathname).toBe('new.txt');
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
            cache.updateEntity('file1', { pathname: 'old.txt' }); // Same name

            // Should still resolve
            expect(cache.getChild('parent1', 'old.txt')).toBe('file1');
        });

        it('should handle non-existent entity gracefully', () => {
            // Should not throw
            cache.updateEntity('non-existent', { pathname: 'foo.txt' });
        });
    });

    describe('removeEntity', () => {
        let cache: EntityCache;

        beforeEach(() => {
            cache = new EntityCache();
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntity({ id: 'child', model: 'file', parent: 'parent', pathname: 'file.txt' });
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
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntity({ id: 'home-id', model: 'folder', parent: ROOT_ID, pathname: 'home' });
            cache.addEntity({ id: 'user-id', model: 'folder', parent: 'home-id', pathname: 'user' });
            cache.addEntity({ id: 'docs-id', model: 'folder', parent: 'user-id', pathname: 'docs' });
            cache.addEntity({ id: 'file-id', model: 'file', parent: 'docs-id', pathname: 'file.txt' });
        });

        it('should resolve root path "/"', async () => {
            expect(await cache.resolvePath('/')).toBe(ROOT_ID);
        });

        it('should resolve empty path as root', async () => {
            expect(await cache.resolvePath('')).toBe(ROOT_ID);
        });

        it('should resolve single component path', async () => {
            expect(await cache.resolvePath('/home')).toBe('home-id');
        });

        it('should resolve multi-component path', async () => {
            expect(await cache.resolvePath('/home/user/docs/file.txt')).toBe('file-id');
        });

        it('should return null for non-existent path', async () => {
            expect(await cache.resolvePath('/home/user/missing')).toBeNull();
        });

        it('should return null for non-existent intermediate component', async () => {
            expect(await cache.resolvePath('/home/missing/docs')).toBeNull();
        });

        it('should handle trailing slashes', async () => {
            // Trailing slashes produce empty components which are filtered
            expect(await cache.resolvePath('/home/')).toBe('home-id');
        });
    });

    describe('computePath', () => {
        let cache: EntityCache;

        beforeEach(() => {
            cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntity({ id: 'home-id', model: 'folder', parent: ROOT_ID, pathname: 'home' });
            cache.addEntity({ id: 'user-id', model: 'folder', parent: 'home-id', pathname: 'user' });
            cache.addEntity({ id: 'file-id', model: 'file', parent: 'user-id', pathname: 'file.txt' });
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
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntity({ id: 'home-id', model: 'folder', parent: ROOT_ID, pathname: 'home' });
        });

        it('should resolve parent and pathname', async () => {
            const result = await cache.resolveParent('/home/newfile.txt');
            expect(result).toEqual({ parentId: 'home-id', pathname: 'newfile.txt' });
        });

        it('should resolve root as parent for top-level files', async () => {
            const result = await cache.resolveParent('/topfile.txt');
            expect(result).toEqual({ parentId: ROOT_ID, pathname: 'topfile.txt' });
        });

        it('should return null for root path', async () => {
            expect(await cache.resolveParent('/')).toBeNull();
        });

        it('should return null if parent does not exist', async () => {
            expect(await cache.resolveParent('/missing/file.txt')).toBeNull();
        });
    });

    // =========================================================================
    // ENTITY LOOKUP
    // =========================================================================

    describe('getEntity', () => {
        it('should return entity if exists', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'test', model: 'file', parent: null, pathname: 'test.txt' });

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
            cache.addEntity({ id: 'test', model: 'video', parent: null, pathname: 'clip.mp4' });

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
            cache.addEntity({ id: 'test', model: 'file', parent: null, pathname: 'test.txt' });

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
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntity({ id: 'child1', model: 'file', parent: 'parent', pathname: 'a.txt' });
            cache.addEntity({ id: 'child2', model: 'file', parent: 'parent', pathname: 'b.txt' });
            cache.addEntity({ id: 'child3', model: 'folder', parent: 'parent', pathname: 'subdir' });
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
        it('should load entities from entities table', async () => {
            const cache = new EntityCache();
            const mockDb = createMockDb([
                { id: 'file1', model: 'file', parent: ROOT_ID, pathname: 'doc.txt' },
                { id: 'file2', model: 'file', parent: ROOT_ID, pathname: 'image.png' },
                { id: 'folder1', model: 'folder', parent: ROOT_ID, pathname: 'home' },
            ]);

            await cache.loadFromDatabase(mockDb as any);

            expect(cache.size).toBe(3);
            expect(cache.getModel('file1')).toBe('file');
            expect(cache.getModel('folder1')).toBe('folder');
        });

        it('should clear existing cache before loading', async () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'existing', model: 'file', parent: null, pathname: 'old.txt' });

            const mockDb = createMockDb([
                { id: 'new', model: 'file', parent: null, pathname: 'new.txt' },
            ]);

            await cache.loadFromDatabase(mockDb as any);

            expect(cache.hasEntity('existing')).toBe(false);
            expect(cache.hasEntity('new')).toBe(true);
        });

        it('should handle empty entities table', async () => {
            const cache = new EntityCache();
            const mockDb = createMockDb([]);

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
            cache.addEntity({ id: 'parent', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntity({ id: 'child1', model: 'file', parent: 'parent', pathname: 'a.txt' });
            cache.addEntity({ id: 'child2', model: 'file', parent: 'parent', pathname: 'b.txt' });

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
            cache.addEntity({ id: 'a', model: 'file', parent: null, pathname: 'a.txt' });
            cache.addEntity({ id: 'b', model: 'file', parent: null, pathname: 'b.txt' });

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
            cache.addEntity({ id: 'a', model: 'file', parent: null, pathname: 'a.txt' });
            cache.addEntity({ id: 'b', model: 'file', parent: null, pathname: 'b.txt' });

            const ids = cache.getAllIds();
            expect(ids).toHaveLength(2);
            expect(ids).toContain('a');
            expect(ids).toContain('b');
        });
    });

    describe('getAllEntities', () => {
        it('should return all entities', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: 'a', model: 'file', parent: null, pathname: 'a.txt' });
            cache.addEntity({ id: 'b', model: 'folder', parent: null, pathname: 'dir' });

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
        it('should handle deeply nested paths', async () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

            // Create 100-level deep path
            let parentId = ROOT_ID;
            for (let i = 0; i < 100; i++) {
                const id = `level-${i}`;
                cache.addEntity({ id, model: 'folder', parent: parentId, pathname: `dir${i}` });
                parentId = id;
            }
            cache.addEntity({ id: 'leaf', model: 'file', parent: parentId, pathname: 'deep.txt' });

            // Should be able to resolve
            const path = '/dir0/' + Array.from({ length: 99 }, (_, i) => `dir${i + 1}`).join('/') + '/deep.txt';
            expect(await cache.resolvePath(path)).toBe('leaf');

            // Should be able to compute path
            const computed = cache.computePath('leaf');
            expect(computed).toBe(path);
        });

        it('should handle special characters in names', async () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntity({
                id: 'special',
                model: 'file',
                parent: ROOT_ID,
                pathname: 'file with spaces & special!@#.txt',
            });

            expect(await cache.resolvePath('/file with spaces & special!@#.txt')).toBe('special');
        });

        it('should handle unicode names', async () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntity({ id: 'unicode', model: 'file', parent: ROOT_ID, pathname: '日本語ファイル.txt' });

            expect(await cache.resolvePath('/日本語ファイル.txt')).toBe('unicode');
        });

        it('should handle empty name for root', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

            expect(cache.getEntity(ROOT_ID)!.pathname).toBe('');
            expect(cache.computePath(ROOT_ID)).toBe('/');
        });
    });

    // =========================================================================
    // CONSISTENCY TESTS
    // =========================================================================

    describe('consistency', () => {
        it('should maintain byId and childIndex consistency after operations', async () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntity({ id: 'file', model: 'file', parent: ROOT_ID, pathname: 'test.txt' });

            // Verify consistency
            expect(cache.getEntity('file')).toBeDefined();
            expect(cache.getChild(ROOT_ID, 'test.txt')).toBe('file');
            expect(await cache.resolvePath('/test.txt')).toBe('file');
            expect(cache.computePath('file')).toBe('/test.txt');

            // Rename
            cache.updateEntity('file', { pathname: 'renamed.txt' });

            // Verify consistency after rename
            expect(cache.getEntity('file')!.pathname).toBe('renamed.txt');
            expect(cache.getChild(ROOT_ID, 'test.txt')).toBeUndefined();
            expect(cache.getChild(ROOT_ID, 'renamed.txt')).toBe('file');
            expect(await cache.resolvePath('/test.txt')).toBeNull();
            expect(await cache.resolvePath('/renamed.txt')).toBe('file');
            expect(cache.computePath('file')).toBe('/renamed.txt');

            // Remove
            cache.removeEntity('file');

            // Verify consistency after remove
            expect(cache.getEntity('file')).toBeUndefined();
            expect(cache.getChild(ROOT_ID, 'renamed.txt')).toBeUndefined();
            expect(await cache.resolvePath('/renamed.txt')).toBeNull();
            expect(cache.computePath('file')).toBeNull();
        });
    });
});
