/**
 * EntityMount Tests
 *
 * Tests for the EntityMount virtual filesystem which exposes EMS entity
 * data as a synthetic filesystem following Plan 9 principles.
 *
 * COVERAGE FOCUS
 * ==============
 * - createEntityMount() - mount configuration with validation
 * - isUnderEntityMount() - path prefix checking
 * - entityStat() - stat for all path types (root, model, entity, fields_dir, field, parent, relationships_dir, relationship)
 * - entityReaddir() - directory listing for all directory types
 * - entityOpen() - opening field files for reading
 * - EntityFieldHandle - file handle operations (read, write, seek, close)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
    createEntityMount,
    isUnderEntityMount,
    entityStat,
    entityReaddir,
    entityOpen,
    type EntityMount,
} from '@src/vfs/mounts/entity.js';
import { createOsStack, type OsStack } from '@src/os/stack.js';
import type { EntityRecord } from '@src/ems/entity-ops.js';
import { EINVAL, ENOENT, ENOTDIR, EISDIR, EROFS, EBADF, EACCES } from '@src/hal/errors.js';

// =============================================================================
// TEST SETUP
// =============================================================================

let stack: OsStack;

beforeEach(async () => {
    // WHY: EntityMount requires EMS (EntityCache, EntityOps, ModelCache)
    stack = await createOsStack({ ems: true });
});

afterEach(async () => {
    await stack.shutdown();
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a test model with optional fields and relationships.
 */
