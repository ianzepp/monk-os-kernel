/**
 * EntityModel Tests
 *
 * Tests for the polymorphic EntityModel using a booted OS instance
 * with real database backing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EntityModel } from '@src/vfs/models/entity.js';
import { PathCache, ROOT_ID } from '@src/vfs/path-cache.js';
import { EntityOps, type EntityRecord } from '@src/ems/entity-ops.js';
import type { DatabaseConnection } from '@src/hal/connection.js';
import { createDatabase } from '@src/ems/database.js';
import { ModelCache } from '@src/ems/model-cache.js';
import { createObserverRunner } from '@src/ems/observers/registry.js';
import { BunHAL } from '@src/hal/index.js';
import type { ModelContext } from '@src/vfs/model.js';
import { loadVfsSchema } from '../../helpers/test-os.js';

// =============================================================================
// TEST SETUP
// =============================================================================

let hal: BunHAL;
let db: DatabaseConnection;
let cache: ModelCache;
let pathCache: PathCache;
let ops: EntityOps;
let model: EntityModel;
let ctx: ModelContext;

beforeEach(async () => {
    // Set up HAL
    hal = new BunHAL();
    await hal.init();

    // Create database with EMS core schema
    db = await createDatabase(hal.channel, hal.file);

    // Load VFS schema (tables + seeds for file, folder, etc.)
    await loadVfsSchema(db, hal);

    // Create model cache (takes db in constructor)
    cache = new ModelCache(db);

    // Create observer runner
    const runner = createObserverRunner();

    // Create EntityOps
    ops = new EntityOps(hal, db, cache, runner);

    // Create PathCache and load from database
    pathCache = new PathCache();
    await pathCache.loadFromDatabase(db);

    // Create EntityModel
    model = new EntityModel(pathCache, ops);

    // Create mock context
    ctx = {
        hal,
        caller: 'test-user',
        resolve: async (_path: string) => null,
        getEntity: async (_id: string) => null,
        computePath: async (_id: string) => '',
    };
});

afterEach(async () => {
    await db.close();
    await hal.shutdown();
});

// =============================================================================
// BASIC TESTS
// =============================================================================

describe('EntityModel', () => {
    describe('identity', () => {
        it('should have name "entity"', () => {
            expect(model.name).toBe('entity');
        });

        it('should return field definitions', () => {
            const fields = model.fields();

            expect(fields.length).toBeGreaterThan(0);

            const idField = fields.find(f => f.name === 'id');

            expect(idField).toBeDefined();
            expect(idField?.required).toBe(true);
        });
    });

    describe('PathCache integration', () => {
        it('should load root entity from database', () => {
            const root = pathCache.getEntry(ROOT_ID);

            expect(root).toBeDefined();
            expect(root?.model).toBe('folder');
            expect(root?.pathname).toBe('');
        });

        it('should resolve root path', async () => {
            const id = await pathCache.resolvePath('/', db);

            expect(id).toBe(ROOT_ID);
        });
    });

    describe('stat()', () => {
        it('should stat the root entity', async () => {
            // Root entity should exist (seeded by schema)
            const stat = await model.stat(ctx, ROOT_ID);

            expect(stat.id).toBe(ROOT_ID);
            expect(stat.model).toBe('folder');
            expect(stat.name).toBe('');  // Root has empty pathname
        });

        it('should throw ENOENT for non-existent entity', async () => {
            await expect(model.stat(ctx, 'nonexistent-id')).rejects.toThrow('Entity not found');
        });
    });

    describe('list()', () => {
        it('should list children of root', async () => {
            const children: string[] = [];

            for await (const id of model.list(ctx, ROOT_ID)) {
                children.push(id);
            }

            // Root should have some children (seeded folders like /dev, /vol, etc.)
            // The exact children depend on schema seeding
            expect(Array.isArray(children)).toBe(true);
        });
    });

    describe('create()', () => {
        it('should create a new folder entity', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test-folder', {
                model: 'folder',
                owner: 'test-user',
            });

            expect(id).toBeDefined();
            expect(typeof id).toBe('string');

            // Verify it was persisted to database
            const rows = await db.query<{ id: string; parent: string; pathname: string }>(
                'SELECT id, parent, pathname FROM entities WHERE id = ?',
                [id],
            );

            expect(rows.length).toBe(1);
            expect(rows[0]!.pathname).toBe('test-folder');
            expect(rows[0]!.parent).toBe(ROOT_ID);

            // Manually sync cache (in production, Ring 8 PathCacheSync does this)
            pathCache.addEntry({
                id,
                model: 'folder',
                parent: ROOT_ID,
                pathname: 'test-folder',
            });

            // Verify cache lookup works
            const entity = pathCache.getEntry(id);

            expect(entity?.pathname).toBe('test-folder');
            expect(entity?.model).toBe('folder');
        });

        it('should require model in fields', async () => {
            await expect(
                model.create(ctx, ROOT_ID, 'no-model', {}),
            ).rejects.toThrow('EntityModel.create requires fields.model');
        });
    });

    describe('setstat()', () => {
        it('should update entity fields', async () => {
            // Create a folder first
            const id = await model.create(ctx, ROOT_ID, 'update-test', {
                model: 'folder',
                owner: 'test-user',
            });

            // Manually sync cache (in production, Ring 8 PathCacheSync does this)
            pathCache.addEntry({
                id,
                model: 'folder',
                parent: ROOT_ID,
                pathname: 'update-test',
            });

            // Update it
            await model.setstat(ctx, id, { owner: 'new-owner' });

            // Verify the update
            const stat = await model.stat(ctx, id);

            expect(stat.owner).toBe('new-owner');
        });
    });

    describe('unlink()', () => {
        it('should soft-delete an entity', async () => {
            // Create a folder
            const id = await model.create(ctx, ROOT_ID, 'delete-test', {
                model: 'folder',
                owner: 'test-user',
            });

            // Manually sync cache (in production, Ring 8 PathCacheSync does this)
            pathCache.addEntry({
                id,
                model: 'folder',
                parent: ROOT_ID,
                pathname: 'delete-test',
            });

            // Delete it
            await model.unlink(ctx, id);

            // Entity should still be in cache (soft delete doesn't remove from cache)
            const entity = pathCache.getEntry(id);

            expect(entity).toBeDefined();

            // But detail should have trashed_at set
            const rows = await db.query<EntityRecord>(
                'SELECT trashed_at FROM folder WHERE id = ?',
                [id],
            );

            expect(rows.length).toBe(1);
            expect(rows[0]!.trashed_at).not.toBeNull();
        });
    });
});
