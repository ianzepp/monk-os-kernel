/**
 * Model Layer - Phase 3/3.5 Tests
 *
 * Tests for Model, ModelRecord, ModelCache, Filter, and DatabaseService classes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunHAL } from '@src/hal/index.js';
import { createDatabase, type DatabaseConnection } from '@src/model/connection.js';
import { Model, type ModelRow, type FieldRow } from '@src/model/model.js';
import { ModelRecord } from '@src/model/model-record.js';
import { ModelCache } from '@src/model/model-cache.js';
import { Filter } from '@src/model/filter.js';
import { FilterOp, type FilterData } from '@src/model/filter-types.js';
import { DatabaseService, type DbRecord } from '@src/model/database.js';
import { ObserverRunner } from '@src/model/observers/runner.js';

// =============================================================================
// TEST SETUP
// =============================================================================

let hal: BunHAL;
let db: DatabaseConnection;

beforeEach(async () => {
    hal = new BunHAL();
    await hal.init();
    db = await createDatabase(hal.channel, hal.file);
});

afterEach(async () => {
    await db.close();
    await hal.shutdown();
});

// =============================================================================
// MODEL CLASS TESTS
// =============================================================================

describe('Model', () => {
    describe('construction', () => {
        it('should create a Model from row data', () => {
            const row: ModelRow = {
                id: 'test-id',
                model_name: 'test',
                status: 'active',
                description: 'Test model',
                sudo: 0,
                frozen: 0,
                immutable: 0,
                external: 0,
                passthrough: 0,
            };
            const fields: FieldRow[] = [
                {
                    id: 'field-1',
                    model_name: 'test',
                    field_name: 'name',
                    type: 'text',
                    is_array: 0,
                    required: 1,
                    default_value: null,
                    minimum: null,
                    maximum: null,
                    pattern: null,
                    enum_values: null,
                    relationship_type: null,
                    related_model: null,
                    related_field: null,
                    relationship_name: null,
                    cascade_delete: 0,
                    required_relationship: 0,
                    immutable: 0,
                    sudo: 0,
                    unique_: 0,
                    index_: 0,
                    tracked: 0,
                    searchable: 0,
                    transform: null,
                    description: null,
                },
            ];

            const model = new Model(row, fields);

            expect(model.modelName).toBe('test');
            expect(model.status).toBe('active');
            expect(model.description).toBe('Test model');
        });
    });

    describe('behavioral flags', () => {
        it('should report system models', () => {
            const row = createModelRow({ status: 'system' });
            const model = new Model(row, []);
            expect(model.isSystem).toBe(true);
        });

        it('should report frozen models', () => {
            const row = createModelRow({ frozen: 1 });
            const model = new Model(row, []);
            expect(model.isFrozen).toBe(true);
        });

        it('should report immutable models', () => {
            const row = createModelRow({ immutable: 1 });
            const model = new Model(row, []);
            expect(model.isImmutable).toBe(true);
        });

        it('should report sudo requirement', () => {
            const row = createModelRow({ sudo: 1 });
            const model = new Model(row, []);
            expect(model.requiresSudo).toBe(true);
        });
    });

    describe('field access', () => {
        it('should get field by name', () => {
            const row = createModelRow();
            const fields = [createFieldRow({ field_name: 'name', required: 1 })];
            const model = new Model(row, fields);

            const field = model.getField('name');
            expect(field).not.toBeUndefined();
            expect(field!.required).toBe(1);
        });

        it('should return undefined for unknown field', () => {
            const model = new Model(createModelRow(), []);
            expect(model.getField('unknown')).toBeUndefined();
        });

        it('should report field count', () => {
            const fields = [createFieldRow({ field_name: 'a' }), createFieldRow({ field_name: 'b' })];
            const model = new Model(createModelRow(), fields);
            expect(model.fieldCount).toBe(2);
        });
    });

    describe('categorization', () => {
        it('should return required fields', () => {
            const fields = [
                createFieldRow({ field_name: 'name', required: 1 }),
                createFieldRow({ field_name: 'optional', required: 0 }),
            ];
            const model = new Model(createModelRow(), fields);

            const required = model.getRequiredFields();
            expect(required.has('name')).toBe(true);
            expect(required.has('optional')).toBe(false);
        });

        it('should return immutable fields', () => {
            const fields = [
                createFieldRow({ field_name: 'id', immutable: 1 }),
                createFieldRow({ field_name: 'name', immutable: 0 }),
            ];
            const model = new Model(createModelRow(), fields);

            const immutable = model.getImmutableFields();
            expect(immutable.has('id')).toBe(true);
            expect(immutable.has('name')).toBe(false);
        });

        it('should cache categorization', () => {
            const model = new Model(createModelRow(), [createFieldRow()]);

            expect(model.isCategorized()).toBe(false);
            model.getRequiredFields();
            expect(model.isCategorized()).toBe(true);
        });
    });
});

// =============================================================================
// MODEL RECORD TESTS
// =============================================================================

describe('ModelRecord', () => {
    describe('construction', () => {
        it('should create empty record', () => {
            const record = new ModelRecord();
            expect(record.isNew()).toBe(true);
            expect(record.hasChanges()).toBe(false);
        });

        it('should create record with original data', () => {
            const record = new ModelRecord({ id: '123', name: 'Alice' });
            expect(record.isNew()).toBe(false);
            expect(record.old('name')).toBe('Alice');
        });

        it('should create record with changes', () => {
            const record = new ModelRecord({}, { name: 'Bob' });
            expect(record.isNew()).toBe(true);
            expect(record.has('name')).toBe(true);
            expect(record.get('name')).toBe('Bob');
        });
    });

    describe('value access', () => {
        it('should get old value', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Bob' });
            expect(record.old('name')).toBe('Alice');
        });

        it('should get new value', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Bob' });
            expect(record.new('name')).toBe('Bob');
        });

        it('should get merged value (new overrides old)', () => {
            const record = new ModelRecord({ name: 'Alice', age: 30 }, { name: 'Bob' });
            expect(record.get('name')).toBe('Bob');
            expect(record.get('age')).toBe(30);
        });
    });

    describe('mutation', () => {
        it('should set new value', () => {
            const record = new ModelRecord();
            record.set('email', 'test@example.com');
            expect(record.get('email')).toBe('test@example.com');
        });

        it('should unset a change', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Bob' });
            record.unset('name');
            expect(record.get('name')).toBe('Alice');
        });

        it('should clear all changes', () => {
            const record = new ModelRecord({}, { a: 1, b: 2 });
            record.clearChanges();
            expect(record.hasChanges()).toBe(false);
        });
    });

    describe('export', () => {
        it('should export merged record', () => {
            const record = new ModelRecord({ id: '123', name: 'Alice' }, { name: 'Bob' });
            const data = record.toRecord();
            expect(data).toEqual({ id: '123', name: 'Bob' });
        });

        it('should export only changes', () => {
            const record = new ModelRecord({ id: '123' }, { name: 'Bob' });
            const changes = record.toChanges();
            expect(changes).toEqual({ name: 'Bob' });
        });

        it('should export diff', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Bob' });
            const diff = record.getDiff();
            expect(diff).toEqual({ name: { old: 'Alice', new: 'Bob' } });
        });

        it('should not include unchanged fields in diff', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Alice' });
            const diff = record.getDiff();
            expect(diff).toEqual({});
        });
    });
});

// =============================================================================
// MODEL CACHE TESTS
// =============================================================================

describe('ModelCache', () => {
    describe('loading', () => {
        it('should load system models', async () => {
            const cache = new ModelCache(db);

            const fileModel = await cache.get('file');
            expect(fileModel).not.toBeUndefined();
            expect(fileModel!.modelName).toBe('file');
            expect(fileModel!.isSystem).toBe(true);
        });

        it('should return undefined for unknown models', async () => {
            const cache = new ModelCache(db);
            const unknown = await cache.get('nonexistent');
            expect(unknown).toBeUndefined();
        });

        it('should cache loaded models', async () => {
            const cache = new ModelCache(db);

            await cache.get('file');
            expect(cache.isCached('file')).toBe(true);
            expect(cache.cacheSize).toBe(1);
        });
    });

    describe('require', () => {
        it('should return model when exists', async () => {
            const cache = new ModelCache(db);
            const model = await cache.require('folder');
            expect(model.modelName).toBe('folder');
        });

        it('should throw when model not found', async () => {
            const cache = new ModelCache(db);
            await expect(cache.require('nonexistent')).rejects.toThrow(/not found/);
        });
    });

    describe('invalidation', () => {
        it('should invalidate cached model', async () => {
            const cache = new ModelCache(db);

            await cache.get('file');
            expect(cache.isCached('file')).toBe(true);

            cache.invalidate('file');
            expect(cache.isCached('file')).toBe(false);
        });

        it('should clear all cached models', async () => {
            const cache = new ModelCache(db);

            await cache.get('file');
            await cache.get('folder');
            expect(cache.cacheSize).toBe(2);

            cache.clear();
            expect(cache.cacheSize).toBe(0);
        });
    });

    describe('preloading', () => {
        it('should preload system models', async () => {
            const cache = new ModelCache(db);

            await cache.preloadSystemModels();
            expect(cache.cacheSize).toBe(8); // 3 meta + 5 VFS
        });
    });
});

// =============================================================================
// FILTER TESTS
// =============================================================================

describe('Filter', () => {
    describe('basic queries', () => {
        it('should generate simple SELECT', () => {
            const filter = new Filter('file');
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL');
            expect(params).toEqual([]);
        });

        it('should handle where clause with equality', () => {
            const filter = new Filter('file').where({ status: 'active' });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND status = ?');
            expect(params).toEqual(['active']);
        });

        it('should handle where clause with operators', () => {
            const filter = new Filter('file').where({ size: { $gte: 1000 } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND size >= ?');
            expect(params).toEqual([1000]);
        });

        it('should handle $in operator', () => {
            const filter = new Filter('file').where({ status: { $in: ['a', 'b'] } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND status IN (?, ?)');
            expect(params).toEqual(['a', 'b']);
        });

        it('should handle $or operator', () => {
            const filter = new Filter('file').where({
                $or: [{ status: 'a' }, { status: 'b' }],
            });
            const { sql, params } = filter.toSQL();

            expect(sql).toContain('(status = ? OR status = ?)');
            expect(params).toEqual(['a', 'b']);
        });

        it('should handle $and operator', () => {
            const filter = new Filter('file').where({
                $and: [{ status: 'active' }, { size: { $gt: 0 } }],
            });
            const { sql, params } = filter.toSQL();

            expect(sql).toContain('(status = ? AND size > ?)');
            expect(params).toEqual(['active', 0]);
        });
    });

    describe('soft delete handling', () => {
        it('should exclude trashed by default', () => {
            const filter = new Filter('file');
            const { sql } = filter.toSQL();
            expect(sql).toContain('trashed_at IS NULL');
        });

        it('should include trashed when specified', () => {
            const filter = new Filter('file').trashed('include');
            const { sql } = filter.toSQL();
            expect(sql).not.toContain('trashed_at');
        });

        it('should only trashed when specified', () => {
            const filter = new Filter('file').trashed('only');
            const { sql } = filter.toSQL();
            expect(sql).toContain('trashed_at IS NOT NULL');
        });
    });

    describe('ordering and pagination', () => {
        it('should handle order by', () => {
            const filter = new Filter('file').order([{ field: 'name', sort: 'asc' }]);
            const { sql } = filter.toSQL();
            expect(sql).toContain('ORDER BY name ASC');
        });

        it('should handle multiple order clauses', () => {
            const filter = new Filter('file').order([
                { field: 'status', sort: 'desc' },
                { field: 'name', sort: 'asc' },
            ]);
            const { sql } = filter.toSQL();
            expect(sql).toContain('ORDER BY status DESC, name ASC');
        });

        it('should handle limit', () => {
            const filter = new Filter('file').limit(10);
            const { sql } = filter.toSQL();
            expect(sql).toContain('LIMIT 10');
        });

        it('should handle offset', () => {
            const filter = new Filter('file').limit(10).offset(20);
            const { sql } = filter.toSQL();
            expect(sql).toContain('LIMIT 10 OFFSET 20');
        });
    });

    describe('count queries', () => {
        it('should generate COUNT query', () => {
            const filter = new Filter('file').where({ status: 'active' });
            const { sql, params } = filter.toCountSQL();

            expect(sql).toBe('SELECT COUNT(*) as count FROM file WHERE trashed_at IS NULL AND status = ?');
            expect(params).toEqual(['active']);
        });
    });

    describe('static factory', () => {
        it('should create filter from FilterData', () => {
            const filterData: FilterData = {
                where: { status: 'active' },
                order: [{ field: 'name', sort: 'asc' }],
                limit: 10,
            };

            const filter = Filter.from('file', filterData);
            const { sql, params } = filter.toSQL();

            expect(sql).toContain('status = ?');
            expect(sql).toContain('ORDER BY name ASC');
            expect(sql).toContain('LIMIT 10');
            expect(params).toEqual(['active']);
        });
    });
});

// =============================================================================
// DATABASE SERVICE TESTS
// =============================================================================

describe('DatabaseService', () => {
    let cache: ModelCache;
    let runner: ObserverRunner;
    let service: DatabaseService;

    beforeEach(async () => {
        cache = new ModelCache(db);
        runner = new ObserverRunner();
        service = new DatabaseService(db, cache, runner);
    });

    describe('selectAny', () => {
        it('should select all records', async () => {
            const models = await service.selectAny<DbRecord>('models');
            expect(models.length).toBe(8); // 3 meta + 5 VFS
        });

        it('should filter with where clause', async () => {
            const models = await service.selectAny<DbRecord>('models', {
                where: { status: 'system' },
            });
            expect(models.length).toBe(8);
        });

        it('should respect limit', async () => {
            const models = await service.selectAny<DbRecord>('models', { limit: 2 });
            expect(models.length).toBe(2);
        });
    });

    describe('selectOne', () => {
        it('should select single record', async () => {
            const model = await service.selectOne<DbRecord>('models', {
                where: { model_name: 'file' },
            });
            expect(model).not.toBeNull();
            expect(model!.model_name).toBe('file');
        });

        it('should return null for no match', async () => {
            const model = await service.selectOne<DbRecord>('models', {
                where: { model_name: 'nonexistent' },
            });
            expect(model).toBeNull();
        });
    });

    describe('select404', () => {
        it('should return record when found', async () => {
            const model = await service.select404<DbRecord>('models', {
                where: { model_name: 'folder' },
            });
            expect(model.model_name).toBe('folder');
        });

        it('should throw when not found', async () => {
            await expect(
                service.select404('models', { where: { model_name: 'nonexistent' } })
            ).rejects.toThrow(/not found/);
        });
    });

    describe('selectIds', () => {
        it('should select records by IDs', async () => {
            const allModels = await service.selectAny<DbRecord>('models', { limit: 2 });
            const ids = allModels.map((m) => m.id);

            const selected = await service.selectIds<DbRecord>('models', ids);
            expect(selected.length).toBe(2);
        });

        it('should return empty for empty IDs', async () => {
            const selected = await service.selectIds<DbRecord>('models', []);
            expect(selected.length).toBe(0);
        });
    });

    describe('count', () => {
        it('should count records', async () => {
            const count = await service.count('models');
            expect(count).toBe(8);
        });

        it('should count with filter', async () => {
            const count = await service.count('fields', { where: { model_name: 'file' } });
            expect(count).toBeGreaterThan(0);
        });
    });

    describe('createOne', () => {
        it('should create a file record', async () => {
            const file = await service.createOne<DbRecord>('file', {
                name: 'test.txt',
                owner: 'test-owner',
            });

            expect(file.id).toBeTruthy();
            expect(file.name).toBe('test.txt');
            expect(file.owner).toBe('test-owner');
            expect(file.created_at).toBeTruthy();
            expect(file.updated_at).toBeTruthy();
        });

        it('should generate ID if not provided', async () => {
            const file = await service.createOne<DbRecord>('file', {
                name: 'test.txt',
                owner: 'test-owner',
            });
            expect(file.id).toMatch(/^[0-9a-f]{32}$/);
        });

        it('should use provided ID', async () => {
            const customId = 'custom123456789012345678901234';
            const file = await service.createOne<DbRecord>('file', {
                id: customId,
                name: 'test.txt',
                owner: 'test-owner',
            });
            expect(file.id).toBe(customId);
        });
    });

    describe('createAll', () => {
        it('should create multiple records', async () => {
            const files = await service.createAll<DbRecord>('file', [
                { name: 'a.txt', owner: 'owner-1' },
                { name: 'b.txt', owner: 'owner-2' },
            ]);

            expect(files.length).toBe(2);
            expect(files[0].name).toBe('a.txt');
            expect(files[1].name).toBe('b.txt');
        });
    });

    describe('updateOne', () => {
        it('should update a record', async () => {
            const created = await service.createOne<DbRecord>('file', {
                name: 'original.txt',
                owner: 'test-owner',
            });

            // Wait a bit to ensure different timestamp
            await new Promise((resolve) => setTimeout(resolve, 10));

            const updated = await service.updateOne<DbRecord>('file', created.id, {
                name: 'renamed.txt',
            });

            expect(updated.name).toBe('renamed.txt');
            expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(
                new Date(created.created_at).getTime()
            );
        });

        it('should throw for nonexistent record', async () => {
            await expect(service.updateOne('file', 'nonexistent', { name: 'test' })).rejects.toThrow(
                /not found/
            );
        });
    });

    describe('updateAny', () => {
        it('should update records matching filter', async () => {
            await service.createOne<DbRecord>('file', { name: 'update-test.txt', owner: 'owner-x' });
            await service.createOne<DbRecord>('file', { name: 'update-test2.txt', owner: 'owner-x' });

            const updated = await service.updateAny<DbRecord>(
                'file',
                { where: { owner: 'owner-x' } },
                { mimetype: 'text/plain' }
            );

            expect(updated.length).toBe(2);
            for (const file of updated) {
                expect(file.mimetype).toBe('text/plain');
            }
        });
    });

    describe('deleteOne', () => {
        it('should soft delete a record', async () => {
            const created = await service.createOne<DbRecord>('file', {
                name: 'delete-me.txt',
                owner: 'test-owner',
            });

            const deleted = await service.deleteOne<DbRecord>('file', created.id);
            expect(deleted.id).toBe(created.id);

            // Should not appear in normal queries
            const found = await service.selectOne<DbRecord>('file', { where: { id: created.id } });
            expect(found).toBeNull();
        });

        it('should still find with trashed option', async () => {
            const created = await service.createOne<DbRecord>('file', {
                name: 'delete-me.txt',
                owner: 'test-owner',
            });

            await service.deleteOne('file', created.id);

            const found = await service.selectAny<DbRecord>(
                'file',
                { where: { id: created.id } },
                { trashed: 'include' }
            );
            expect(found.length).toBe(1);
            expect(found[0].trashed_at).toBeTruthy();
        });
    });

    describe('deleteAny', () => {
        it('should delete records matching filter', async () => {
            await service.createOne<DbRecord>('file', { name: 'del-a.txt', owner: 'del-owner' });
            await service.createOne<DbRecord>('file', { name: 'del-b.txt', owner: 'del-owner' });

            const deleted = await service.deleteAny<DbRecord>('file', {
                where: { owner: 'del-owner' },
            });
            expect(deleted.length).toBe(2);

            const remaining = await service.selectAny<DbRecord>('file', {
                where: { owner: 'del-owner' },
            });
            expect(remaining.length).toBe(0);
        });
    });

    describe('revertOne', () => {
        it('should revert a soft-deleted record', async () => {
            const created = await service.createOne<DbRecord>('file', {
                name: 'revert-me.txt',
                owner: 'test-owner',
            });

            await service.deleteOne('file', created.id);

            // Verify it's deleted
            const deleted = await service.selectOne<DbRecord>('file', { where: { id: created.id } });
            expect(deleted).toBeNull();

            // Revert
            const reverted = await service.revertOne<DbRecord>('file', created.id);
            expect(reverted.trashed_at).toBeNull();

            // Should be visible again
            const found = await service.selectOne<DbRecord>('file', { where: { id: created.id } });
            expect(found).not.toBeNull();
        });
    });

    describe('expireOne', () => {
        it('should hard delete a record', async () => {
            const created = await service.createOne<DbRecord>('file', {
                name: 'expire-me.txt',
                owner: 'test-owner',
            });

            const expired = await service.expireOne<DbRecord>('file', created.id);
            expect(expired.id).toBe(created.id);

            // Should not be found even with trashed: include
            const found = await service.selectOne<DbRecord>(
                'file',
                { where: { id: created.id } },
                { trashed: 'include' }
            );
            expect(found).toBeNull();
        });
    });

    describe('upsertOne', () => {
        it('should create when record does not exist', async () => {
            const file = await service.upsertOne<DbRecord>('file', {
                name: 'upsert-new.txt',
                owner: 'test-owner',
            });

            expect(file.id).toBeTruthy();
            expect(file.name).toBe('upsert-new.txt');
        });

        it('should update when record exists', async () => {
            const created = await service.createOne<DbRecord>('file', {
                name: 'upsert-existing.txt',
                owner: 'test-owner',
            });

            const updated = await service.upsertOne<DbRecord>('file', {
                id: created.id,
                name: 'upsert-updated.txt',
                owner: 'test-owner',
            });

            expect(updated.id).toBe(created.id);
            expect(updated.name).toBe('upsert-updated.txt');
        });
    });

    describe('DatabaseOps streaming', () => {
        it('should stream records via getOps().selectAny', async () => {
            const records: DbRecord[] = [];
            for await (const record of service.getOps().selectAny<DbRecord>('models', { limit: 3 })) {
                records.push(record);
            }
            expect(records.length).toBe(3);
        });

        it('should stream created records', async () => {
            const inputs = [
                { name: 'stream-1.txt', owner: 'user-1' },
                { name: 'stream-2.txt', owner: 'user-2' },
            ];

            const created: DbRecord[] = [];
            for await (const record of service.getOps().createAll<DbRecord>('file', inputs)) {
                created.push(record);
            }

            expect(created.length).toBe(2);
            expect(created[0]?.name).toBe('stream-1.txt');
            expect(created[1]?.name).toBe('stream-2.txt');
        });
    });
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function createModelRow(overrides: Partial<ModelRow> = {}): ModelRow {
    return {
        id: 'test-id',
        model_name: 'test',
        status: 'active',
        description: null,
        sudo: 0,
        frozen: 0,
        immutable: 0,
        external: 0,
        passthrough: 0,
        ...overrides,
    };
}

function createFieldRow(overrides: Partial<FieldRow> = {}): FieldRow {
    return {
        id: 'field-id',
        model_name: 'test',
        field_name: 'field',
        type: 'text',
        is_array: 0,
        required: 0,
        default_value: null,
        minimum: null,
        maximum: null,
        pattern: null,
        enum_values: null,
        relationship_type: null,
        related_model: null,
        related_field: null,
        relationship_name: null,
        cascade_delete: 0,
        required_relationship: 0,
        immutable: 0,
        sudo: 0,
        unique_: 0,
        index_: 0,
        tracked: 0,
        searchable: 0,
        transform: null,
        description: null,
        ...overrides,
    };
}
