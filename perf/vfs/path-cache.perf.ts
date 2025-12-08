/**
 * PathCache Performance Tests
 *
 * Tests for PathCache performance at scale:
 * - Path resolution with large entry counts
 * - Path computation performance
 * - Add/update/remove performance
 * - Memory usage estimates
 */

import { describe, it, expect } from 'bun:test';
import { PathCache, ROOT_ID } from '@src/vfs/path-cache.js';

// =============================================================================
// TIMEOUTS
// =============================================================================

const TIMEOUT_MEDIUM = 30_000;
const TIMEOUT_LONG = 60_000;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a flat structure with many files at root.
 */
function createFlatStructure(cache: PathCache, count: number): void {
    cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

    for (let i = 0; i < count; i++) {
        cache.addEntry({
            id: `file-${i}`,
            model: 'file',
            parent: ROOT_ID,
            pathname: `file-${i}.txt`,
        });
    }
}

/**
 * Create a deep structure with nested folders.
 * Returns the deepest entry ID.
 */
function createDeepStructure(cache: PathCache, depth: number): string {
    cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

    let parentId = ROOT_ID;
    for (let i = 0; i < depth; i++) {
        const id = `level-${i}`;
        cache.addEntry({
            id,
            model: 'folder',
            parent: parentId,
            pathname: `dir${i}`,
        });
        parentId = id;
    }

    // Add a file at the deepest level
    const fileId = 'deepest-file';
    cache.addEntry({
        id: fileId,
        model: 'file',
        parent: parentId,
        pathname: 'deep.txt',
    });

    return fileId;
}

/**
 * Create a wide + deep structure (realistic tree).
 * Each folder has `width` children, up to `depth` levels.
 */
