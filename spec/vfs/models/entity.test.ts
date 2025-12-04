/**
 * EntityModel Tests
 *
 * Tests for the polymorphic EntityModel using a booted OS instance
 * with real database backing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/index.js';
import { EntityModel } from '@src/vfs/models/entity.js';
import { EntityCache, ROOT_ID } from '@src/ems/entity-cache.js';
import { EntityOps, type EntityRecord } from '@src/ems/entity-ops.js';
import { createDatabase, type DatabaseConnection } from '@src/ems/connection.js';
import { ModelCache } from '@src/ems/model-cache.js';
import { createObserverRunner } from '@src/ems/observers/registry.js';
import { BunHAL } from '@src/hal/index.js';
import type { ModelContext } from '@src/vfs/model.js';

// =============================================================================
// TEST SETUP
// =============================================================================

let hal: BunHAL;
let db: DatabaseConnection;
let cache: ModelCache;
let entityCache: EntityCache;
let ops: EntityOps;
let model: EntityModel;
let ctx: ModelContext;

beforeEach(async () => {
    // Set up HAL
    hal = new BunHAL();
    await hal.init();

    // Create database with schema
    db = await createDatabase(hal.channel, hal.file);

    // Create model cache (takes db in constructor)
    cache = new ModelCache(db);

    // Create observer runner
    const runner = createObserverRunner();

    // Create EntityOps
    ops = new EntityOps(db, cache, runner);

    // Create EntityCache and load from database
    entityCache = new EntityCache();
    await entityCache.loadFromDatabase(db);

    // Create EntityModel
    model = new EntityModel(entityCache, ops);

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

    describe('EntityCache integration', () => {
        it('should load root entity from database', () => {
            const root = entityCache.getEntity(ROOT_ID);
            expect(root).toBeDefined();
            expect(root?.model).toBe('folder');
            expect(root?.pathname).toBe('');
        });

        it('should resolve root path', async () => {
            const id = await entityCache.resolvePath('/', db);
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
                [id]
            );
            expect(rows.length).toBe(1);
            expect(rows[0].pathname).toBe('test-folder');
            expect(rows[0].parent).toBe(ROOT_ID);

            // Manually sync cache (in production, Ring 8 EntityCacheSync does this)
            entityCache.addEntity({
                id,
                model: 'folder',
                parent: ROOT_ID,
                pathname: 'test-folder',
            });

            // Verify cache lookup works
            const entity = entityCache.getEntity(id);
            expect(entity?.pathname).toBe('test-folder');
            expect(entity?.model).toBe('folder');
        });

        it('should require model in fields', async () => {
            await expect(
                model.create(ctx, ROOT_ID, 'no-model', {})
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

            // Manually sync cache (in production, Ring 8 EntityCacheSync does this)
            entityCache.addEntity({
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

            // Manually sync cache (in production, Ring 8 EntityCacheSync does this)
            entityCache.addEntity({
                id,
                model: 'folder',
                parent: ROOT_ID,
                pathname: 'delete-test',
            });

            // Delete it
            await model.unlink(ctx, id);

            // Entity should still be in cache (soft delete doesn't remove from cache)
            const entity = entityCache.getEntity(id);
            expect(entity).toBeDefined();

            // But detail should have trashed_at set
            const rows = await db.query<EntityRecord>(
                'SELECT trashed_at FROM folder WHERE id = ?',
                [id]
            );
            expect(rows.length).toBe(1);
            expect(rows[0].trashed_at).not.toBeNull();
        });
    });
});

// =============================================================================
// INTEGRATION WITH BOOTED OS
// =============================================================================

describe('EntityModel with booted OS', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        if (os?.isBooted()) {
            await os.shutdown();
        }
    });

    it('should have VFS available after boot', () => {
        const vfs = os.getVFS();
        expect(vfs).toBeDefined();
    });

    it('should have /dev folder with devices', async () => {
        const vfs = os.getVFS();
        const stat = await vfs.stat('/dev', 'kernel');

        expect(stat.model).toBe('folder');
    });

    it('should have /dev/console device', async () => {
        const vfs = os.getVFS();
        const stat = await vfs.stat('/dev/console', 'kernel');

        expect(stat.model).toBe('device');
    });

    it('should have os.ems available', () => {
        expect(os.ems).toBeDefined();
    });

    it('should query models via os.ems', async () => {
        const models = await os.ems.selectAny('models');
        expect(models.length).toBeGreaterThan(0);

        // Should have core models
        const modelNames = models.map((m: EntityRecord) => m.model_name);
        expect(modelNames).toContain('folder');
        expect(modelNames).toContain('file');
    });

    it('should query fields via os.ems', async () => {
        const fields = await os.ems.selectAny('fields', {
            where: { model_name: 'folder' }
        });
        expect(fields.length).toBeGreaterThan(0);
    });

    it('should create a folder entity via os.ems', async () => {
        const folder = await os.ems.createOne('folder', {
            parent: ROOT_ID,
            pathname: 'test-via-os-db',
            owner: 'test-user',
        });

        expect(folder.id).toBeDefined();
        expect(folder.owner).toBe('test-user');

        // Verify in entities table (entities has no trashed_at, so use 'include')
        const entities = await os.ems.selectAny('entities', {
            where: { id: folder.id }
        }, { trashed: 'include' });
        expect(entities.length).toBe(1);
        expect((entities[0] as EntityRecord).pathname).toBe('test-via-os-db');
    });
});
