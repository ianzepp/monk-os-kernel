import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunChannelDevice, BunFileDevice } from '@src/hal/index.js';
import {
    DatabaseConnection,
    createDatabase,
    createDatabaseConnection,
    getSchema,
    clearSchemaCache,
} from '@src/ems/connection.js';
import { unlink } from 'node:fs/promises';

// =============================================================================
// TEST SETUP
// =============================================================================

/**
 * HAL channel device for creating SQLite channels.
 *
 * WHY: All database access goes through HAL channels, enforcing the
 * architectural boundary.
 */
const channelDevice = new BunChannelDevice();

/**
 * HAL file device for reading schema.sql.
 *
 * WHY: Schema loading goes through HAL FileDevice, maintaining the
 * architectural boundary (no direct Bun.file() outside HAL).
 */
const fileDevice = new BunFileDevice();

// =============================================================================
// SCHEMA TESTS
// =============================================================================

describe('Model Schema', () => {
    let db: DatabaseConnection;

    beforeEach(async () => {
        clearSchemaCache();
        db = await createDatabase(channelDevice, fileDevice);
    });

    afterEach(async () => {
        await db.close();
    });

    describe('table creation', () => {
        it('should create models table', async () => {
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='models'"
            );
            expect(tables.length).toBe(1);
            expect(tables[0]!.name).toBe('models');
        });

        it('should create fields table', async () => {
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='fields'"
            );
            expect(tables.length).toBe(1);
            expect(tables[0]!.name).toBe('fields');
        });

        it('should create tracked table', async () => {
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='tracked'"
            );
            expect(tables.length).toBe(1);
            expect(tables[0]!.name).toBe('tracked');
        });

        it('should create indexes', async () => {
            const indexes = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
            );
            const names = indexes.map((i) => i.name);

            expect(names).toContain('idx_models_status');
            expect(names).toContain('idx_fields_model');
            expect(names).toContain('idx_tracked_record');
        });
    });

    describe('models table columns', () => {
        it('should have all required columns', async () => {
            const columns = await db.query<{ name: string }>('PRAGMA table_info(models)');
            const names = columns.map((c) => c.name);

            // System fields
            expect(names).toContain('id');
            expect(names).toContain('created_at');
            expect(names).toContain('updated_at');
            expect(names).toContain('trashed_at');
            expect(names).toContain('expired_at');

            // Model identity
            expect(names).toContain('model_name');
            expect(names).toContain('status');
            expect(names).toContain('description');

            // Behavioral flags
            expect(names).toContain('sudo');
            expect(names).toContain('frozen');
            expect(names).toContain('immutable');
            expect(names).toContain('external');
            expect(names).toContain('passthrough');
        });

        it('should have model_name as unique', async () => {
            await db.execute("INSERT INTO models (model_name) VALUES ('test')");

            await expect(
                db.execute("INSERT INTO models (model_name) VALUES ('test')")
            ).rejects.toThrow();
        });
    });

    describe('fields table columns', () => {
        it('should have all required columns', async () => {
            const columns = await db.query<{ name: string }>('PRAGMA table_info(fields)');
            const names = columns.map((c) => c.name);

            // System fields
            expect(names).toContain('id');
            expect(names).toContain('created_at');
            expect(names).toContain('updated_at');

            // Field identity
            expect(names).toContain('model_name');
            expect(names).toContain('field_name');
            expect(names).toContain('type');
            expect(names).toContain('is_array');

            // Constraints
            expect(names).toContain('required');
            expect(names).toContain('default_value');
            expect(names).toContain('minimum');
            expect(names).toContain('maximum');
            expect(names).toContain('pattern');
            expect(names).toContain('enum_values');

            // Relationships
            expect(names).toContain('relationship_type');
            expect(names).toContain('related_model');
            expect(names).toContain('related_field');
            expect(names).toContain('cascade_delete');

            // Behavioral flags
            expect(names).toContain('immutable');
            expect(names).toContain('sudo');
            expect(names).toContain('unique_');
            expect(names).toContain('index_');
            expect(names).toContain('tracked');
            expect(names).toContain('searchable');
            expect(names).toContain('transform');
        });

        it('should enforce unique (model_name, field_name)', async () => {
            await db.execute("INSERT INTO models (model_name) VALUES ('testmodel')");
            await db.execute(
                "INSERT INTO fields (model_name, field_name, type) VALUES ('testmodel', 'testfield', 'text')"
            );

            await expect(
                db.execute(
                    "INSERT INTO fields (model_name, field_name, type) VALUES ('testmodel', 'testfield', 'text')"
                )
            ).rejects.toThrow();
        });
    });

    describe('tracked table columns', () => {
        it('should have all required columns', async () => {
            const columns = await db.query<{ name: string }>('PRAGMA table_info(tracked)');
            const names = columns.map((c) => c.name);

            expect(names).toContain('id');
            expect(names).toContain('change_id');
            expect(names).toContain('model_name');
            expect(names).toContain('record_id');
            expect(names).toContain('operation');
            expect(names).toContain('changes');
            expect(names).toContain('created_by');
            expect(names).toContain('request_id');
            expect(names).toContain('metadata');
        });
    });

    describe('foreign key constraints', () => {
        it('should enforce fields.model_name references models.model_name', async () => {
            await expect(
                db.execute("INSERT INTO fields (model_name, field_name, type) VALUES ('nonexistent', 'field1', 'text')")
            ).rejects.toThrow();
        });

        it('should cascade delete fields when model is deleted', async () => {
            // Create a test model with fields
            await db.execute("INSERT INTO models (model_name) VALUES ('cascade_test')");
            await db.execute(
                "INSERT INTO fields (model_name, field_name, type) VALUES ('cascade_test', 'field1', 'text')"
            );
            await db.execute(
                "INSERT INTO fields (model_name, field_name, type) VALUES ('cascade_test', 'field2', 'integer')"
            );

            // Verify fields exist
            let count = await db.queryOne<{ cnt: number }>(
                "SELECT COUNT(*) as cnt FROM fields WHERE model_name = 'cascade_test'"
            );
            expect(count!.cnt).toBe(2);

            // Delete model
            await db.execute("DELETE FROM models WHERE model_name = 'cascade_test'");

            // Fields should be gone
            count = await db.queryOne<{ cnt: number }>(
                "SELECT COUNT(*) as cnt FROM fields WHERE model_name = 'cascade_test'"
            );
            expect(count!.cnt).toBe(0);
        });
    });

    describe('system meta-models seed data', () => {
        it('should seed models meta-model', async () => {
            const model = await db.queryOne<{ model_name: string; status: string; sudo: number }>(
                "SELECT model_name, status, sudo FROM models WHERE model_name = 'models'"
            );

            expect(model).not.toBeNull();
            expect(model!.status).toBe('system');
            expect(model!.sudo).toBe(1);
        });

        it('should seed fields meta-model', async () => {
            const model = await db.queryOne<{ model_name: string; status: string; sudo: number }>(
                "SELECT model_name, status, sudo FROM models WHERE model_name = 'fields'"
            );

            expect(model).not.toBeNull();
            expect(model!.status).toBe('system');
            expect(model!.sudo).toBe(1);
        });

        it('should seed tracked meta-model', async () => {
            const model = await db.queryOne<{ model_name: string; status: string; sudo: number }>(
                "SELECT model_name, status, sudo FROM models WHERE model_name = 'tracked'"
            );

            expect(model).not.toBeNull();
            expect(model!.status).toBe('system');
            expect(model!.sudo).toBe(1);
        });
    });

    describe('VFS system models seed data', () => {
        it('should seed file model', async () => {
            const model = await db.queryOne<{ model_name: string; status: string }>(
                "SELECT model_name, status FROM models WHERE model_name = 'file'"
            );

            expect(model).not.toBeNull();
            expect(model!.status).toBe('system');
        });

        it('should seed folder model', async () => {
            const model = await db.queryOne<{ model_name: string; status: string }>(
                "SELECT model_name, status FROM models WHERE model_name = 'folder'"
            );

            expect(model).not.toBeNull();
            expect(model!.status).toBe('system');
        });

        it('should seed device model', async () => {
            const model = await db.queryOne<{ model_name: string; status: string }>(
                "SELECT model_name, status FROM models WHERE model_name = 'device'"
            );

            expect(model).not.toBeNull();
            expect(model!.status).toBe('system');
        });

        it('should seed proc model', async () => {
            const model = await db.queryOne<{ model_name: string; status: string }>(
                "SELECT model_name, status FROM models WHERE model_name = 'proc'"
            );

            expect(model).not.toBeNull();
            expect(model!.status).toBe('system');
        });

        it('should seed link model', async () => {
            const model = await db.queryOne<{ model_name: string; status: string }>(
                "SELECT model_name, status FROM models WHERE model_name = 'link'"
            );

            expect(model).not.toBeNull();
            expect(model!.status).toBe('system');
        });

        it('should have 9 system models total', async () => {
            const count = await db.queryOne<{ cnt: number }>(
                "SELECT COUNT(*) as cnt FROM models WHERE status = 'system'"
            );

            // 3 meta-models + 6 VFS models = 9
            expect(count!.cnt).toBe(9);
        });
    });

    describe('file model fields seed data', () => {
        it('should have owner field', async () => {
            const field = await db.queryOne<{ field_name: string; type: string; required: number }>(
                "SELECT field_name, type, required FROM fields WHERE model_name = 'file' AND field_name = 'owner'"
            );

            expect(field).not.toBeNull();
            expect(field!.type).toBe('uuid');
            expect(field!.required).toBe(1);
        });

        it('should have size field', async () => {
            const field = await db.queryOne<{ field_name: string; type: string }>(
                "SELECT field_name, type FROM fields WHERE model_name = 'file' AND field_name = 'size'"
            );

            expect(field).not.toBeNull();
            expect(field!.type).toBe('integer');
        });

        it('should have mimetype field', async () => {
            const field = await db.queryOne<{ field_name: string; type: string }>(
                "SELECT field_name, type FROM fields WHERE model_name = 'file' AND field_name = 'mimetype'"
            );

            expect(field).not.toBeNull();
            expect(field!.type).toBe('text');
        });

        it('should have checksum field', async () => {
            const field = await db.queryOne<{ field_name: string; type: string }>(
                "SELECT field_name, type FROM fields WHERE model_name = 'file' AND field_name = 'checksum'"
            );

            expect(field).not.toBeNull();
            expect(field!.type).toBe('text');
        });
    });

    describe('folder model fields seed data', () => {
        it('should have owner field (pathname/parent in entities table)', async () => {
            const fields = await db.query<{ field_name: string }>(
                "SELECT field_name FROM fields WHERE model_name = 'folder'"
            );
            const names = fields.map((f) => f.field_name);

            expect(names).toContain('owner');
            expect(names.length).toBe(1); // Only model-specific fields
        });
    });

    describe('device model fields seed data', () => {
        it('should have owner, driver fields (pathname/parent in entities table)', async () => {
            const fields = await db.query<{ field_name: string }>(
                "SELECT field_name FROM fields WHERE model_name = 'device'"
            );
            const names = fields.map((f) => f.field_name);

            expect(names).toContain('owner');
            expect(names).toContain('driver');
            expect(names.length).toBe(2);
        });
    });

    describe('proc model fields seed data', () => {
        it('should have owner, handler fields (pathname/parent in entities table)', async () => {
            const fields = await db.query<{ field_name: string }>(
                "SELECT field_name FROM fields WHERE model_name = 'proc'"
            );
            const names = fields.map((f) => f.field_name);

            expect(names).toContain('owner');
            expect(names).toContain('handler');
            expect(names.length).toBe(2);
        });
    });

    describe('link model fields seed data', () => {
        it('should have owner, target fields (pathname/parent in entities table)', async () => {
            const fields = await db.query<{ field_name: string }>(
                "SELECT field_name FROM fields WHERE model_name = 'link'"
            );
            const names = fields.map((f) => f.field_name);

            expect(names).toContain('owner');
            expect(names).toContain('target');
            expect(names.length).toBe(2);
        });
    });

    describe('models meta-model fields seed data', () => {
        it('should have fields for models table', async () => {
            const fields = await db.query<{ field_name: string }>(
                "SELECT field_name FROM fields WHERE model_name = 'models'"
            );
            const names = fields.map((f) => f.field_name);

            expect(names).toContain('model_name');
            expect(names).toContain('status');
            expect(names).toContain('description');
            expect(names).toContain('sudo');
            expect(names).toContain('frozen');
            expect(names).toContain('immutable');
            expect(names).toContain('external');
            expect(names).toContain('passthrough');
        });
    });

    describe('fields meta-model fields seed data', () => {
        it('should have fields for fields table', async () => {
            const fields = await db.query<{ field_name: string }>(
                "SELECT field_name FROM fields WHERE model_name = 'fields'"
            );
            const names = fields.map((f) => f.field_name);

            expect(names).toContain('model_name');
            expect(names).toContain('field_name');
            expect(names).toContain('type');
            expect(names).toContain('is_array');
            expect(names).toContain('required');
            expect(names).toContain('immutable');
            expect(names).toContain('tracked');
            expect(names.length).toBeGreaterThan(20); // Many fields
        });
    });

    describe('tracked meta-model fields seed data', () => {
        it('should have fields for tracked table', async () => {
            const fields = await db.query<{ field_name: string }>(
                "SELECT field_name FROM fields WHERE model_name = 'tracked'"
            );
            const names = fields.map((f) => f.field_name);

            expect(names).toContain('change_id');
            expect(names).toContain('model_name');
            expect(names).toContain('record_id');
            expect(names).toContain('operation');
            expect(names).toContain('changes');
            expect(names).toContain('created_by');
            expect(names).toContain('request_id');
            expect(names).toContain('metadata');
        });
    });

    describe('idempotency', () => {
        it('should be safe to run schema multiple times', async () => {
            // Schema was already run in beforeEach
            // Run it again
            const schema = await getSchema(fileDevice);
            await db.exec(schema);

            // Should still have correct data
            const count = await db.queryOne<{ cnt: number }>(
                "SELECT COUNT(*) as cnt FROM models WHERE status = 'system'"
            );
            expect(count!.cnt).toBe(9);
        });
    });

    describe('default values', () => {
        it('should auto-generate id on insert', async () => {
            await db.execute("INSERT INTO models (model_name) VALUES ('test_auto_id')");

            const model = await db.queryOne<{ id: string }>(
                "SELECT id FROM models WHERE model_name = 'test_auto_id'"
            );

            expect(model).not.toBeNull();
            expect(model!.id).toBeTruthy();
            expect(model!.id.length).toBe(32); // 16 bytes = 32 hex chars
        });

        it('should auto-set created_at on insert', async () => {
            const before = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            await db.execute("INSERT INTO models (model_name) VALUES ('test_created')");

            const model = await db.queryOne<{ created_at: string }>(
                "SELECT created_at FROM models WHERE model_name = 'test_created'"
            );

            expect(model).not.toBeNull();
            expect(model!.created_at).toBeTruthy();
            expect(model!.created_at.slice(0, 10)).toBe(before);
        });

        it('should default status to active', async () => {
            await db.execute("INSERT INTO models (model_name) VALUES ('test_status')");

            const model = await db.queryOne<{ status: string }>(
                "SELECT status FROM models WHERE model_name = 'test_status'"
            );

            expect(model).not.toBeNull();
            expect(model!.status).toBe('active');
        });

        it('should default behavioral flags to 0', async () => {
            await db.execute("INSERT INTO models (model_name) VALUES ('test_flags')");

            const model = await db.queryOne<{
                sudo: number;
                frozen: number;
                immutable: number;
                external: number;
                passthrough: number;
            }>("SELECT sudo, frozen, immutable, external, passthrough FROM models WHERE model_name = 'test_flags'");

            expect(model).not.toBeNull();
            expect(model!.sudo).toBe(0);
            expect(model!.frozen).toBe(0);
            expect(model!.immutable).toBe(0);
            expect(model!.external).toBe(0);
            expect(model!.passthrough).toBe(0);
        });

        it('should default field type to text', async () => {
            await db.execute("INSERT INTO models (model_name) VALUES ('test_field_type')");
            await db.execute("INSERT INTO fields (model_name, field_name) VALUES ('test_field_type', 'test')");

            const field = await db.queryOne<{ type: string }>(
                "SELECT type FROM fields WHERE model_name = 'test_field_type' AND field_name = 'test'"
            );

            expect(field).not.toBeNull();
            expect(field!.type).toBe('text');
        });
    });

    describe('check constraints', () => {
        it('should enforce status enum values', async () => {
            await expect(
                db.execute("INSERT INTO models (model_name, status) VALUES ('test_bad_status', 'invalid')")
            ).rejects.toThrow();
        });

        it('should enforce operation enum values in tracked', async () => {
            await expect(
                db.execute(`
                    INSERT INTO tracked (model_name, record_id, operation, changes)
                    VALUES ('file', 'test-id', 'invalid', '{}')
                `)
            ).rejects.toThrow();
        });

        it('should allow valid operation values in tracked', async () => {
            await db.execute(`
                INSERT INTO tracked (model_name, record_id, operation, changes)
                VALUES ('file', 'test-id-1', 'create', '{}')
            `);
            await db.execute(`
                INSERT INTO tracked (model_name, record_id, operation, changes)
                VALUES ('file', 'test-id-2', 'update', '{}')
            `);
            await db.execute(`
                INSERT INTO tracked (model_name, record_id, operation, changes)
                VALUES ('file', 'test-id-3', 'delete', '{}')
            `);

            const count = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM tracked');
            expect(count!.cnt).toBe(3);
        });

        it('should enforce relationship_type enum values', async () => {
            await db.execute("INSERT INTO models (model_name) VALUES ('test_rel')");

            // Valid values should work
            await db.execute(`
                INSERT INTO fields (model_name, field_name, type, relationship_type)
                VALUES ('test_rel', 'ref1', 'uuid', 'owned')
            `);
            await db.execute(`
                INSERT INTO fields (model_name, field_name, type, relationship_type)
                VALUES ('test_rel', 'ref2', 'uuid', 'referenced')
            `);

            // Invalid value should fail
            await expect(
                db.execute(`
                    INSERT INTO fields (model_name, field_name, type, relationship_type)
                    VALUES ('test_rel', 'ref3', 'uuid', 'invalid')
                `)
            ).rejects.toThrow();
        });
    });

    // =========================================================================
    // SYSTEM ENTITY TABLES
    // =========================================================================

    // =========================================================================
    // ENTITIES TABLE (Core Identity + Hierarchy)
    // =========================================================================

    describe('entities table', () => {
        it('should create entities table', async () => {
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
            );
            expect(tables.length).toBe(1);
        });

        it('should have id, model, parent, pathname columns', async () => {
            const columns = await db.query<{ name: string }>('PRAGMA table_info(entities)');
            const names = columns.map((c) => c.name);

            expect(names).toContain('id');
            expect(names).toContain('model');
            expect(names).toContain('parent');
            expect(names).toContain('pathname');
            expect(names.length).toBe(4); // No timestamps in entities table
        });

        it('should create indexes', async () => {
            const indexes = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_entities_%'"
            );
            const names = indexes.map((i) => i.name);

            expect(names).toContain('idx_entities_parent_pathname');
            expect(names).toContain('idx_entities_parent');
            expect(names).toContain('idx_entities_model');
        });
    });

    // =========================================================================
    // DETAIL TABLES (Model-specific fields only)
    // =========================================================================

    describe('file detail table', () => {
        it('should create file table', async () => {
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='file'"
            );
            expect(tables.length).toBe(1);
        });

        it('should have detail columns (no pathname/parent - those are in entities)', async () => {
            const columns = await db.query<{ name: string }>('PRAGMA table_info(file)');
            const names = columns.map((c) => c.name);

            // System fields (timestamps in detail table)
            expect(names).toContain('id');
            expect(names).toContain('created_at');
            expect(names).toContain('updated_at');
            expect(names).toContain('trashed_at');
            expect(names).toContain('expired_at');

            // File-specific fields only
            expect(names).toContain('owner');
            expect(names).toContain('size');
            expect(names).toContain('mimetype');
            expect(names).toContain('checksum');

            // pathname and parent are NOT in detail table
            expect(names).not.toContain('name');
            expect(names).not.toContain('pathname');
            expect(names).not.toContain('parent');
        });

        it('should allow inserting file entities via entities + file', async () => {
            // First insert into entities table
            await db.execute(`
                INSERT INTO entities (id, model, parent, pathname)
                VALUES ('test-file-id', 'file', NULL, 'test.txt')
            `);
            // Then insert into detail table
            await db.execute(`
                INSERT INTO file (id, owner) VALUES ('test-file-id', 'owner-123')
            `);

            const file = await db.queryOne<{ owner: string; size: number }>(
                "SELECT owner, size FROM file WHERE id = 'test-file-id'"
            );

            expect(file).not.toBeNull();
            expect(file!.owner).toBe('owner-123');
            expect(file!.size).toBe(0); // default
        });

        it('should enforce owner NOT NULL', async () => {
            await db.execute(`
                INSERT INTO entities (id, model, parent, pathname)
                VALUES ('test-file-2', 'file', NULL, 'test2.txt')
            `);
            await expect(
                db.execute("INSERT INTO file (id) VALUES ('test-file-2')")
            ).rejects.toThrow();
        });
    });

    describe('folder detail table', () => {
        it('should create folder table', async () => {
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='folder'"
            );
            expect(tables.length).toBe(1);
        });

        it('should have detail columns only', async () => {
            const columns = await db.query<{ name: string }>('PRAGMA table_info(folder)');
            const names = columns.map((c) => c.name);

            expect(names).toContain('id');
            expect(names).toContain('owner');
            // pathname and parent are NOT in detail table
            expect(names).not.toContain('name');
            expect(names).not.toContain('pathname');
            expect(names).not.toContain('parent');
        });
    });

    describe('device detail table', () => {
        it('should create device table', async () => {
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='device'"
            );
            expect(tables.length).toBe(1);
        });

        it('should have detail columns only', async () => {
            const columns = await db.query<{ name: string }>('PRAGMA table_info(device)');
            const names = columns.map((c) => c.name);

            expect(names).toContain('id');
            expect(names).toContain('owner');
            expect(names).toContain('driver');
            // pathname and parent are NOT in detail table
            expect(names).not.toContain('name');
            expect(names).not.toContain('pathname');
            expect(names).not.toContain('parent');
        });

        it('should enforce driver NOT NULL', async () => {
            await db.execute(`
                INSERT INTO entities (id, model, parent, pathname)
                VALUES ('test-device', 'device', NULL, 'console')
            `);
            await expect(
                db.execute("INSERT INTO device (id, owner) VALUES ('test-device', 'kernel')")
            ).rejects.toThrow();
        });
    });

    describe('proc detail table', () => {
        it('should create proc table', async () => {
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='proc'"
            );
            expect(tables.length).toBe(1);
        });

        it('should have detail columns only', async () => {
            const columns = await db.query<{ name: string }>('PRAGMA table_info(proc)');
            const names = columns.map((c) => c.name);

            expect(names).toContain('id');
            expect(names).toContain('owner');
            expect(names).toContain('handler');
            // pathname and parent are NOT in detail table
            expect(names).not.toContain('name');
            expect(names).not.toContain('pathname');
            expect(names).not.toContain('parent');
        });

        it('should enforce handler NOT NULL', async () => {
            await db.execute(`
                INSERT INTO entities (id, model, parent, pathname)
                VALUES ('test-proc', 'proc', NULL, 'stat')
            `);
            await expect(
                db.execute("INSERT INTO proc (id, owner) VALUES ('test-proc', 'kernel')")
            ).rejects.toThrow();
        });
    });

    describe('link detail table', () => {
        it('should create link table', async () => {
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='link'"
            );
            expect(tables.length).toBe(1);
        });

        it('should have detail columns only', async () => {
            const columns = await db.query<{ name: string }>('PRAGMA table_info(link)');
            const names = columns.map((c) => c.name);

            expect(names).toContain('id');
            expect(names).toContain('owner');
            expect(names).toContain('target');
            // pathname and parent are NOT in detail table
            expect(names).not.toContain('name');
            expect(names).not.toContain('pathname');
            expect(names).not.toContain('parent');
        });

        it('should enforce target NOT NULL', async () => {
            await db.execute(`
                INSERT INTO entities (id, model, parent, pathname)
                VALUES ('test-link', 'link', NULL, 'mylink')
            `);
            await expect(
                db.execute("INSERT INTO link (id, owner) VALUES ('test-link', 'user-123')")
            ).rejects.toThrow();
        });
    });

    describe('table count', () => {
        it('should have 10 total tables (3 meta + 1 entities + 6 detail)', async () => {
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            );
            // models, fields, tracked, entities + file, folder, device, proc, link, temp = 10
            expect(tables.length).toBe(10);
        });
    });
});