function createTreeStructure(
    cache: PathCache,
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

        cache.addEntry({
            id,
            model: isFolder ? 'folder' : 'file',
            parent: parentId,
            pathname: `item-${i}`,
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

describe('PathCache: Path Resolution Performance', () => {
    describe('flat structure (all files at root)', () => {
        it('should resolve path with 1,000 entries', () => {
            const cache = new PathCache();
            createFlatStructure(cache, 1000);

            const start = performance.now();
            for (let i = 0; i < 1000; i++) {
                cache.resolvePath(`/file-${i}.txt`);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 1,000 paths (1K entries): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(50); // 0.05ms per path
        });

        it('should resolve path with 10,000 entries', () => {
            const cache = new PathCache();
            createFlatStructure(cache, 10000);

            const start = performance.now();
            for (let i = 0; i < 1000; i++) {
                cache.resolvePath(`/file-${i}.txt`);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 1,000 paths (10K entries): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(50);
        });

        it('should resolve path with 100,000 entries', () => {
            const cache = new PathCache();
            createFlatStructure(cache, 100000);

            const start = performance.now();
            for (let i = 0; i < 1000; i++) {
                cache.resolvePath(`/file-${i}.txt`);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 1,000 paths (100K entries): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(100);
        }, { timeout: TIMEOUT_MEDIUM });

        it('should resolve path with 1,000,000 entries', () => {
            const cache = new PathCache();
            createFlatStructure(cache, 1000000);

            const start = performance.now();
            for (let i = 0; i < 1000; i++) {
                cache.resolvePath(`/file-${i}.txt`);
            }
            const elapsed = performance.now() - start;

            console.log(`Resolve 1,000 paths (1M entries): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/path)`);
            expect(elapsed).toBeLessThan(200);

            // Report memory usage
            const stats = cache.getStats();
            console.log(`Memory estimate: ${(stats.estimatedMemoryBytes / 1024 / 1024).toFixed(2)} MB`);
        }, { timeout: TIMEOUT_LONG });
    });

    describe('deep structure (nested folders)', () => {
        it('should resolve 10-level deep path', () => {
            const cache = new PathCache();
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
            const cache = new PathCache();
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
            const cache = new PathCache();
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

describe('PathCache: Path Computation Performance', () => {
    it('should compute path from deep entry (10 levels)', () => {
        const cache = new PathCache();
        const fileId = createDeepStructure(cache, 10);

        const start = performance.now();
        for (let i = 0; i < 10000; i++) {
            cache.computePath(fileId);
        }
        const elapsed = performance.now() - start;

        console.log(`Compute 10-level path x 10,000: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/path)`);
        expect(elapsed).toBeLessThan(100);
    });

    it('should compute path from deep entry (50 levels)', () => {
        const cache = new PathCache();
        const fileId = createDeepStructure(cache, 50);

        const start = performance.now();
        for (let i = 0; i < 10000; i++) {
            cache.computePath(fileId);
        }
        const elapsed = performance.now() - start;

        console.log(`Compute 50-level path x 10,000: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/path)`);
        expect(elapsed).toBeLessThan(500);
    });

    it('should compute path from deep entry (100 levels)', () => {
        const cache = new PathCache();
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

describe('PathCache: Mutation Performance', () => {
    describe('addEntry', () => {
        it('should add 10,000 entries', () => {
            const cache = new PathCache();
            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

            const start = performance.now();
            for (let i = 0; i < 10000; i++) {
                cache.addEntry({
                    id: `file-${i}`,
                    model: 'file',
                    parent: ROOT_ID,
                    pathname: `file-${i}.txt`,
                });
            }
            const elapsed = performance.now() - start;

            console.log(`Add 10,000 entries: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/entry)`);
            expect(elapsed).toBeLessThan(500);
        });

        it('should add 100,000 entries', () => {
            const cache = new PathCache();
            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

            const start = performance.now();
            for (let i = 0; i < 100000; i++) {
                cache.addEntry({
                    id: `file-${i}`,
                    model: 'file',
                    parent: ROOT_ID,
                    pathname: `file-${i}.txt`,
                });
            }
            const elapsed = performance.now() - start;

            console.log(`Add 100,000 entries: ${elapsed.toFixed(2)}ms (${(elapsed / 100000).toFixed(4)}ms/entry)`);
            expect(elapsed).toBeLessThan(5000);
        }, { timeout: TIMEOUT_MEDIUM });

        it('should add 1,000,000 entries', () => {
            const cache = new PathCache();
            cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

            const start = performance.now();
            for (let i = 0; i < 1000000; i++) {
                cache.addEntry({
                    id: `file-${i}`,
                    model: 'file',
                    parent: ROOT_ID,
                    pathname: `file-${i}.txt`,
                });
            }
            const elapsed = performance.now() - start;

            console.log(`Add 1,000,000 entries: ${elapsed.toFixed(2)}ms (${(elapsed / 1000000).toFixed(4)}ms/entry)`);
            expect(elapsed).toBeLessThan(30000);
        }, { timeout: TIMEOUT_LONG });
    });

    describe('updateEntry (rename)', () => {
        it('should rename 10,000 entries', () => {
            const cache = new PathCache();
            createFlatStructure(cache, 10000);

            const start = performance.now();
            for (let i = 0; i < 10000; i++) {
                cache.updateEntry(`file-${i}`, { pathname: `renamed-${i}.txt` });
            }
            const elapsed = performance.now() - start;

            console.log(`Rename 10,000 entries: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/entry)`);
            expect(elapsed).toBeLessThan(1000);
        });
    });

    describe('removeEntry', () => {
        it('should remove 10,000 entries', () => {
            const cache = new PathCache();
            createFlatStructure(cache, 10000);

            const start = performance.now();
            for (let i = 0; i < 10000; i++) {
                cache.removeEntry(`file-${i}`);
            }
            const elapsed = performance.now() - start;

            console.log(`Remove 10,000 entries: ${elapsed.toFixed(2)}ms (${(elapsed / 10000).toFixed(4)}ms/entry)`);
            expect(elapsed).toBeLessThan(500);
        });
    });
});

// =============================================================================
// LIST CHILDREN PERFORMANCE
// =============================================================================

describe('PathCache: listChildren Performance', () => {
    it('should list 1,000 children (using childrenOf index)', () => {
        const cache = new PathCache({ maintainChildrenOf: true });
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
        const cache = new PathCache({ maintainChildrenOf: false });
        createFlatStructure(cache, 1000);

        const start = performance.now();
        for (let i = 0; i < 100; i++) {
            cache.listChildren(ROOT_ID);
        }
        const elapsed = performance.now() - start;

        console.log(`List 1,000 children x 100 (scan): ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(4)}ms/list)`);
        expect(elapsed).toBeLessThan(500);
    });

    it('should list 10,000 children (using childrenOf index)', () => {
        const cache = new PathCache({ maintainChildrenOf: true });
        createFlatStructure(cache, 10000);

        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
            cache.listChildren(ROOT_ID);
        }
        const elapsed = performance.now() - start;

        console.log(`List 10,000 children x 1,000 (with index): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/list)`);
        expect(elapsed).toBeLessThan(2000);
    }, { timeout: TIMEOUT_MEDIUM });
});

// =============================================================================
// MEMORY USAGE
// =============================================================================

describe('PathCache: Memory Usage', () => {
    it('should report memory estimate for 10,000 entries', () => {
        const cache = new PathCache();
        createFlatStructure(cache, 10000);

        const stats = cache.getStats();
        const mbUsed = stats.estimatedMemoryBytes / 1024 / 1024;

        console.log(`10,000 entries: ~${mbUsed.toFixed(2)} MB estimated`);
        console.log(`  - entryCount: ${stats.entryCount}`);
        console.log(`  - childIndexSize: ${stats.childIndexSize}`);
        console.log(`  - childrenOfSize: ${stats.childrenOfSize}`);

        // Should be roughly 2.5-3.5 MB for 10K entries
        expect(mbUsed).toBeLessThan(10);
    });

    it('should report memory estimate for 100,000 entries', () => {
        const cache = new PathCache();
        createFlatStructure(cache, 100000);

        const stats = cache.getStats();
        const mbUsed = stats.estimatedMemoryBytes / 1024 / 1024;

        console.log(`100,000 entries: ~${mbUsed.toFixed(2)} MB estimated`);

        // Should be roughly 25-35 MB for 100K entries
        expect(mbUsed).toBeLessThan(100);
    }, { timeout: TIMEOUT_MEDIUM });

    it('should report memory estimate for 1,000,000 entries', () => {
        const cache = new PathCache();
        createFlatStructure(cache, 1000000);

        const stats = cache.getStats();
        const mbUsed = stats.estimatedMemoryBytes / 1024 / 1024;

        console.log(`1,000,000 entries: ~${mbUsed.toFixed(2)} MB estimated`);

        // Should be roughly 250-350 MB for 1M entries
        expect(mbUsed).toBeLessThan(500);
    }, { timeout: TIMEOUT_LONG });
});

// =============================================================================
// REALISTIC WORKLOADS
// =============================================================================

describe('PathCache: Realistic Workloads', () => {
    it('should handle mixed operations on 10K entries', () => {
        const cache = new PathCache();
        createFlatStructure(cache, 10000);

        const start = performance.now();

        // Mixed workload: resolve, compute, add, remove, rename
        for (let i = 0; i < 1000; i++) {
            // Resolve 2 paths
            cache.resolvePath(`/file-${i}.txt`);
            cache.resolvePath(`/file-${i + 1}.txt`);

            // Compute 1 path
            cache.computePath(`file-${i}`);

            // Add 1 entry
            cache.addEntry({
                id: `new-${i}`,
                model: 'file',
                parent: ROOT_ID,
                pathname: `new-${i}.txt`,
            });

            // Remove 1 entry
            cache.removeEntry(`new-${i}`);
        }

        const elapsed = performance.now() - start;

        console.log(`Mixed ops x 1,000 (on 10K entries): ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(4)}ms/cycle)`);
        expect(elapsed).toBeLessThan(500);
    });

    it('should handle tree traversal workload', () => {
        const cache = new PathCache();
        cache.addEntry({ id: ROOT_ID, model: 'folder', parent: null, pathname: '' });

        // Create a tree: 5 levels deep, 10 items per level = 11,111 entries
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
    }, { timeout: TIMEOUT_MEDIUM });
});
