/**
 * EntityCache Performance Tests
 *
 * Tests for EntityCache performance at scale:
 * - Path resolution with large entity counts
 * - Path computation performance
 * - Add/update/remove performance
 * - Memory usage estimates
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { EntityCache, ROOT_ID } from '@src/ems/entity-cache.js';

// =============================================================================
// TIMEOUTS
// =============================================================================

const TIMEOUT_SHORT = 10_000;
const TIMEOUT_MEDIUM = 30_000;
const TIMEOUT_LONG = 60_000;
const TIMEOUT_VERY_LONG = 120_000;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a flat structure with many files at root.
 */
function createFlatStructure(cache: EntityCache, count: number): void {
    cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });

    for (let i = 0; i < count; i++) {
        cache.addEntity({
            id: `file-${i}`,
            model: 'file',
            parent: ROOT_ID,
            name: `file-${i}.txt`,
        });
    }
}

/**
 * Create a deep structure with nested folders.
 * Returns the deepest entity ID.
 */
function createDeepStructure(cache: EntityCache, depth: number): string {
    cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });

    let parentId = ROOT_ID;
    for (let i = 0; i < depth; i++) {
        const id = `level-${i}`;
        cache.addEntity({
            id,
            model: 'folder',
            parent: parentId,
            name: `dir${i}`,
        });
        parentId = id;
    }

    // Add a file at the deepest level
    const fileId = 'deepest-file';
    cache.addEntity({
        id: fileId,
        model: 'file',
        parent: parentId,
        name: 'deep.txt',
    });

    return fileId;
}

/**
 * Create a wide + deep structure (realistic tree).
 * Each folder has `width` children, up to `depth` levels.
 */
function createTreeStructure(
    cache: EntityCache,
    depth: number,
    width: number,
    parentId: string = ROOT_ID,
    currentDepth: number = 0,
    counter: { value: number } = { value: 0 }
): void {
    if (currentDepth >= depth) return;

    for (let i = 0; i < width; i++) {
        const id = `node-${counter.value++}`;
        const isFolder = currentDepth < depth - 1;

        cache.addEntity({
            id,
            model: isFolder ? 'folder' : 'file',
            parent: parentId,
            name: `item-${i}`,
        });

        if (isFolder) {
            createTreeStructure(cache, depth, width, id, currentDepth + 1, counter);
        }
    }
}

/**
 * Generate path to deepest file in a tree structure.
 */
function getDeepPath(depth: number): string {
    const parts = [];
    for (let i = 0; i < depth; i++) {
        parts.push(`dir${i}`);
    }
    parts.push('deep.txt');
    return '/' + parts.join('/');
}

// =============================================================================
// PATH RESOLUTION PERFORMANCE
// =============================================================================