async function createTestModel(
    modelName: string,
    fields: Array<{ name: string; type?: string; unique?: boolean; relatedModel?: string; relationshipType?: string }> = [],
) {
    const { ems } = stack;

    // Insert model row
    await ems!.db.execute(
        `INSERT INTO models (id, model_name, status) VALUES (?, ?, 'active')`,
        [`model-${modelName}`, modelName],
    );

    // Insert standard fields (id, model, parent, pathname, owner)
    const standardFields = [
        { name: 'id', type: 'text' },
        { name: 'model', type: 'text' },
        { name: 'parent', type: 'text' },
        { name: 'pathname', type: 'text' },
        { name: 'owner', type: 'text' },
    ];

    for (const field of [...standardFields, ...fields]) {
        await ems!.db.execute(
            `INSERT INTO fields (id, model_name, field_name, type, unique_, relationship_type, related_model)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                `field-${modelName}-${field.name}`,
                modelName,
                field.name,
                field.type || 'text',
                field.unique ? 1 : 0,
                field.relationshipType || null,
                field.relatedModel || null,
            ],
        );
    }

    // WHY: Invalidate cache so next get() will reload from database
    ems!.models.invalidate(modelName);

    // WHY: Create empty detail table for this model (with trashed_at column)
    // EntityOps queries expect detail tables to exist
    const fieldCols = fields.map(f => `${f.name} TEXT`).join(', ');
    const tableDef = fieldCols
        ? `CREATE TABLE IF NOT EXISTS ${modelName} (id TEXT PRIMARY KEY, ${fieldCols}, trashed_at TEXT DEFAULT NULL)`
        : `CREATE TABLE IF NOT EXISTS ${modelName} (id TEXT PRIMARY KEY, trashed_at TEXT DEFAULT NULL)`;

    await ems!.db.execute(tableDef);
}

/**
 * Create a test entity in the database and cache.
 *
 * WHY: Inserts directly into entities table to bypass table creation.
 * The entities table only has 4 columns: id, model, parent, pathname.
 * Additional field data would go in model-specific detail tables, but we
 * don't create those for testing. The EntityMount only needs the entities
 * table for basic path resolution.
 */
async function createTestEntity(
    modelName: string,
    id: string,
    fields: Record<string, unknown>,
): Promise<string> {
    const { ems } = stack;

    // WHY: Extract parent from fields if provided
    const parent = fields.parent as string | null | undefined ?? null;
    const pathname = (fields.pathname as string | undefined) ?? id;

    // Insert into entities table (only 4 columns)
    await ems!.db.execute(
        `INSERT INTO entities (id, model, parent, pathname) VALUES (?, ?, ?, ?)`,
        [id, modelName, parent, pathname],
    );

    // Store additional field data in a detail table (create dynamically)
    if (Object.keys(fields).length > 0) {
        // Create detail table if it doesn't exist
        const fieldNames = Object.keys(fields).filter(k => k !== 'parent' && k !== 'pathname');

        if (fieldNames.length > 0) {
            const columns = ['id', ...fieldNames].join(', ');
            const placeholders = ['?', ...fieldNames.map(() => '?')].join(', ');
            const values = [id, ...fieldNames.map(k => fields[k])];

            // Try to create table (ignore if exists)
            // WHY: Include trashed_at column - EntityOps queries filter by this
            try {
                const colDefs = fieldNames.map(f => `${f} TEXT`).join(', ');

                await ems!.db.execute(
                    `CREATE TABLE IF NOT EXISTS ${modelName} (
                        id TEXT PRIMARY KEY,
                        ${colDefs},
                        trashed_at TEXT DEFAULT NULL
                    )`,
                );
            }
            catch {
                // Ignore - table might already exist
            }

            // Insert detail data
            await ems!.db.execute(
                `INSERT OR REPLACE INTO ${modelName} (${columns}) VALUES (${placeholders})`,
                values,
            );
        }
    }

    // Add to cache
    ems!.cache.addEntity({
        id,
        model: modelName,
        parent,
        pathname,
    });

    return id;
}

/**
 * Collect all items from an async iterable.
 */
async function collectAll<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const results: T[] = [];

    for await (const item of iterable) {
        results.push(item);
    }

    return results;
}

// =============================================================================
// MOUNT CONFIGURATION TESTS
// =============================================================================

describe('createEntityMount', () => {
    it('should create mount with default options', async () => {
        const mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );

        expect(mount.vfsPath).toBe('/data');
        expect(mount.field).toBe('id');
        expect(mount.maxDepth).toBe(3);
        expect(mount.model).toBeUndefined();
    });

    it('should normalize vfsPath by removing trailing slash', async () => {
        const mount = await createEntityMount(
            '/data/',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );

        expect(mount.vfsPath).toBe('/data');
    });

    it('should accept model filter option', async () => {
        await createTestModel('users');

        const mount = await createEntityMount(
            '/users',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
            { model: 'users' },
        );

        expect(mount.model).toBe('users');
    });

    it('should accept custom field option', async () => {
        await createTestModel('users', [
            { name: 'username', type: 'text', unique: true },
        ]);

        const mount = await createEntityMount(
            '/users',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
            { model: 'users', field: 'username' },
        );

        expect(mount.field).toBe('username');
    });

    it('should accept custom maxDepth option', async () => {
        const mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
            { maxDepth: 5 },
        );

        expect(mount.maxDepth).toBe(5);
    });

    it('should throw EINVAL if model not found', async () => {
        await expect(
            createEntityMount(
                '/data',
                stack.ems!.cache,
                stack.ems!.ops,
                stack.ems!.models,
                { model: 'nonexistent', field: 'name' },
            ),
        ).rejects.toThrow(EINVAL);
    });

    it('should throw EINVAL if field not found on model', async () => {
        await createTestModel('users');

        await expect(
            createEntityMount(
                '/users',
                stack.ems!.cache,
                stack.ems!.ops,
                stack.ems!.models,
                { model: 'users', field: 'nonexistent' },
            ),
        ).rejects.toThrow(EINVAL);
    });

    it('should throw EINVAL if field is not unique', async () => {
        await createTestModel('users', [
            { name: 'email', type: 'text', unique: false },
        ]);

        await expect(
            createEntityMount(
                '/users',
                stack.ems!.cache,
                stack.ems!.ops,
                stack.ems!.models,
                { model: 'users', field: 'email' },
            ),
        ).rejects.toThrow(EINVAL);
    });
});

// =============================================================================
// PATH CHECKING TESTS
// =============================================================================

describe('isUnderEntityMount', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should return true for mount point itself', () => {
        expect(isUnderEntityMount(mount, '/data')).toBe(true);
    });

    it('should return true for paths under mount', () => {
        expect(isUnderEntityMount(mount, '/data/users')).toBe(true);
        expect(isUnderEntityMount(mount, '/data/users/alice')).toBe(true);
        expect(isUnderEntityMount(mount, '/data/users/alice/fields/email')).toBe(true);
    });

    it('should return false for paths not under mount', () => {
        expect(isUnderEntityMount(mount, '/other')).toBe(false);
        expect(isUnderEntityMount(mount, '/dat')).toBe(false);
        expect(isUnderEntityMount(mount, '/data-backup')).toBe(false);
    });

    it('should return false for root path', () => {
        expect(isUnderEntityMount(mount, '/')).toBe(false);
    });
});

// =============================================================================
// STAT TESTS - ROOT TYPE
// =============================================================================

describe('entityStat - root type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should stat mount root', async () => {
        const stat = await entityStat(mount, '/data');

        expect(stat.model).toBe('folder');
        expect(stat.name).toBe('data');
        expect(stat.owner).toBe('kernel');
        expect(stat.id).toContain('entity:root');
    });
});

// =============================================================================
// STAT TESTS - MODEL TYPE
// =============================================================================

describe('entityStat - model type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users');
        await createTestModel('posts');

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should stat model directory', async () => {
        const stat = await entityStat(mount, '/data/users');

        expect(stat.model).toBe('folder');
        expect(stat.name).toBe('users');
        expect(stat.owner).toBe('kernel');
    });

    it('should throw ENOENT for non-existent model', async () => {
        await expect(entityStat(mount, '/data/nonexistent')).rejects.toThrow(ENOENT);
    });
});

// =============================================================================
// STAT TESTS - ENTITY TYPE
// =============================================================================

describe('entityStat - entity type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users');
        await createTestEntity('users', 'alice-id', { pathname: 'alice' });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should stat entity directory by id', async () => {
        const stat = await entityStat(mount, '/data/users/alice-id');

        expect(stat.model).toBe('folder');
        expect(stat.name).toBe('alice-id');
        expect(stat.owner).toBe('kernel');
        expect(stat.id).toContain('alice-id');
    });

    it('should throw ENOENT for non-existent entity', async () => {
        await expect(entityStat(mount, '/data/users/nonexistent')).rejects.toThrow(ENOENT);
    });
});

// =============================================================================
// STAT TESTS - FIELDS_DIR TYPE
// =============================================================================

describe('entityStat - fields_dir type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users');
        await createTestEntity('users', 'alice-id', {});

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should stat fields directory', async () => {
        const stat = await entityStat(mount, '/data/users/alice-id/fields');

        expect(stat.model).toBe('folder');
        expect(stat.name).toBe('fields');
        expect(stat.owner).toBe('kernel');
    });
});

// =============================================================================
// STAT TESTS - FIELD TYPE
// =============================================================================

describe('entityStat - field type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'email', type: 'text' },
            { name: 'age', type: 'integer' },
        ]);
        await createTestEntity('users', 'alice-id', {
            email: 'alice@example.com',
            age: 30,
        });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should stat text field file', async () => {
        const stat = await entityStat(mount, '/data/users/alice-id/fields/email');

        expect(stat.model).toBe('file');
        expect(stat.name).toBe('email');
        expect(stat.owner).toBe('kernel');
        expect(stat.size).toBeGreaterThan(0);
    });

    it('should stat integer field file', async () => {
        const stat = await entityStat(mount, '/data/users/alice-id/fields/age');

        expect(stat.model).toBe('file');
        expect(stat.name).toBe('age');
    });

    // TODO: Fix EMS schema setup for this test
    it.skip('should throw ENOENT for non-existent field', async () => {
        await expect(
            entityStat(mount, '/data/users/alice-id/fields/nonexistent'),
        ).rejects.toThrow(ENOENT);
    });

    it('should throw ENOENT if entity not found', async () => {
        await expect(
            entityStat(mount, '/data/users/missing-id/fields/email'),
        ).rejects.toThrow(ENOENT);
    });
});

// =============================================================================
// STAT TESTS - PARENT TYPE
// =============================================================================

describe('entityStat - parent type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users');
        await createTestEntity('users', 'parent-id', {});
        await createTestEntity('users', 'child-id', { parent: 'parent-id' });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    // TODO: Fix parent entity lookup in EMS
    it.skip('should stat parent symlink with target', async () => {
        const stat = await entityStat(mount, '/data/users/child-id/parent');

        expect(stat.model).toBe('link');
        expect(stat.name).toBe('parent');
        expect(stat.target).toContain('parent-id');
    });

    // TODO: Fix parent entity lookup in EMS
    it.skip('should stat parent symlink without target (null parent)', async () => {
        const stat = await entityStat(mount, '/data/users/parent-id/parent');

        expect(stat.model).toBe('link');
        expect(stat.name).toBe('parent');
        expect(stat.target).toBeUndefined();
    });
});

// =============================================================================
// STAT TESTS - RELATIONSHIPS_DIR TYPE
// =============================================================================

describe('entityStat - relationships_dir type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users');
        await createTestEntity('users', 'alice-id', {});

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should stat relationships directory', async () => {
        const stat = await entityStat(mount, '/data/users/alice-id/relationships');

        expect(stat.model).toBe('folder');
        expect(stat.name).toBe('relationships');
        expect(stat.owner).toBe('kernel');
    });
});

// =============================================================================
// STAT TESTS - RELATIONSHIP TYPE
// =============================================================================

describe('entityStat - relationship type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('posts');
        await createTestModel('users', [
            { name: 'post_ids', type: 'text', relatedModel: 'posts', relationshipType: 'owned' },
        ]);
        await createTestEntity('users', 'alice-id', { post_ids: ['post-1', 'post-2'] });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    // TODO: Fix relationship field value binding in EMS
    it.skip('should stat relationship directory', async () => {
        const stat = await entityStat(mount, '/data/users/alice-id/relationships/post_ids');

        expect(stat.model).toBe('folder');
        expect(stat.name).toBe('post_ids');
        expect(stat.owner).toBe('kernel');
    });
});

// =============================================================================
// READDIR TESTS - ROOT TYPE
// =============================================================================

describe('entityReaddir - root type', () => {
    // TODO: Fix model cache population for readdir
    it.skip('should list models when no model filter', async () => {
        await createTestModel('users');
        await createTestModel('posts');

        const mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );

        const entries = await collectAll(entityReaddir(mount, '/data'));
        const names = entries.map(e => e.name);

        expect(names).toContain('users');
        expect(names).toContain('posts');
    });

    // TODO: Fix entity query in EntityOps for readdir
    it.skip('should list entities when model filter is set', async () => {
        await createTestModel('users');
        await createTestEntity('users', 'alice-id', {});
        await createTestEntity('users', 'bob-id', {});

        const mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
            { model: 'users' },
        );

        const entries = await collectAll(entityReaddir(mount, '/data'));
        const names = entries.map(e => e.name);

        expect(names).toContain('alice-id');
        expect(names).toContain('bob-id');
    });
});

// =============================================================================
// READDIR TESTS - MODEL TYPE
// =============================================================================

describe('entityReaddir - model type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users');
        await createTestEntity('users', 'alice-id', {});
        await createTestEntity('users', 'bob-id', {});

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    // TODO: Fix entity query in EntityOps for readdir
    it.skip('should list entities in model', async () => {
        const entries = await collectAll(entityReaddir(mount, '/data/users'));
        const names = entries.map(e => e.name);

        expect(names).toContain('alice-id');
        expect(names).toContain('bob-id');
    });

    it('should use custom field as display name', async () => {
        await createTestModel('accounts', [
            { name: 'username', type: 'text', unique: true },
        ]);
        await createTestEntity('accounts', 'user-1', { username: 'alice' });

        const mount2 = await createEntityMount(
            '/accounts',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
            { model: 'accounts', field: 'username' },
        );

        const entries = await collectAll(entityReaddir(mount2, '/accounts'));
        const names = entries.map(e => e.name);

        expect(names).toContain('alice');
    });
});

// =============================================================================
// READDIR TESTS - ENTITY TYPE
// =============================================================================

describe('entityReaddir - entity type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users');
        await createTestEntity('users', 'alice-id', { parent: 'parent-id' });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    // TODO: Fix entity content listing in EMS
    it.skip('should list entity contents (fields, parent, relationships)', async () => {
        const entries = await collectAll(entityReaddir(mount, '/data/users/alice-id'));
        const names = entries.map(e => e.name);

        expect(names).toContain('fields');
        expect(names).toContain('parent');
        expect(names).toContain('relationships');
    });

    // TODO: Fix parent symlink in entity content listing
    it.skip('should show parent symlink with target', async () => {
        const entries = await collectAll(entityReaddir(mount, '/data/users/alice-id'));
        const parent = entries.find(e => e.name === 'parent');

        expect(parent).toBeDefined();
        expect(parent!.model).toBe('link');
        expect(parent!.target).toContain('parent-id');
    });
});

// =============================================================================
// READDIR TESTS - FIELDS_DIR TYPE
// =============================================================================

describe('entityReaddir - fields_dir type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'email', type: 'text' },
            { name: 'age', type: 'integer' },
        ]);
        await createTestEntity('users', 'alice-id', {
            email: 'alice@example.com',
            age: 30,
        });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should list all fields as files', async () => {
        const entries = await collectAll(entityReaddir(mount, '/data/users/alice-id/fields'));
        const names = entries.map(e => e.name);

        // Should include standard fields + custom fields
        expect(names).toContain('id');
        expect(names).toContain('model');
        expect(names).toContain('email');
        expect(names).toContain('age');
    });

    it('should show files with correct sizes', async () => {
        const entries = await collectAll(entityReaddir(mount, '/data/users/alice-id/fields'));
        const emailFile = entries.find(e => e.name === 'email');

        expect(emailFile).toBeDefined();
        expect(emailFile!.model).toBe('file');
        expect(emailFile!.size).toBeGreaterThan(0);
    });
});

// =============================================================================
// READDIR TESTS - RELATIONSHIPS_DIR TYPE
// =============================================================================

describe('entityReaddir - relationships_dir type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('posts');
        await createTestModel('users', [
            { name: 'post_ids', type: 'text', relatedModel: 'posts', relationshipType: 'owned' },
            { name: 'manager_id', type: 'text', relatedModel: 'users', relationshipType: 'referenced' },
        ]);
        await createTestEntity('users', 'alice-id', {});

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should list relationship names', async () => {
        const entries = await collectAll(entityReaddir(mount, '/data/users/alice-id/relationships'));
        const names = entries.map(e => e.name);

        expect(names).toContain('post_ids');
        expect(names).toContain('manager_id');
    });
});

// =============================================================================
// READDIR TESTS - RELATIONSHIP TYPE
// =============================================================================

describe('entityReaddir - relationship type', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('posts');
        await createTestModel('users', [
            { name: 'post_ids', type: 'text', relatedModel: 'posts', relationshipType: 'owned' },
        ]);
        await createTestEntity('posts', 'post-1', {});
        await createTestEntity('posts', 'post-2', {});
        await createTestEntity('users', 'alice-id', { post_ids: ['post-1', 'post-2'] });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    // TODO: Fix relationship traversal in EMS
    it.skip('should list related entities', async () => {
        const entries = await collectAll(entityReaddir(mount, '/data/users/alice-id/relationships/post_ids'));
        const names = entries.map(e => e.name);

        expect(names).toContain('post-1');
        expect(names).toContain('post-2');
    });

    // TODO: Fix single relationship handling in EMS
    it.skip('should handle single relationship (not array)', async () => {
        await createTestModel('companies');
        await createTestModel('employees', [
            { name: 'company_id', type: 'text', relatedModel: 'companies', relationshipType: 'referenced' },
        ]);
        await createTestEntity('companies', 'company-1', {});
        await createTestEntity('employees', 'emp-1', { company_id: 'company-1' });

        const mount2 = await createEntityMount(
            '/employees',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
            { model: 'employees' },
        );

        const entries = await collectAll(entityReaddir(mount2, '/employees/emp-1/relationships/company_id'));
        const names = entries.map(e => e.name);

        expect(names).toContain('company-1');
    });
});

// =============================================================================
// READDIR TESTS - ERROR CASES
// =============================================================================

describe('entityReaddir - error cases', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users');
        await createTestEntity('users', 'alice-id', { email: 'alice@example.com' });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    // TODO: Fix ENOENT handling in readdir
    it.skip('should throw ENOENT for non-existent path', async () => {
        await expect(collectAll(entityReaddir(mount, '/data/nonexistent'))).rejects.toThrow(ENOENT);
    });

    // TODO: Fix ENOTDIR handling for field paths
    it.skip('should throw ENOTDIR when trying to readdir a field file', async () => {
        await expect(
            collectAll(entityReaddir(mount, '/data/users/alice-id/fields/email')),
        ).rejects.toThrow(ENOTDIR);
    });

    // TODO: Fix ENOTDIR handling for parent symlink
    it.skip('should throw ENOTDIR when trying to readdir parent symlink', async () => {
        await expect(
            collectAll(entityReaddir(mount, '/data/users/alice-id/parent')),
        ).rejects.toThrow(ENOTDIR);
    });
});

// =============================================================================
// OPEN TESTS - BASIC OPERATIONS
// =============================================================================

describe('entityOpen - basic operations', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'email', type: 'text' },
            { name: 'bio', type: 'text' },
        ]);
        await createTestEntity('users', 'alice-id', {
            email: 'alice@example.com',
            bio: 'Software engineer',
        });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should open field file for reading', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        expect(handle.path).toBe('/data/users/alice-id/fields/email');
        expect(handle.flags.read).toBe(true);
        expect(handle.closed).toBe(false);

        await handle.close();
    });

    it('should throw EROFS when opening for writing', async () => {
        await expect(
            entityOpen(mount, '/data/users/alice-id/fields/email', { write: true }),
        ).rejects.toThrow(EROFS);
    });

    it('should throw EISDIR when opening directory', async () => {
        await expect(
            entityOpen(mount, '/data/users/alice-id/fields', { read: true }),
        ).rejects.toThrow(EISDIR);
    });

    // TODO: Fix ENOENT handling for non-existent fields
    it.skip('should throw ENOENT for non-existent field', async () => {
        await expect(
            entityOpen(mount, '/data/users/alice-id/fields/nonexistent', { read: true }),
        ).rejects.toThrow(ENOENT);
    });
});

// =============================================================================
// FILE HANDLE TESTS - READ OPERATIONS
// =============================================================================

describe('EntityFieldHandle - read operations', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'email', type: 'text' },
            { name: 'age', type: 'integer' },
            { name: 'config', type: 'text' },
        ]);
        await createTestEntity('users', 'alice-id', {
            email: 'alice@example.com',
            age: 30,
            config: { theme: 'dark', lang: 'en' },
        });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    // TODO: Fix field value retrieval from detail tables
    it.skip('should read entire field content', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });
        const data = await handle.read();
        const content = new TextDecoder().decode(data);

        expect(content).toContain('alice@example.com');

        await handle.close();
    });

    // TODO: Fix field value retrieval from detail tables
    it.skip('should read field content in chunks', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        const chunk1 = await handle.read(5);
        const chunk2 = await handle.read(10);

        expect(chunk1.length).toBe(5);
        expect(chunk2.length).toBeGreaterThan(0);

        await handle.close();
    });

    // TODO: Fix field value retrieval from detail tables
    it.skip('should return empty when reading past end', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        // Read all
        await handle.read();

        // Try to read more
        const empty = await handle.read();

        expect(empty.length).toBe(0);

        await handle.close();
    });

    // TODO: Fix field value retrieval from detail tables
    it.skip('should format integer field as string', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/age', { read: true });
        const data = await handle.read();
        const content = new TextDecoder().decode(data);

        expect(content).toContain('30');

        await handle.close();
    });

    // TODO: Fix field value retrieval from detail tables
    it.skip('should format object field as JSON', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/config', { read: true });
        const data = await handle.read();
        const content = new TextDecoder().decode(data);

        expect(content).toContain('theme');
        expect(content).toContain('dark');

        await handle.close();
    });
});

// =============================================================================
// FILE HANDLE TESTS - WRITE OPERATIONS
// =============================================================================

describe('EntityFieldHandle - write operations', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'email', type: 'text' },
        ]);
        await createTestEntity('users', 'alice-id', { email: 'alice@example.com' });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should throw EROFS when writing', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        await expect(handle.write(new Uint8Array([1, 2, 3]))).rejects.toThrow(EROFS);

        await handle.close();
    });
});

// =============================================================================
// FILE HANDLE TESTS - SEEK OPERATIONS
// =============================================================================

describe('EntityFieldHandle - seek operations', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'email', type: 'text' },
        ]);
        await createTestEntity('users', 'alice-id', { email: 'alice@example.com' });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should seek from start', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        const pos = await handle.seek(5, 'start');

        expect(pos).toBe(5);

        await handle.close();
    });

    it('should seek from current position', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        await handle.read(10);
        const pos = await handle.seek(5, 'current');

        expect(pos).toBe(15);

        await handle.close();
    });

    it('should seek from end', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        const pos = await handle.seek(-5, 'end');

        expect(pos).toBeGreaterThan(0);

        await handle.close();
    });

    it('should clamp negative seek to 0', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        const pos = await handle.seek(-100, 'start');

        expect(pos).toBe(0);

        await handle.close();
    });

    it('should allow seeking past end', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        const pos = await handle.seek(1000, 'start');

        expect(pos).toBe(1000);

        // Reading should return empty
        const data = await handle.read();

        expect(data.length).toBe(0);

        await handle.close();
    });
});

// =============================================================================
// FILE HANDLE TESTS - TELL OPERATIONS
// =============================================================================

describe('EntityFieldHandle - tell operations', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'email', type: 'text' },
        ]);
        await createTestEntity('users', 'alice-id', { email: 'alice@example.com' });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should return current position', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        expect(await handle.tell()).toBe(0);

        await handle.read(5);
        expect(await handle.tell()).toBe(5);

        await handle.close();
    });
});

// =============================================================================
// FILE HANDLE TESTS - CLOSE OPERATIONS
// =============================================================================

describe('EntityFieldHandle - close operations', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'email', type: 'text' },
        ]);
        await createTestEntity('users', 'alice-id', { email: 'alice@example.com' });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should close handle', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        expect(handle.closed).toBe(false);
        await handle.close();
        expect(handle.closed).toBe(true);
    });

    it('should throw EBADF when reading after close', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        await handle.close();

        await expect(handle.read()).rejects.toThrow(EBADF);
    });

    it('should throw EBADF when seeking after close', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        await handle.close();

        await expect(handle.seek(0, 'start')).rejects.toThrow(EBADF);
    });

    it('should support async dispose', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        await handle[Symbol.asyncDispose]();

        expect(handle.closed).toBe(true);
    });
});

// =============================================================================
// FILE HANDLE TESTS - ERROR CASES
// =============================================================================

describe('EntityFieldHandle - error cases', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'email', type: 'text' },
        ]);
        await createTestEntity('users', 'alice-id', { email: 'alice@example.com' });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    it('should throw EACCES when reading without read flag', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/email', { read: true });

        // Manually override flags (shouldn't happen in practice)
        handle.flags.read = false;

        await expect(handle.read()).rejects.toThrow(EACCES);

        await handle.close();
    });
});

// =============================================================================
// INTEGRATION TESTS - NESTED RELATIONSHIPS
// =============================================================================

describe('EntityMount - nested relationships', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        // Create models: users -> posts -> comments
        await createTestModel('comments', [
            { name: 'text', type: 'text' },
        ]);
        await createTestModel('posts', [
            { name: 'title', type: 'text' },
            { name: 'comment_ids', type: 'text', relatedModel: 'comments', relationshipType: 'owned' },
        ]);
        await createTestModel('users', [
            { name: 'username', type: 'text' },
            { name: 'post_ids', type: 'text', relatedModel: 'posts', relationshipType: 'owned' },
        ]);

        // Create entities
        await createTestEntity('comments', 'comment-1', { text: 'Great post!' });
        await createTestEntity('posts', 'post-1', { title: 'Hello World', comment_ids: ['comment-1'] });
        await createTestEntity('users', 'alice-id', { username: 'alice', post_ids: ['post-1'] });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    // TODO: Fix nested relationship traversal in EMS
    it.skip('should traverse nested relationships', async () => {
        // Stat: /data/users/alice-id/relationships/post_ids/post-1/relationships/comment_ids/comment-1
        const stat = await entityStat(
            mount,
            '/data/users/alice-id/relationships/post_ids/post-1/relationships/comment_ids/comment-1',
        );

        expect(stat.model).toBe('folder');
        expect(stat.name).toBe('comment-1');
    });

    // TODO: Fix nested relationship field access in EMS
    it.skip('should read field from nested entity', async () => {
        // Open: /data/users/alice-id/relationships/post_ids/post-1/fields/title
        const handle = await entityOpen(
            mount,
            '/data/users/alice-id/relationships/post_ids/post-1/fields/title',
            { read: true },
        );

        const data = await handle.read();
        const content = new TextDecoder().decode(data);

        expect(content).toContain('Hello World');

        await handle.close();
    });
});

// =============================================================================
// INTEGRATION TESTS - CUSTOM FIELD AS KEY
// =============================================================================

describe('EntityMount - custom field as key', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'username', type: 'text', unique: true },
            { name: 'email', type: 'text' },
        ]);
        await createTestEntity('users', 'user-1', { username: 'alice', email: 'alice@example.com' });

        mount = await createEntityMount(
            '/users',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
            { model: 'users', field: 'username' },
        );
    });

    it('should stat entity by username instead of id', async () => {
        const stat = await entityStat(mount, '/users/alice');

        expect(stat.name).toBe('alice');
    });

    it('should open field using username', async () => {
        const handle = await entityOpen(mount, '/users/alice/fields/email', { read: true });
        const data = await handle.read();
        const content = new TextDecoder().decode(data);

        expect(content).toContain('alice@example.com');

        await handle.close();
    });
});

// =============================================================================
// EDGE CASES - NULL AND UNDEFINED FIELD VALUES
// =============================================================================

describe('EntityMount - null and undefined field values', () => {
    let mount: EntityMount;

    beforeEach(async () => {
        await createTestModel('users', [
            { name: 'bio', type: 'text' },
            { name: 'website', type: 'text' },
        ]);
        await createTestEntity('users', 'alice-id', {
            bio: null,
            website: undefined,
        });

        mount = await createEntityMount(
            '/data',
            stack.ems!.cache,
            stack.ems!.ops,
            stack.ems!.models,
        );
    });

    // TODO: Fix null field value handling in EMS binding
    it.skip('should handle null field value', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/bio', { read: true });
        const data = await handle.read();
        const content = new TextDecoder().decode(data);

        expect(content).toBe('\n');

        await handle.close();
    });

    // TODO: Fix undefined field value handling in EMS binding
    it.skip('should handle undefined field value', async () => {
        const handle = await entityOpen(mount, '/data/users/alice-id/fields/website', { read: true });
        const data = await handle.read();
        const content = new TextDecoder().decode(data);

        expect(content).toBe('\n');

        await handle.close();
    });
});