// =============================================================================
// CONNECTION MODULE TESTS
// =============================================================================

describe('Connection Module', () => {
    describe('createDatabaseConnection', () => {
        it('should create a database connection', async () => {
            const db = await createDatabaseConnection(channelDevice);
            expect(db).toBeTruthy();

            // Verify it's functional
            const result = await db.queryOne<{ num: number }>('SELECT 1 as num');
            expect(result!.num).toBe(1);

            await db.close();
        });

        it('should enable foreign keys', async () => {
            const db = await createDatabaseConnection(channelDevice);
            const fk = await db.queryOne<{ foreign_keys: number }>('PRAGMA foreign_keys');
            expect(fk!.foreign_keys).toBe(1);
            await db.close();
        });
    });

    describe('createDatabase', () => {
        it('should create database with schema', async () => {
            const db = await createDatabase(channelDevice, fileDevice);

            // Verify tables exist
            const tables = await db.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('models', 'fields', 'tracked')"
            );
            expect(tables.length).toBe(3);

            await db.close();
        });

        it('should seed system models', async () => {
            const db = await createDatabase(channelDevice, fileDevice);

            const models = await db.query<{ model_name: string }>(
                "SELECT model_name FROM models WHERE status = 'system'"
            );
            expect(models.length).toBe(9);

            await db.close();
        });
    });

    describe('getSchema', () => {
        it('should return schema SQL content', async () => {
            clearSchemaCache();
            const schema = await getSchema(fileDevice);

            expect(schema).toBeTruthy();
            expect(schema).toContain('CREATE TABLE IF NOT EXISTS models');
            expect(schema).toContain('CREATE TABLE IF NOT EXISTS fields');
            expect(schema).toContain('CREATE TABLE IF NOT EXISTS tracked');
        });
    });

    describe('file-based database', () => {
        const testPath = `/tmp/monk-schema-test-${Date.now()}.db`;

        afterEach(async () => {
            try {
                await unlink(testPath);
                await unlink(testPath + '-wal');
                await unlink(testPath + '-shm');
            } catch {
                // Ignore cleanup errors
            }
        });

        it('should enable WAL mode for file-based databases', async () => {
            const db = await createDatabaseConnection(channelDevice, testPath);
            const mode = await db.queryOne<{ journal_mode: string }>('PRAGMA journal_mode');
            expect(mode!.journal_mode.toLowerCase()).toBe('wal');
            await db.close();
        });

        it('should use memory mode for in-memory databases', async () => {
            const db = await createDatabaseConnection(channelDevice, ':memory:');
            const mode = await db.queryOne<{ journal_mode: string }>('PRAGMA journal_mode');
            // In-memory databases use "memory" as journal mode, not WAL
            expect(mode!.journal_mode.toLowerCase()).toBe('memory');
            await db.close();
        });
    });
});