describe('EntityCache: Path Resolution Performance', () => {
    describe('flat structure (all files at root)', () => {
        it('should resolve path with 1,000 entities', () => {
            const cache = new EntityCache();
            createFlatStructure(cache, 1000);

            const start = performance.now();
            for (let i = 0; i < 1000; i++) {
                cache.resolvePath(`/file-${i}.txt`);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 1,000 paths (1K entities): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(50); // 0.05ms per path
        });

        it('should resolve path with 10,000 entities', () => {
            const cache = new EntityCache();
            createFlatStructure(cache, 10000);

            const start = performance.now();
            for (let i = 0; i < 1000; i++) {
                cache.resolvePath(`/file-${i}.txt`);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 1,000 paths (10K entities): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(50);
        });

        it('should resolve path with 100,000 entities', { timeout: TIMEOUT_MEDIUM }, () => {
            const cache = new EntityCache();
            createFlatStructure(cache, 100000);

            const start = performance.now();
            for (let i = 0; i < 1000; i++) {
                cache.resolvePath(`/file-${i}.txt`);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 1,000 paths (100K entities): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(100);
        });

        it('should resolve path with 1,000,000 entities', { timeout: TIMEOUT_LONG }, () => {
            const cache = new EntityCache();
            createFlatStructure(cache, 1000000);

            const start = performance.now();
            for (let i = 0; i < 1000; i++) {
                cache.resolvePath(`/file-${i}.txt`);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 1,000 paths (1M entities): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(200);

            // Report memory usage
            const stats = cache.getStats();
            console.log(`Memory estimate: ${(stats.estimatedMemoryBytes / 1024 / 1024).toFixed(2)} MB`);
        });
    });

    describe('deep structure (nested folders)', () => {
        it('should resolve 10-level deep path', () => {
            const cache = new EntityCache();
            createDeepStructure(cache, 10);
            const path = getDeepPath(10);

            const start = performance.now();
            for (let i = 0; i < 10000; i++) {
                cache.resolvePath(path);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 10-level path x 10,000: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(100);
        });

        it('should resolve 50-level deep path', () => {
            const cache = new EntityCache();
            createDeepStructure(cache, 50);
            const path = getDeepPath(50);

            const start = performance.now();
            for (let i = 0; i < 10000; i++) {
                cache.resolvePath(path);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 50-level path x 10,000: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(500);
        });

        it('should resolve 100-level deep path', () => {
            const cache = new EntityCache();
            createDeepStructure(cache, 100);
            const path = getDeepPath(100);

            const start = performance.now();
            for (let i = 0; i < 10000; i++) {
                cache.resolvePath(path);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 100-level path x 10,000: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(1000);
        });
    });
});

// =============================================================================
// PATH COMPUTATION PERFORMANCE
// =============================================================================

describe('EntityCache: Path Computation Performance', () => {
    it('should compute path from deep entity (10 levels)', () => {
        const cache = new EntityCache();
        const fileId = createDeepStructure(cache, 10);

        const start = performance.now();
        for (let i = 0; i < 10000; i++) {
            cache.computePath(fileId);
        }
        const elapsed = performance.now() - start;

        console.log(`Compute 10-level path x 10,000: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/path)`);
        expect(elapsed).toBeLessThan(100);
    });

    it('should compute path from deep entity (50 levels)', () => {
        const cache = new EntityCache();
        const fileId = createDeepStructure(cache, 50);

        const start = performance.now();
        for (let i = 0; i < 10000; i++) {
            cache.computePath(fileId);
        }
        const elapsed = performance.now() - start;

        console.log(`Compute 50-level path x 10,000: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/path)`);
        expect(elapsed).toBeLessThan(500);
    });

    it('should compute path from deep entity (100 levels)', () => {
        const cache = new EntityCache();
        const fileId = createDeepStructure(cache, 100);

        const start = performance.now();
        for (let i = 0; i < 10000; i++) {
            cache.computePath(fileId);
        }
        const elapsed = performance.now() - start;

        console.log(`Compute 100-level path x 10,000: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/path)`);
        expect(elapsed).toBeLessThan(1000);
    });
});

// =============================================================================
// ADD/UPDATE/REMOVE PERFORMANCE
// =============================================================================

describe('EntityCache: Mutation Performance', () => {
    describe('addEntity', () => {
        it('should add 10,000 entities', () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });

            const start = performance.now();
            for (let i = 0; i < 10000; i++) {
                cache.addEntity({
                    id: `file-${i}`,
                    model: 'file',
                    parent: ROOT_ID,
                    name: `file-${i}.txt`,
                });
            }
            const elapsed = performance.now() - start;

            console.log(`Add 10,000 entities: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/entity)`);
            expect(elapsed).toBeLessThan(500);
        });

        it('should add 100,000 entities', { timeout: TIMEOUT_MEDIUM }, () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });

            const start = performance.now();
            for (let i = 0; i < 100000; i++) {
                cache.addEntity({
                    id: `file-${i}`,
                    model: 'file',
                    parent: ROOT_ID,
                    name: `file-${i}.txt`,
                });
            }
            const elapsed = performance.now() - start;

            console.log(`Add 100,000 entities: ${elapsed.toFixed(2)}ms (${(elapsed / 100000).toFixed(4)}ms/entity)`);
            expect(elapsed).toBeLessThan(5000);
        });

        it('should add 1,000,000 entities', { timeout: TIMEOUT_LONG }, () => {
            const cache = new EntityCache();
            cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });

            const start = performance.now();
            for (let i = 0; i < 1000000; i++) {
                cache.addEntity({
                    id: `file-${i}`,
                    model: 'file',
                    parent: ROOT_ID,
                    name: `file-${i}.txt`,
                });
            }
            const elapsed = performance.now() - start;

            console.log(`Add 1,000,000 entities: ${elapsed.toFixed(2)}ms (${(elapsed / 1000000).toFixed(4)}ms/entity)`);
            expect(elapsed).toBeLessThan(30000);
        });
    });

    describe('updateEntity (rename)', () => {
        it('should rename 10,000 entities', () => {
            const cache = new EntityCache();
            createFlatStructure(cache, 10000);

            const start = performance.now();
            for (let i = 0; i < 10000; i++) {
                cache.updateEntity(`file-${i}`, { name: `renamed-${i}.txt` });
            }
            const elapsed = performance.now() - start;

            console.log(`Rename 10,000 entities: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/entity)`);
            expect(elapsed).toBeLessThan(1000);
        });
    });

    describe('removeEntity', () => {
        it('should remove 10,000 entities', () => {
            const cache = new EntityCache();
            createFlatStructure(cache, 10000);

            const start = performance.now();
            for (let i = 0; i < 10000; i++) {
                cache.removeEntity(`file-${i}`);
            }
            const elapsed = performance.now() - start;

            console.log(`Remove 10,000 entities: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/entity)`);
            expect(elapsed).toBeLessThan(500);
        });
    });
});

// =============================================================================
// LIST CHILDREN PERFORMANCE
// =============================================================================

