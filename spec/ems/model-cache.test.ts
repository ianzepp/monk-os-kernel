/**
 * ModelCache Tests
 *
 * Tests for the ModelCache class which provides async model metadata caching
 * with HAL-based database access.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunHAL } from '@src/hal/index.js';
import { createDatabase, type DatabaseConnection } from '@src/ems/connection.js';
import { ModelCache } from '@src/ems/model-cache.js';
import { ENOENT } from '@src/hal/errors.js';
import { loadVfsSchema } from '../helpers/test-os.js';

// =============================================================================
// TEST SETUP
// =============================================================================

describe('ModelCache', () => {
    let hal: BunHAL;
    let db: DatabaseConnection;
    let cache: ModelCache;

    beforeEach(async () => {
        hal = new BunHAL();
        await hal.init();
        db = await createDatabase(hal.channel, hal.file);
        await loadVfsSchema(db, hal);
        cache = new ModelCache(db);
    });

    afterEach(async () => {
        await db.close();
        await hal.shutdown();
    });

    // =========================================================================
    // CONSTRUCTOR TESTS
    // =========================================================================

    describe('constructor', () => {
        it('should create instance with empty cache', () => {
            expect(cache.cacheSize).toBe(0);
            expect(cache.pendingSize).toBe(0);
        });
    });

    // =========================================================================
    // GET TESTS
    // =========================================================================

    describe('get', () => {
        it('should load and cache model', async () => {
            // First load
            const model1 = await cache.get('file');

            expect(model1).toBeDefined();
            expect(model1?.modelName).toBe('file');
            expect(cache.isCached('file')).toBe(true);
            expect(cache.cacheSize).toBe(1);

            // Second load should return cached
            const model2 = await cache.get('file');

            expect(model2).toBe(model1); // Same instance
        });

        it('should return undefined for non-existent model', async () => {
            const model = await cache.get('nonexistent_model');

            expect(model).toBeUndefined();
            expect(cache.isCached('nonexistent_model')).toBe(false);
        });

        it('should load model with fields', async () => {
            const model = await cache.get('file');

            expect(model).toBeDefined();
            // File model has: owner, size, mimetype, checksum (pathname is in entities table)
            expect(model!.hasField('owner')).toBe(true);
            expect(model!.hasField('size')).toBe(true);
        });
    });

    // =========================================================================
    // REQUIRE TESTS
    // =========================================================================

    describe('require', () => {
        it('should return model if exists', async () => {
            const model = await cache.require('file');

            expect(model).toBeDefined();
            expect(model.modelName).toBe('file');
        });

        it('should throw ENOENT for non-existent model', async () => {
            await expect(cache.require('nonexistent')).rejects.toThrow(ENOENT);
        });

        it('should use custom error message if provided', async () => {
            try {
                await cache.require('nonexistent', 'Custom error message');
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect((err as ENOENT).message).toBe('Custom error message');
            }
        });

        it('should use default error message if not provided', async () => {
            try {
                await cache.require('nonexistent');
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect((err as ENOENT).message).toContain('nonexistent');
                expect((err as ENOENT).message).toContain('not found');
            }
        });
    });

    // =========================================================================
    // HAS TESTS
    // =========================================================================

    describe('has', () => {
        it('should return true for existing model', async () => {
            expect(await cache.has('file')).toBe(true);
        });

        it('should return false for non-existent model', async () => {
            expect(await cache.has('nonexistent')).toBe(false);
        });

        it('should cache model on check', async () => {
            expect(cache.isCached('folder')).toBe(false);

            await cache.has('folder');

            expect(cache.isCached('folder')).toBe(true);
        });
    });

    // =========================================================================
    // INVALIDATION TESTS
    // =========================================================================

    describe('invalidate', () => {
        it('should remove model from cache', async () => {
            // Load into cache
            await cache.get('file');

            expect(cache.isCached('file')).toBe(true);

            // Invalidate
            cache.invalidate('file');

            expect(cache.isCached('file')).toBe(false);
            expect(cache.cacheSize).toBe(0);
        });

        it('should be safe to invalidate non-cached model', () => {
            cache.invalidate('nonexistent');

            expect(cache.isCached('nonexistent')).toBe(false);
        });

        it('should force reload on next get', async () => {
            const model1 = await cache.get('file');

            cache.invalidate('file');

            const model2 = await cache.get('file');

            // Should be a new instance (reloaded from database)
            expect(model2).toBeDefined();
            expect(model2).not.toBe(model1);
        });
    });

    describe('clear', () => {
        it('should remove all cached models', async () => {
            // Load multiple models
            await cache.get('file');
            await cache.get('folder');

            expect(cache.cacheSize).toBe(2);

            // Clear all
            cache.clear();

            expect(cache.cacheSize).toBe(0);
            expect(cache.isCached('file')).toBe(false);
            expect(cache.isCached('folder')).toBe(false);
        });
    });

    // =========================================================================
    // PRELOAD TESTS
    // =========================================================================

    describe('preload', () => {
        it('should preload multiple models', async () => {
            expect(cache.cacheSize).toBe(0);

            await cache.preload(['file', 'folder']);

            expect(cache.cacheSize).toBe(2);
            expect(cache.isCached('file')).toBe(true);
            expect(cache.isCached('folder')).toBe(true);
        });

        it('should handle non-existent models in list', async () => {
            await cache.preload(['file', 'nonexistent', 'folder']);

            // Existing models should be cached
            expect(cache.isCached('file')).toBe(true);
            expect(cache.isCached('folder')).toBe(true);

            // Non-existent should not be cached
            expect(cache.isCached('nonexistent')).toBe(false);
        });

        it('should handle empty array', async () => {
            await cache.preload([]);

            expect(cache.cacheSize).toBe(0);
        });
    });

    describe('preloadSystemModels', () => {
        it('should preload meta-models', async () => {
            await cache.preloadSystemModels();

            // Meta-models only - VFS models load on-demand after VFS.init()
            expect(cache.isCached('models')).toBe(true);
            expect(cache.isCached('fields')).toBe(true);
            expect(cache.isCached('tracked')).toBe(true);

            // VFS models are NOT preloaded (they load after VFS.init())
            expect(cache.isCached('file')).toBe(false);
            expect(cache.isCached('folder')).toBe(false);
        });
    });

    // =========================================================================
    // CONCURRENT ACCESS TESTS
    // =========================================================================

    describe('concurrent access', () => {
        it('should dedupe concurrent requests for same model', async () => {
            // Start multiple concurrent requests
            const promises = [
                cache.get('file'),
                cache.get('file'),
                cache.get('file'),
            ];

            const results = await Promise.all(promises);

            // All should return the same instance
            expect(results[0]).toBe(results[1]);
            expect(results[1]).toBe(results[2]);

            // Only one should be in cache
            expect(cache.cacheSize).toBe(1);
        });

        it('should handle concurrent requests for different models', async () => {
            const promises = [
                cache.get('file'),
                cache.get('folder'),
                cache.get('models'),
            ];

            const results = await Promise.all(promises);

            expect(results[0]?.modelName).toBe('file');
            expect(results[1]?.modelName).toBe('folder');
            expect(results[2]?.modelName).toBe('models');
            expect(cache.cacheSize).toBe(3);
        });
    });

    // =========================================================================
    // PUBLIC ACCESSOR TESTS
    // =========================================================================

    describe('cacheSize', () => {
        it('should reflect number of cached models', async () => {
            expect(cache.cacheSize).toBe(0);

            await cache.get('file');

            expect(cache.cacheSize).toBe(1);

            await cache.get('folder');

            expect(cache.cacheSize).toBe(2);
        });
    });

    describe('pendingSize', () => {
        it('should be 0 when no requests in flight', () => {
            expect(cache.pendingSize).toBe(0);
        });
    });

    describe('isCached', () => {
        it('should return true only for cached models', async () => {
            expect(cache.isCached('file')).toBe(false);

            await cache.get('file');

            expect(cache.isCached('file')).toBe(true);
            expect(cache.isCached('folder')).toBe(false);
        });
    });

    describe('getCachedModelNames', () => {
        it('should return names of cached models', async () => {
            expect(cache.getCachedModelNames()).toEqual([]);

            await cache.get('file');
            await cache.get('folder');

            const names = cache.getCachedModelNames();

            expect(names).toHaveLength(2);
            expect(names).toContain('file');
            expect(names).toContain('folder');
        });
    });

    // =========================================================================
    // EDGE CASES - STUPID USER TESTS
    // =========================================================================

    describe('edge cases - invalid model names', () => {
        it('should handle empty string model name', async () => {
            const model = await cache.get('');

            expect(model).toBeUndefined();
        });

        it('should handle whitespace-only model name', async () => {
            const model = await cache.get('   ');

            expect(model).toBeUndefined();
        });

        it('should handle model name with leading/trailing whitespace', async () => {
            // ' file ' is different from 'file'
            const model = await cache.get(' file ');

            expect(model).toBeUndefined();
        });

        it('should handle model name with special characters', async () => {
            const model = await cache.get('model<script>alert("xss")</script>');

            expect(model).toBeUndefined();
        });

        it('should handle model name with SQL injection attempt', async () => {
            // Should not cause SQL error, just return undefined
            const model = await cache.get("'; DROP TABLE models; --");

            expect(model).toBeUndefined();
        });

        it('should handle model name with unicode', async () => {
            const model = await cache.get('文件');

            expect(model).toBeUndefined();
        });

        it('should handle model name with emoji', async () => {
            const model = await cache.get('📁');

            expect(model).toBeUndefined();
        });

        it('should handle very long model name', async () => {
            const longName = 'a'.repeat(10000);
            const model = await cache.get(longName);

            expect(model).toBeUndefined();
        });

        it('should handle model name with null bytes', async () => {
            const model = await cache.get('file\x00evil');

            expect(model).toBeUndefined();
        });

        it('should handle model name with newlines', async () => {
            const model = await cache.get('file\ninjection');

            expect(model).toBeUndefined();
        });
    });

    describe('edge cases - require error handling', () => {
        it('should throw ENOENT with empty string', async () => {
            await expect(cache.require('')).rejects.toThrow(ENOENT);
        });

        it('should throw ENOENT with whitespace', async () => {
            await expect(cache.require('   ')).rejects.toThrow(ENOENT);
        });

        it('should have correct error code', async () => {
            try {
                await cache.require('nonexistent_model_xyz');
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(ENOENT);
                expect((err as ENOENT).code).toBe('ENOENT');
            }
        });
    });

    describe('edge cases - invalidation patterns', () => {
        it('should handle invalidate on never-loaded model', () => {
            // Should not throw
            cache.invalidate('never_loaded');

            expect(cache.isCached('never_loaded')).toBe(false);
        });

        it('should handle multiple invalidations of same model', async () => {
            await cache.get('file');

            cache.invalidate('file');
            cache.invalidate('file');
            cache.invalidate('file');

            expect(cache.isCached('file')).toBe(false);
        });

        it('should handle invalidate with empty string', () => {
            cache.invalidate('');

            // Should not throw, just do nothing
            expect(cache.cacheSize).toBe(0);
        });

        it('should handle clear on empty cache', () => {
            // Should not throw
            cache.clear();

            expect(cache.cacheSize).toBe(0);
        });

        it('should handle clear followed by clear', () => {
            cache.clear();
            cache.clear();

            expect(cache.cacheSize).toBe(0);
        });

        it('should allow reload after invalidate', async () => {
            const model1 = await cache.get('file');

            cache.invalidate('file');

            expect(cache.isCached('file')).toBe(false);

            const model2 = await cache.get('file');

            expect(model2).toBeDefined();
            expect(model2).not.toBe(model1); // New instance
        });
    });

    describe('edge cases - preload patterns', () => {
        it('should handle preload with duplicate names', async () => {
            await cache.preload(['file', 'file', 'file']);

            expect(cache.cacheSize).toBe(1);
        });

        it('should handle preload with mixed valid/invalid', async () => {
            await cache.preload(['file', '', 'nonexistent', 'folder', '   ']);

            expect(cache.isCached('file')).toBe(true);
            expect(cache.isCached('folder')).toBe(true);
            expect(cache.cacheSize).toBe(2);
        });

        it('should handle preload of already cached models', async () => {
            await cache.get('file');
            const originalModel = await cache.get('file');

            await cache.preload(['file', 'folder']);

            // Should not replace already cached model
            const afterPreload = await cache.get('file');

            expect(afterPreload).toBe(originalModel);
        });

        it('should handle multiple consecutive preloads', async () => {
            await cache.preload(['file']);
            await cache.preload(['folder']);
            await cache.preload(['models']);

            expect(cache.cacheSize).toBe(3);
        });
    });

    describe('edge cases - concurrent edge cases', () => {
        it('should handle get during preload of same model', async () => {
            // Start preload (includes file)
            const preloadPromise = cache.preload(['file', 'folder', 'models']);

            // Concurrently get file
            const getPromise = cache.get('file');

            const [, model] = await Promise.all([preloadPromise, getPromise]);

            expect(model).toBeDefined();
            expect(cache.cacheSize).toBe(3);
        });

        it('should handle invalidate during load', async () => {
            // Start loading
            const loadPromise = cache.get('file');

            // Invalidate before load completes (race condition)
            cache.invalidate('file');

            const model = await loadPromise;

            // Model should still be returned from the in-flight request
            expect(model).toBeDefined();
        });

        it('should handle massive concurrent requests', async () => {
            const promises: Promise<unknown>[] = [];

            // 100 concurrent requests for same model
            for (let i = 0; i < 100; i++) {
                promises.push(cache.get('file'));
            }

            const results = await Promise.all(promises);

            // All should return same instance
            const firstResult = results[0];

            for (const result of results) {
                expect(result).toBe(firstResult);
            }

            expect(cache.cacheSize).toBe(1);
        });
    });

    describe('edge cases - cache state consistency', () => {
        it('should maintain consistency after many operations', async () => {
            // Load
            await cache.get('file');
            await cache.get('folder');

            expect(cache.cacheSize).toBe(2);

            // Invalidate one
            cache.invalidate('file');

            expect(cache.cacheSize).toBe(1);
            expect(cache.isCached('folder')).toBe(true);

            // Reload
            await cache.get('file');

            expect(cache.cacheSize).toBe(2);

            // Clear
            cache.clear();

            expect(cache.cacheSize).toBe(0);

            // Reload both
            await cache.preload(['file', 'folder']);

            expect(cache.cacheSize).toBe(2);
        });

        it('should return fresh arrays from getCachedModelNames', async () => {
            await cache.get('file');

            const names1 = cache.getCachedModelNames();
            const names2 = cache.getCachedModelNames();

            expect(names1).not.toBe(names2);
            expect(names1).toEqual(names2);

            // Modifying returned array should not affect cache
            names1.push('hacked');

            const names3 = cache.getCachedModelNames();

            expect(names3).not.toContain('hacked');
        });
    });

    describe('edge cases - has() behavior', () => {
        it('should cache model when checking with has()', async () => {
            expect(cache.isCached('file')).toBe(false);

            const exists = await cache.has('file');

            expect(exists).toBe(true);
            expect(cache.isCached('file')).toBe(true); // Now cached
        });

        it('should not cache non-existent model when checking with has()', async () => {
            const exists = await cache.has('nonexistent');

            expect(exists).toBe(false);
            expect(cache.isCached('nonexistent')).toBe(false);
        });
    });
});
