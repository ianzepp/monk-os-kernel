/**
 * PathCache Tests
 *
 * Tests for the PathCache class which provides O(1) path resolution
 * and model dispatch via in-memory path entry indexing.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { PathCache, ROOT_ID } from '@src/vfs/path-cache.js';

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

describe('PathCache', () => {
    describe('constructor', () => {
        it('should create an empty cache', () => {
            const cache = new PathCache();

            expect(cache.size).toBe(0);
        });

        it('should enable childrenOf by default', () => {
            const cache = new PathCache();

            cache.addEntry({ id: 'parent', model: 'folder', parent: null, pathname: 'root' });
            cache.addEntry({ id: 'child', model: 'file', parent: 'parent', pathname: 'file.txt' });

            // childrenOf should be maintained
            const children = cache.listChildren('parent');

            expect(children).toContain('child');
        });

        it('should allow disabling childrenOf index', () => {
            const cache = new PathCache({ maintainChildrenOf: false });

            cache.addEntry({ id: 'parent', model: 'folder', parent: null, pathname: 'root' });
            cache.addEntry({ id: 'child', model: 'file', parent: 'parent', pathname: 'file.txt' });

            // listChildren still works (falls back to scan)
            const children = cache.listChildren('parent');

            expect(children).toContain('child');
        });
    });

    // =========================================================================
    // ENTRY OPERATIONS
    // =========================================================================

    describe('addEntry', () => {
        let cache: PathCache;

        beforeEach(() => {
            cache = new PathCache();
        });

        it('should add entry to byId index', () => {
            cache.addEntry({ id: 'test-1', model: 'file', parent: 'root', pathname: 'test.txt' });

            const entry = cache.getEntry('test-1');

            expect(entry).toBeDefined();
            expect(entry!.id).toBe('test-1');
            expect(entry!.model).toBe('file');
            expect(entry!.parent).toBe('root');
            expect(entry!.pathname).toBe('test.txt');
        });

        it('should add entry to childIndex', () => {
            cache.addEntry({ id: 'parent', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntry({ id: 'child', model: 'file', parent: 'parent', pathname: 'file.txt' });

            const childId = cache.getChild('parent', 'file.txt');

            expect(childId).toBe('child');
        });

        it('should not add to childIndex for root entries', () => {
            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

            // Root has no parent, so no childIndex entry
            const entry = cache.getEntry(ROOT_ID);

            expect(entry).toBeDefined();
            expect(entry!.parent).toBeNull();
        });

        it('should coerce undefined parent to null', () => {
            cache.addEntry({ id: 'test', model: 'file', pathname: 'orphan.txt' });

            const entry = cache.getEntry('test');

            expect(entry!.parent).toBeNull();
        });

        it('should add to childrenOf index', () => {
            cache.addEntry({ id: 'parent', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntry({ id: 'child1', model: 'file', parent: 'parent', pathname: 'a.txt' });
            cache.addEntry({ id: 'child2', model: 'file', parent: 'parent', pathname: 'b.txt' });

            const children = cache.listChildren('parent');

            expect(children).toHaveLength(2);
            expect(children).toContain('child1');
            expect(children).toContain('child2');
        });
    });

    describe('updateEntry', () => {
        let cache: PathCache;

        beforeEach(() => {
            cache = new PathCache();
            cache.addEntry({ id: 'parent1', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntry({ id: 'parent2', model: 'folder', parent: null, pathname: 'tmp' });
            cache.addEntry({ id: 'file1', model: 'file', parent: 'parent1', pathname: 'old.txt' });
        });

        it('should handle rename', () => {
            cache.updateEntry('file1', { pathname: 'new.txt' });

            // Old name should not resolve
            expect(cache.getChild('parent1', 'old.txt')).toBeUndefined();

            // New name should resolve
            expect(cache.getChild('parent1', 'new.txt')).toBe('file1');

            // Entry should have new name
            const entry = cache.getEntry('file1');

            expect(entry!.pathname).toBe('new.txt');
        });

        it('should handle move (parent change)', () => {
            cache.updateEntry('file1', { parent: 'parent2' });

            // Should not be child of old parent
            expect(cache.getChild('parent1', 'old.txt')).toBeUndefined();

            // Should be child of new parent
            expect(cache.getChild('parent2', 'old.txt')).toBe('file1');

            // Entry should have new parent
            const entry = cache.getEntry('file1');

            expect(entry!.parent).toBe('parent2');
        });

        it('should handle move to root (parent = null)', () => {
            cache.updateEntry('file1', { parent: null });

            // Should not be child of old parent
            expect(cache.getChild('parent1', 'old.txt')).toBeUndefined();

            // Entry should have no parent
            const entry = cache.getEntry('file1');

            expect(entry!.parent).toBeNull();
        });

        it('should be idempotent for unchanged values', () => {
            cache.updateEntry('file1', { pathname: 'old.txt' }); // Same name

            // Should still resolve
            expect(cache.getChild('parent1', 'old.txt')).toBe('file1');
        });

        it('should handle non-existent entry gracefully', () => {
            // Should not throw
            cache.updateEntry('non-existent', { pathname: 'foo.txt' });
        });
    });

    describe('removeEntry', () => {
        let cache: PathCache;

        beforeEach(() => {
            cache = new PathCache();
            cache.addEntry({ id: 'parent', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntry({ id: 'child', model: 'file', parent: 'parent', pathname: 'file.txt' });
        });

        it('should remove from byId', () => {
            cache.removeEntry('child');
            expect(cache.getEntry('child')).toBeUndefined();
        });

        it('should remove from childIndex', () => {
            cache.removeEntry('child');
            expect(cache.getChild('parent', 'file.txt')).toBeUndefined();
        });

        it('should remove from childrenOf', () => {
            cache.removeEntry('child');
            const children = cache.listChildren('parent');

            expect(children).not.toContain('child');
        });

        it('should handle non-existent entry gracefully', () => {
            // Should not throw
            cache.removeEntry('non-existent');
        });

        it('should remove childrenOf entry for parent being removed', () => {
            cache.removeEntry('parent');

            // The parent itself should be gone
            expect(cache.hasEntry('parent')).toBe(false);
        });
    });

    // =========================================================================
    // PATH RESOLUTION
    // =========================================================================

    describe('resolvePath', () => {
        let cache: PathCache;

        beforeEach(() => {
            cache = new PathCache();
            // Build a tree: / -> home -> user -> docs -> file.txt
            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntry({ id: 'home-id', model: 'folder', parent: ROOT_ID, pathname: 'home' });
            cache.addEntry({ id: 'user-id', model: 'folder', parent: 'home-id', pathname: 'user' });
            cache.addEntry({ id: 'docs-id', model: 'folder', parent: 'user-id', pathname: 'docs' });
            cache.addEntry({ id: 'file-id', model: 'file', parent: 'docs-id', pathname: 'file.txt' });
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
        let cache: PathCache;

        beforeEach(() => {
            cache = new PathCache();
            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntry({ id: 'home-id', model: 'folder', parent: ROOT_ID, pathname: 'home' });
            cache.addEntry({ id: 'user-id', model: 'folder', parent: 'home-id', pathname: 'user' });
            cache.addEntry({ id: 'file-id', model: 'file', parent: 'user-id', pathname: 'file.txt' });
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

        it('should return null for non-existent entry', () => {
            expect(cache.computePath('non-existent')).toBeNull();
        });
    });

    describe('resolveParent', () => {
        let cache: PathCache;

        beforeEach(() => {
            cache = new PathCache();
            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntry({ id: 'home-id', model: 'folder', parent: ROOT_ID, pathname: 'home' });
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
    // ENTRY LOOKUP
    // =========================================================================

    describe('getEntry', () => {
        it('should return entry if exists', () => {
            const cache = new PathCache();

            cache.addEntry({ id: 'test', model: 'file', parent: null, pathname: 'test.txt' });

            const entry = cache.getEntry('test');

            expect(entry).toBeDefined();
            expect(entry!.id).toBe('test');
        });

        it('should return undefined if not exists', () => {
            const cache = new PathCache();

            expect(cache.getEntry('missing')).toBeUndefined();
        });
    });

    describe('getModel', () => {
        it('should return model name', () => {
            const cache = new PathCache();

            cache.addEntry({ id: 'test', model: 'video', parent: null, pathname: 'clip.mp4' });

            expect(cache.getModel('test')).toBe('video');
        });

        it('should return undefined for missing entry', () => {
            const cache = new PathCache();

            expect(cache.getModel('missing')).toBeUndefined();
        });
    });

    describe('hasEntry', () => {
        it('should return true if entry exists', () => {
            const cache = new PathCache();

            cache.addEntry({ id: 'test', model: 'file', parent: null, pathname: 'test.txt' });

            expect(cache.hasEntry('test')).toBe(true);
        });

        it('should return false if entry does not exist', () => {
            const cache = new PathCache();

            expect(cache.hasEntry('missing')).toBe(false);
        });
    });

    describe('listChildren', () => {
        let cache: PathCache;

        beforeEach(() => {
            cache = new PathCache();
            cache.addEntry({ id: 'parent', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntry({ id: 'child1', model: 'file', parent: 'parent', pathname: 'a.txt' });
            cache.addEntry({ id: 'child2', model: 'file', parent: 'parent', pathname: 'b.txt' });
            cache.addEntry({ id: 'child3', model: 'folder', parent: 'parent', pathname: 'subdir' });
        });

        it('should return all children', () => {
            const children = cache.listChildren('parent');

            expect(children).toHaveLength(3);
            expect(children).toContain('child1');
            expect(children).toContain('child2');
            expect(children).toContain('child3');
        });

        it('should return empty array for leaf entries', () => {
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
        it('should load entries from entities table', async () => {
            const cache = new PathCache();
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
            const cache = new PathCache();

            cache.addEntry({ id: 'existing', model: 'file', parent: null, pathname: 'old.txt' });

            const mockDb = createMockDb([
                { id: 'new', model: 'file', parent: null, pathname: 'new.txt' },
            ]);

            await cache.loadFromDatabase(mockDb as any);

            expect(cache.hasEntry('existing')).toBe(false);
            expect(cache.hasEntry('new')).toBe(true);
        });

        it('should handle empty entities table', async () => {
            const cache = new PathCache();
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
            const cache = new PathCache();

            cache.addEntry({ id: 'parent', model: 'folder', parent: null, pathname: 'home' });
            cache.addEntry({ id: 'child1', model: 'file', parent: 'parent', pathname: 'a.txt' });
            cache.addEntry({ id: 'child2', model: 'file', parent: 'parent', pathname: 'b.txt' });

            const stats = cache.getStats();

            expect(stats.entryCount).toBe(3);
            expect(stats.childIndexSize).toBe(2); // Only children have childIndex entries
            expect(stats.childrenOfSize).toBe(1); // Only 'parent' has children
            expect(stats.estimatedMemoryBytes).toBeGreaterThan(0);
        });
    });

    describe('clear', () => {
        it('should remove all entries', () => {
            const cache = new PathCache();

            cache.addEntry({ id: 'a', model: 'file', parent: null, pathname: 'a.txt' });
            cache.addEntry({ id: 'b', model: 'file', parent: null, pathname: 'b.txt' });

            cache.clear();

            expect(cache.size).toBe(0);
            expect(cache.getEntry('a')).toBeUndefined();
            expect(cache.getEntry('b')).toBeUndefined();
        });
    });

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    describe('getAllIds', () => {
        it('should return all entry IDs', () => {
            const cache = new PathCache();

            cache.addEntry({ id: 'a', model: 'file', parent: null, pathname: 'a.txt' });
            cache.addEntry({ id: 'b', model: 'file', parent: null, pathname: 'b.txt' });

            const ids = cache.getAllIds();

            expect(ids).toHaveLength(2);
            expect(ids).toContain('a');
            expect(ids).toContain('b');
        });
    });

    describe('getAllEntries', () => {
        it('should return all entries', () => {
            const cache = new PathCache();

            cache.addEntry({ id: 'a', model: 'file', parent: null, pathname: 'a.txt' });
            cache.addEntry({ id: 'b', model: 'folder', parent: null, pathname: 'dir' });

            const entries = cache.getAllEntries();

            expect(entries).toHaveLength(2);

            const models = entries.map(e => e.model);

            expect(models).toContain('file');
            expect(models).toContain('folder');
        });
    });

    // =========================================================================
    // EDGE CASES
    // =========================================================================

    describe('edge cases', () => {
        it('should handle deeply nested paths', async () => {
            const cache = new PathCache();

            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

            // Create 100-level deep path
            let parentId = ROOT_ID;

            for (let i = 0; i < 100; i++) {
                const id = `level-${i}`;

                cache.addEntry({ id, model: 'folder', parent: parentId, pathname: `dir${i}` });
                parentId = id;
            }

            cache.addEntry({ id: 'leaf', model: 'file', parent: parentId, pathname: 'deep.txt' });

            // Should be able to resolve
            const path = '/dir0/' + Array.from({ length: 99 }, (_, i) => `dir${i + 1}`).join('/') + '/deep.txt';

            expect(await cache.resolvePath(path)).toBe('leaf');

            // Should be able to compute path
            const computed = cache.computePath('leaf');

            expect(computed).toBe(path);
        });

        it('should handle special characters in names', async () => {
            const cache = new PathCache();

            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntry({
                id: 'special',
                model: 'file',
                parent: ROOT_ID,
                pathname: 'file with spaces & special!@#.txt',
            });

            expect(await cache.resolvePath('/file with spaces & special!@#.txt')).toBe('special');
        });

        it('should handle unicode names', async () => {
            const cache = new PathCache();

            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntry({ id: 'unicode', model: 'file', parent: ROOT_ID, pathname: '日本語ファイル.txt' });

            expect(await cache.resolvePath('/日本語ファイル.txt')).toBe('unicode');
        });

        it('should handle empty name for root', () => {
            const cache = new PathCache();

            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

            expect(cache.getEntry(ROOT_ID)!.pathname).toBe('');
            expect(cache.computePath(ROOT_ID)).toBe('/');
        });
    });

    // =========================================================================
    // CONSISTENCY TESTS
    // =========================================================================

    describe('consistency', () => {
        it('should maintain byId and childIndex consistency after operations', async () => {
            const cache = new PathCache();

            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });
            cache.addEntry({ id: 'file', model: 'file', parent: ROOT_ID, pathname: 'test.txt' });

            // Verify consistency
            expect(cache.getEntry('file')).toBeDefined();
            expect(cache.getChild(ROOT_ID, 'test.txt')).toBe('file');
            expect(await cache.resolvePath('/test.txt')).toBe('file');
            expect(cache.computePath('file')).toBe('/test.txt');

            // Rename
            cache.updateEntry('file', { pathname: 'renamed.txt' });

            // Verify consistency after rename
            expect(cache.getEntry('file')!.pathname).toBe('renamed.txt');
            expect(cache.getChild(ROOT_ID, 'test.txt')).toBeUndefined();
            expect(cache.getChild(ROOT_ID, 'renamed.txt')).toBe('file');
            expect(await cache.resolvePath('/test.txt')).toBeNull();
            expect(await cache.resolvePath('/renamed.txt')).toBe('file');
            expect(cache.computePath('file')).toBe('/renamed.txt');

            // Remove
            cache.removeEntry('file');

            // Verify consistency after remove
            expect(cache.getEntry('file')).toBeUndefined();
            expect(cache.getChild(ROOT_ID, 'renamed.txt')).toBeUndefined();
            expect(await cache.resolvePath('/renamed.txt')).toBeNull();
            expect(cache.computePath('file')).toBeNull();
        });
    });
});