describe('EntityCache: listChildren Performance', () => {
    it('should list 1,000 children (using childrenOf index)', () => {
        const cache = new EntityCache({ maintainChildrenOf: true });
        createFlatStructure(cache, 1000);

        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
            cache.listChildren(ROOT_ID);
        }
        const elapsed = performance.now() - start;

        console.log(`List 1,000 children x 1,000 (with index): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/list)`);
        expect(elapsed).toBeLessThan(100);
    });

    it('should list 1,000 children (without childrenOf index, scan)', () => {
        const cache = new EntityCache({ maintainChildrenOf: false });
        createFlatStructure(cache, 1000);

        const start = performance.now();
        for (let i = 0; i < 100; i++) {
            cache.listChildren(ROOT_ID);
        }
        const elapsed = performance.now() - start;

        console.log(`List 1,000 children x 100 (scan): ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(4)}ms/list)`);
        expect(elapsed).toBeLessThan(500);
    });

    it('should list 10,000 children (using childrenOf index)', { timeout: TIMEOUT_MEDIUM }, () => {
        const cache = new EntityCache({ maintainChildrenOf: true });
        createFlatStructure(cache, 10000);

        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
            cache.listChildren(ROOT_ID);
        }
        const elapsed = performance.now() - start;

        console.log(`List 10,000 children x 1,000 (with index): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/list)`);
        expect(elapsed).toBeLessThan(2000);
    });
});

// =============================================================================
// MEMORY USAGE
// =============================================================================

describe('EntityCache: Memory Usage', () => {
    it('should report memory estimate for 10,000 entities', () => {
        const cache = new EntityCache();
        createFlatStructure(cache, 10000);

        const stats = cache.getStats();
        const mbUsed = stats.estimatedMemoryBytes / 1024 / 1024;

        console.log(`10,000 entities: ~${mbUsed.toFixed(2)} MB estimated`);
        console.log(`  - entityCount: ${stats.entityCount}`);
        console.log(`  - childIndexSize: ${stats.childIndexSize}`);
        console.log(`  - childrenOfSize: ${stats.childrenOfSize}`);

        // Should be roughly 2.5-3.5 MB for 10K entities
        expect(mbUsed).toBeLessThan(10);
    });

    it('should report memory estimate for 100,000 entities', { timeout: TIMEOUT_MEDIUM }, () => {
        const cache = new EntityCache();
        createFlatStructure(cache, 100000);

        const stats = cache.getStats();
        const mbUsed = stats.estimatedMemoryBytes / 1024 / 1024;

        console.log(`100,000 entities: ~${mbUsed.toFixed(2)} MB estimated`);

        // Should be roughly 25-35 MB for 100K entities
        expect(mbUsed).toBeLessThan(100);
    });

    it('should report memory estimate for 1,000,000 entities', { timeout: TIMEOUT_LONG }, () => {
        const cache = new EntityCache();
        createFlatStructure(cache, 1000000);

        const stats = cache.getStats();
        const mbUsed = stats.estimatedMemoryBytes / 1024 / 1024;

        console.log(`1,000,000 entities: ~${mbUsed.toFixed(2)} MB estimated`);

        // Should be roughly 250-350 MB for 1M entities
        expect(mbUsed).toBeLessThan(500);
    });
});

// =============================================================================
// REALISTIC WORKLOADS
// =============================================================================

describe('EntityCache: Realistic Workloads', () => {
    it('should handle mixed operations on 10K entities', () => {
        const cache = new EntityCache();
        createFlatStructure(cache, 10000);

        const start = performance.now();

        // Mixed workload: resolve, compute, add, remove, rename
        for (let i = 0; i < 1000; i++) {
            // Resolve 2 paths
            cache.resolvePath(`/file-${i}.txt`);
            cache.resolvePath(`/file-${i + 1}.txt`);

            // Compute 1 path
            cache.computePath(`file-${i}`);

            // Add 1 entity
            cache.addEntity({
                id: `new-${i}`,
                model: 'file',
                parent: ROOT_ID,
                name: `new-${i}.txt`,
            });

            // Remove 1 entity
            cache.removeEntity(`new-${i}`);
        }

        const elapsed = performance.now() - start;

        console.log(`Mixed ops x 1,000 (on 10K entities): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/cycle)`);
        expect(elapsed).toBeLessThan(500);
    });

    it('should handle tree traversal workload', { timeout: TIMEOUT_MEDIUM }, () => {
        const cache = new EntityCache();
        cache.addEntity({ id: ROOT_ID, model: 'folder', parent: null, name: '' });

        // Create a tree: 5 levels deep, 10 items per level = 11,111 entities
        createTreeStructure(cache, 5, 10);

        const nodeIds = cache.getAllIds();
        const start = performance.now();

        // For each node, compute its path
        for (const id of nodeIds) {
            cache.computePath(id);
        }

        const elapsed = performance.now() - start;

        console.log(`Compute path for all ${nodeIds.length} tree nodes: ${elapsed.toFixed(2)}ms (${(elapsed / nodeIds.length).toFixed(4)}ms/node)`);
        expect(elapsed).toBeLessThan(5000);
    });
});
