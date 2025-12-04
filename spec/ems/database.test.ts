/**
 * Model Layer - Phase 3/3.5 Tests
 *
 * Tests for Model, ModelRecord, ModelCache, Filter, and DatabaseService classes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunHAL } from '@src/hal/index.js';
import { createDatabase, type DatabaseConnection } from '@src/ems/connection.js';
import { Model, type ModelRow, type FieldRow } from '@src/ems/model.js';
import { ModelRecord } from '@src/ems/model-record.js';
import { ModelCache } from '@src/ems/model-cache.js';
import { Filter } from '@src/ems/filter.js';
import { FilterOp, type FilterData } from '@src/ems/filter-types.js';
import { DatabaseService, type DbRecord } from '@src/ems/database.js';
import { createObserverRunner } from '@src/ems/observers/registry.js';

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
    // -------------------------------------------------------------------------
    // Comparison Operators
    // -------------------------------------------------------------------------

    describe('comparison operators', () => {
        it('should handle implicit $eq', () => {
            const filter = new Filter('file').where({ status: 'active' });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND status = ?');
            expect(params).toEqual(['active']);
        });

        it('should handle explicit $eq', () => {
            const filter = new Filter('file').where({ status: { $eq: 'active' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND status = ?');
            expect(params).toEqual(['active']);
        });

        it('should handle $ne', () => {
            const filter = new Filter('file').where({ status: { $ne: 'deleted' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND status != ?');
            expect(params).toEqual(['deleted']);
        });

        it('should handle $gt', () => {
            const filter = new Filter('file').where({ size: { $gt: 1000 } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND size > ?');
            expect(params).toEqual([1000]);
        });

        it('should handle $gte', () => {
            const filter = new Filter('file').where({ size: { $gte: 1000 } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND size >= ?');
            expect(params).toEqual([1000]);
        });

        it('should handle $lt', () => {
            const filter = new Filter('file').where({ size: { $lt: 1000 } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND size < ?');
            expect(params).toEqual([1000]);
        });

        it('should handle $lte', () => {
            const filter = new Filter('file').where({ size: { $lte: 1000 } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND size <= ?');
            expect(params).toEqual([1000]);
        });

        it('should handle multiple operators on same field', () => {
            const filter = new Filter('file').where({ size: { $gte: 100, $lte: 1000 } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND size >= ? AND size <= ?');
            expect(params).toEqual([100, 1000]);
        });
    });

    // -------------------------------------------------------------------------
    // Null Handling
    // -------------------------------------------------------------------------

    describe('null handling', () => {
        it('should handle implicit null (field: null)', () => {
            const filter = new Filter('file').where({ parent: null });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND parent IS NULL');
            expect(params).toEqual([]);
        });

        it('should handle $eq null', () => {
            const filter = new Filter('file').where({ parent: { $eq: null } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND parent IS NULL');
            expect(params).toEqual([]);
        });

        it('should handle $ne null', () => {
            const filter = new Filter('file').where({ parent: { $ne: null } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND parent IS NOT NULL');
            expect(params).toEqual([]);
        });
    });

    // -------------------------------------------------------------------------
    // Pattern Matching Operators
    // -------------------------------------------------------------------------

    describe('pattern matching operators', () => {
        it('should handle $like', () => {
            const filter = new Filter('file').where({ name: { $like: 'test%' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND name LIKE ?');
            expect(params).toEqual(['test%']);
        });

        it('should handle $ilike (case-insensitive)', () => {
            const filter = new Filter('file').where({ name: { $ilike: 'TEST%' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND LOWER(name) LIKE LOWER(?)');
            expect(params).toEqual(['test%']); // lowercased
        });

        it('should handle $nlike', () => {
            const filter = new Filter('file').where({ name: { $nlike: '%tmp%' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND name NOT LIKE ?');
            expect(params).toEqual(['%tmp%']);
        });

        it('should handle $nilike (case-insensitive NOT LIKE)', () => {
            const filter = new Filter('file').where({ name: { $nilike: '%TMP%' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND LOWER(name) NOT LIKE LOWER(?)');
            expect(params).toEqual(['%tmp%']); // lowercased
        });
    });

    // -------------------------------------------------------------------------
    // Array Membership Operators
    // -------------------------------------------------------------------------

    describe('array membership operators', () => {
        it('should handle $in', () => {
            const filter = new Filter('file').where({ status: { $in: ['a', 'b', 'c'] } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND status IN (?, ?, ?)');
            expect(params).toEqual(['a', 'b', 'c']);
        });

        it('should handle empty $in (INV-5: generates FALSE)', () => {
            const filter = new Filter('file').where({ status: { $in: [] } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND 0=1');
            expect(params).toEqual([]);
        });

        it('should handle $nin', () => {
            const filter = new Filter('file').where({ status: { $nin: ['deleted', 'archived'] } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND status NOT IN (?, ?)');
            expect(params).toEqual(['deleted', 'archived']);
        });

        it('should handle empty $nin (INV-5: generates TRUE)', () => {
            const filter = new Filter('file').where({ status: { $nin: [] } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND 1=1');
            expect(params).toEqual([]);
        });
    });

    // -------------------------------------------------------------------------
    // Logical Operators
    // -------------------------------------------------------------------------

    describe('logical operators', () => {
        it('should handle $and', () => {
            const filter = new Filter('file').where({
                $and: [{ status: 'active' }, { size: { $gt: 0 } }],
            });
            const { sql, params } = filter.toSQL();

            expect(sql).toContain('(status = ? AND size > ?)');
            expect(params).toEqual(['active', 0]);
        });

        it('should handle $or', () => {
            const filter = new Filter('file').where({
                $or: [{ status: 'a' }, { status: 'b' }],
            });
            const { sql, params } = filter.toSQL();

            expect(sql).toContain('(status = ? OR status = ?)');
            expect(params).toEqual(['a', 'b']);
        });

        it('should handle $not', () => {
            const filter = new Filter('file').where({
                $not: { status: 'deleted' },
            });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND NOT (status = ?)');
            expect(params).toEqual(['deleted']);
        });

        it('should handle nested logical operators', () => {
            const filter = new Filter('file').where({
                $and: [
                    { status: 'active' },
                    { $or: [{ owner: 'user-1' }, { owner: 'user-2' }] },
                ],
            });
            const { sql, params } = filter.toSQL();

            expect(sql).toContain('(status = ? AND (owner = ? OR owner = ?))');
            expect(params).toEqual(['active', 'user-1', 'user-2']);
        });

        it('should handle empty $and (no conditions)', () => {
            const filter = new Filter('file').where({ $and: [] });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL');
            expect(params).toEqual([]);
        });

        it('should handle empty $or (no conditions)', () => {
            const filter = new Filter('file').where({ $or: [] });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL');
            expect(params).toEqual([]);
        });
    });

    // -------------------------------------------------------------------------
    // Range Operator
    // -------------------------------------------------------------------------

    describe('range operator', () => {
        it('should handle $between', () => {
            const filter = new Filter('file').where({ size: { $between: [100, 1000] } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND size BETWEEN ? AND ?');
            expect(params).toEqual([100, 1000]);
        });

        it('should handle $between with dates', () => {
            const start = '2024-01-01';
            const end = '2024-12-31';
            const filter = new Filter('file').where({ created_at: { $between: [start, end] } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND created_at BETWEEN ? AND ?');
            expect(params).toEqual([start, end]);
        });
    });

    // -------------------------------------------------------------------------
    // Null/Existence Operators
    // -------------------------------------------------------------------------

    describe('null/existence operators', () => {
        it('should handle $exists: true (IS NOT NULL)', () => {
            const filter = new Filter('file').where({ email: { $exists: true } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND email IS NOT NULL');
            expect(params).toEqual([]);
        });

        it('should handle $exists: false (IS NULL)', () => {
            const filter = new Filter('file').where({ email: { $exists: false } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND email IS NULL');
            expect(params).toEqual([]);
        });

        it('should handle $null: true (IS NULL)', () => {
            const filter = new Filter('file').where({ deleted_at: { $null: true } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND deleted_at IS NULL');
            expect(params).toEqual([]);
        });

        it('should handle $null: false (IS NOT NULL)', () => {
            const filter = new Filter('file').where({ deleted_at: { $null: false } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND deleted_at IS NOT NULL');
            expect(params).toEqual([]);
        });
    });

    // -------------------------------------------------------------------------
    // $neq Operator (alias for $ne)
    // -------------------------------------------------------------------------

    describe('$neq operator', () => {
        it('should handle $neq as alias for $ne', () => {
            const filter = new Filter('file').where({ status: { $neq: 'deleted' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND status != ?');
            expect(params).toEqual(['deleted']);
        });

        it('should handle $neq null', () => {
            const filter = new Filter('file').where({ parent: { $neq: null } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND parent IS NOT NULL');
            expect(params).toEqual([]);
        });
    });

    // -------------------------------------------------------------------------
    // Regex Operators
    // -------------------------------------------------------------------------

    describe('regex operators', () => {
        it('should handle $regex', () => {
            const filter = new Filter('file').where({ name: { $regex: '^test.*\\.txt$' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND name REGEXP ?');
            expect(params).toEqual(['^test.*\\.txt$']);
        });

        it('should handle $nregex', () => {
            const filter = new Filter('file').where({ name: { $nregex: '^temp' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND name NOT REGEXP ?');
            expect(params).toEqual(['^temp']);
        });
    });

    // -------------------------------------------------------------------------
    // Text Search Operators ($find, $text)
    // -------------------------------------------------------------------------

    describe('text search operators', () => {
        it('should handle $find (case-insensitive contains)', () => {
            const filter = new Filter('file').where({ description: { $find: 'important' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND LOWER(description) LIKE ?');
            expect(params).toEqual(['%important%']);
        });

        it('should handle $text as alias for $find', () => {
            const filter = new Filter('file').where({ description: { $text: 'URGENT' } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND LOWER(description) LIKE ?');
            expect(params).toEqual(['%urgent%']); // lowercased
        });
    });

    // -------------------------------------------------------------------------
    // $size Operator (JSON array length)
    // -------------------------------------------------------------------------

    describe('$size operator', () => {
        it('should handle $size with simple equality', () => {
            const filter = new Filter('file').where({ tags: { $size: 3 } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND json_array_length(tags) = ?');
            expect(params).toEqual([3]);
        });

        it('should handle $size with $gte', () => {
            const filter = new Filter('file').where({ tags: { $size: { $gte: 1 } } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND json_array_length(tags) >= ?');
            expect(params).toEqual([1]);
        });

        it('should handle $size with $lt', () => {
            const filter = new Filter('file').where({ tags: { $size: { $lt: 10 } } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND json_array_length(tags) < ?');
            expect(params).toEqual([10]);
        });

        it('should handle $size with $eq', () => {
            const filter = new Filter('file').where({ tags: { $size: { $eq: 0 } } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND json_array_length(tags) = ?');
            expect(params).toEqual([0]);
        });

        it('should handle $size with $ne', () => {
            const filter = new Filter('file').where({ tags: { $size: { $ne: 0 } } });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND json_array_length(tags) != ?');
            expect(params).toEqual([0]);
        });

        it('should throw for unsupported nested operator in $size', () => {
            const filter = new Filter('file');
            expect(() =>
                filter.where({ tags: { $size: { $like: 'test' } } }).toSQL()
            ).toThrow(/Unsupported operator for \$size/);
        });
    });

    // -------------------------------------------------------------------------
    // $nand and $nor Operators
    // -------------------------------------------------------------------------

    describe('$nand operator', () => {
        it('should handle $nand (NOT AND)', () => {
            const filter = new Filter('file').where({
                $nand: [{ status: 'active' }, { owner: 'admin' }],
            });
            const { sql, params } = filter.toSQL();

            expect(sql).toContain('NOT (status = ? AND owner = ?)');
            expect(params).toEqual(['active', 'admin']);
        });

        it('should handle empty $nand', () => {
            const filter = new Filter('file').where({ $nand: [] });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL');
            expect(params).toEqual([]);
        });
    });

    describe('$nor operator', () => {
        it('should handle $nor (NOT OR)', () => {
            const filter = new Filter('file').where({
                $nor: [{ status: 'deleted' }, { status: 'archived' }],
            });
            const { sql, params } = filter.toSQL();

            expect(sql).toContain('NOT (status = ? OR status = ?)');
            expect(params).toEqual(['deleted', 'archived']);
        });

        it('should handle empty $nor', () => {
            const filter = new Filter('file').where({ $nor: [] });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL');
            expect(params).toEqual([]);
        });
    });

    // -------------------------------------------------------------------------
    // Basic Queries (original tests)
    // -------------------------------------------------------------------------

    describe('basic queries', () => {
        it('should generate simple SELECT', () => {
            const filter = new Filter('file');
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL');
            expect(params).toEqual([]);
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

    // -------------------------------------------------------------------------
    // select() Method - Field Selection
    // -------------------------------------------------------------------------

    describe('select() method', () => {
        it('should select specific fields', () => {
            const filter = new Filter('file').select('id', 'name', 'status');
            const { sql } = filter.toSQL();

            expect(sql).toBe('SELECT id, name, status FROM file WHERE trashed_at IS NULL');
        });

        it('should default to * when no fields specified', () => {
            const filter = new Filter('file').select();
            const { sql } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL');
        });

        it('should default to * when * is included', () => {
            const filter = new Filter('file').select('id', '*', 'name');
            const { sql } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL');
        });
    });

    // -------------------------------------------------------------------------
    // andWhere() Method - Additive Conditions
    // -------------------------------------------------------------------------

    describe('andWhere() method', () => {
        it('should add conditions to empty where', () => {
            const filter = new Filter('file').andWhere({ status: 'active' });
            const { sql, params } = filter.toSQL();

            expect(sql).toBe('SELECT * FROM file WHERE trashed_at IS NULL AND status = ?');
            expect(params).toEqual(['active']);
        });

        it('should combine with existing where via $and', () => {
            const filter = new Filter('file')
                .where({ status: 'active' })
                .andWhere({ owner: 'user-1' });
            const { sql, params } = filter.toSQL();

            expect(sql).toContain('(status = ? AND owner = ?)');
            expect(params).toEqual(['active', 'user-1']);
        });

        it('should chain multiple andWhere calls', () => {
            const filter = new Filter('file')
                .andWhere({ status: 'active' })
                .andWhere({ owner: 'user-1' })
                .andWhere({ size: { $gt: 0 } });
            const { sql, params } = filter.toSQL();

            expect(sql).toContain('status = ?');
            expect(sql).toContain('owner = ?');
            expect(sql).toContain('size > ?');
            expect(params).toEqual(['active', 'user-1', 0]);
        });
    });

    // -------------------------------------------------------------------------
    // toWhereSQL() Method - WHERE Clause Only
    // -------------------------------------------------------------------------

    describe('toWhereSQL() method', () => {
        it('should return WHERE clause without keyword', () => {
            const filter = new Filter('file').where({ status: 'active' });
            const { clause, params } = filter.toWhereSQL();

            expect(clause).toBe('trashed_at IS NULL AND status = ?');
            expect(params).toEqual(['active']);
        });

        it('should return 1=1 for empty conditions', () => {
            const filter = new Filter('file').trashed('include');
            const { clause, params } = filter.toWhereSQL();

            expect(clause).toBe('1=1');
            expect(params).toEqual([]);
        });
    });

    // -------------------------------------------------------------------------
    // SQL Injection Validation
    // -------------------------------------------------------------------------

    describe('SQL injection validation', () => {
        it('should reject invalid table names', () => {
            expect(() => new Filter('table; DROP TABLE users')).toThrow(/Invalid table name/);
        });

        it('should reject table names starting with numbers', () => {
            expect(() => new Filter('123table')).toThrow(/Invalid table name/);
        });

        it('should reject table names with special characters', () => {
            expect(() => new Filter('table$name')).toThrow(/Invalid table name/);
        });

        it('should allow valid table names with underscores', () => {
            const filter = new Filter('my_table_name');
            const { sql } = filter.toSQL();
            expect(sql).toContain('FROM my_table_name');
        });

        it('should allow qualified table names with dots', () => {
            const filter = new Filter('schema.table');
            const { sql } = filter.toSQL();
            expect(sql).toContain('FROM schema.table');
        });

        it('should reject invalid field names in where', () => {
            const filter = new Filter('file');
            expect(() => filter.where({ 'field; DROP TABLE': 'value' }).toSQL()).toThrow(
                /Invalid field name/
            );
        });

        it('should reject invalid field names in select', () => {
            const filter = new Filter('file');
            expect(() => filter.select('valid', 'invalid--field')).toThrow(/Invalid field name/);
        });

        it('should reject invalid field names in order', () => {
            const filter = new Filter('file');
            expect(() => filter.order([{ field: 'field; DROP', sort: 'asc' }])).toThrow(
                /Invalid order field/
            );
        });
    });

    // -------------------------------------------------------------------------
    // String Order Parsing
    // -------------------------------------------------------------------------

    describe('string order parsing', () => {
        it('should parse simple field name (default asc)', () => {
            const filter = new Filter('file').order('name');
            const { sql } = filter.toSQL();

            expect(sql).toContain('ORDER BY name ASC');
        });

        it('should parse "field asc"', () => {
            const filter = new Filter('file').order('name asc');
            const { sql } = filter.toSQL();

            expect(sql).toContain('ORDER BY name ASC');
        });

        it('should parse "field desc"', () => {
            const filter = new Filter('file').order('name desc');
            const { sql } = filter.toSQL();

            expect(sql).toContain('ORDER BY name DESC');
        });

        it('should parse "field DESC" (case insensitive)', () => {
            const filter = new Filter('file').order('name DESC');
            const { sql } = filter.toSQL();

            expect(sql).toContain('ORDER BY name DESC');
        });

        it('should parse array of string orders', () => {
            const filter = new Filter('file').order(['status desc', 'name asc']);
            const { sql } = filter.toSQL();

            expect(sql).toContain('ORDER BY status DESC, name ASC');
        });

        it('should handle mixed string and object orders', () => {
            const filter = new Filter('file').order([
                'status desc',
                { field: 'name', sort: 'asc' },
            ]);
            const { sql } = filter.toSQL();

            expect(sql).toContain('ORDER BY status DESC, name ASC');
        });

        it('should skip empty strings in order array', () => {
            const filter = new Filter('file').order(['name', '', 'status']);
            const { sql } = filter.toSQL();

            expect(sql).toContain('ORDER BY name ASC, status ASC');
        });
    });

    // -------------------------------------------------------------------------
    // Unknown Operator
    // -------------------------------------------------------------------------

    describe('unknown operator', () => {
        it('should throw for unknown operator', () => {
            const filter = new Filter('file');
            expect(() =>
                filter.where({ status: { $unknown: 'value' } as unknown as Record<string, unknown> }).toSQL()
            ).toThrow(/Unknown filter operator/);
        });
    });

    // -------------------------------------------------------------------------
    // Idempotency (INV-4)
    // -------------------------------------------------------------------------

    describe('idempotency (INV-4)', () => {
        it('should generate identical SQL on multiple calls', () => {
            const filter = new Filter('file')
                .where({ status: 'active', size: { $gt: 100 } })
                .order('name desc')
                .limit(10);

            const result1 = filter.toSQL();
            const result2 = filter.toSQL();
            const result3 = filter.toSQL();

            expect(result1.sql).toBe(result2.sql);
            expect(result2.sql).toBe(result3.sql);
            expect(result1.params).toEqual(result2.params);
            expect(result2.params).toEqual(result3.params);
        });
    });
});

// =============================================================================
// DATABASE SERVICE TESTS
// =============================================================================

describe('DatabaseService', () => {
    let cache: ModelCache;
    let service: DatabaseService;

    beforeEach(async () => {
        cache = new ModelCache(db);
        // Use createObserverRunner() to get Ring 5 observers for SQL execution
        const runner = createObserverRunner();
        service = new DatabaseService(db, cache, runner);
    });

    describe('selectAny', () => {
        it('should select all records', async () => {
            const models = await service.selectAny<DbRecord>('models');
            expect(models.length).toBe(9); // 3 meta + 6 VFS
        });

        it('should filter with where clause', async () => {
            const models = await service.selectAny<DbRecord>('models', {
                where: { status: 'system' },
            });
            expect(models.length).toBe(9);
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
            expect(count).toBe(9);
        });

        it('should count with filter', async () => {
            const count = await service.count('fields', { where: { model_name: 'file' } });
            expect(count).toBeGreaterThan(0);
        });
    });

    describe('createOne', () => {
        it('should create a file record', async () => {
            const file = await service.createOne<DbRecord>('file', {
                pathname: 'test.txt',
                owner: 'test-owner',
            });

            expect(file.id).toBeTruthy();
            expect(file.owner).toBe('test-owner');
            expect(file.created_at).toBeTruthy();
            expect(file.updated_at).toBeTruthy();
        });

        it('should generate ID if not provided', async () => {
            const file = await service.createOne<DbRecord>('file', {
                pathname: 'test.txt',
                owner: 'test-owner',
            });
            expect(file.id).toMatch(/^[0-9a-f]{32}$/);
        });

        it('should use provided ID', async () => {
            const customId = 'custom123456789012345678901234';
            const file = await service.createOne<DbRecord>('file', {
                id: customId,
                pathname: 'test.txt',
                owner: 'test-owner',
            });
            expect(file.id).toBe(customId);
        });
    });

    describe('createAll', () => {
        it('should create multiple records', async () => {
            const files = await service.createAll<DbRecord>('file', [
                { pathname: 'a.txt', owner: 'owner-1' },
                { pathname: 'b.txt', owner: 'owner-2' },
            ]);

            expect(files.length).toBe(2);
            expect(files[0].owner).toBe('owner-1');
            expect(files[1].owner).toBe('owner-2');
        });
    });

    describe('updateOne', () => {
        it('should update a record', async () => {
            const created = await service.createOne<DbRecord>('file', {
                pathname: 'original.txt',
                owner: 'test-owner',
            });

            // Wait a bit to ensure different timestamp
            await new Promise((resolve) => setTimeout(resolve, 10));

            const updated = await service.updateOne<DbRecord>('file', created.id, {
                mimetype: 'text/plain',
            });

            expect(updated.mimetype).toBe('text/plain');
            expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(
                new Date(created.created_at).getTime()
            );
        });

        it('should throw for nonexistent record', async () => {
            await expect(service.updateOne('file', 'nonexistent', { mimetype: 'test' })).rejects.toThrow(
                /not found/
            );
        });
    });

    describe('updateAny', () => {
        it('should update records matching filter', async () => {
            await service.createOne<DbRecord>('file', { pathname: 'update-test.txt', owner: 'owner-x' });
            await service.createOne<DbRecord>('file', { pathname: 'update-test2.txt', owner: 'owner-x' });

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
                pathname: 'delete-me.txt',
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
                pathname: 'delete-me.txt',
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
            await service.createOne<DbRecord>('file', { pathname: 'del-a.txt', owner: 'del-owner' });
            await service.createOne<DbRecord>('file', { pathname: 'del-b.txt', owner: 'del-owner' });

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
                pathname: 'revert-me.txt',
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
                pathname: 'expire-me.txt',
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
                pathname: 'upsert-new.txt',
                owner: 'test-owner',
            });

            expect(file.id).toBeTruthy();
            expect(file.owner).toBe('test-owner');
        });

        it('should update when record exists', async () => {
            const created = await service.createOne<DbRecord>('file', {
                pathname: 'upsert-existing.txt',
                owner: 'test-owner',
            });

            const updated = await service.upsertOne<DbRecord>('file', {
                id: created.id,
                pathname: 'upsert-existing.txt',
                owner: 'updated-owner',
            });

            expect(updated.id).toBe(created.id);
            expect(updated.owner).toBe('updated-owner');
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
                { pathname: 'stream-1.txt', owner: 'user-1' },
                { pathname: 'stream-2.txt', owner: 'user-2' },
            ];

            const created: DbRecord[] = [];
            for await (const record of service.getOps().createAll<DbRecord>('file', inputs)) {
                created.push(record);
            }

            expect(created.length).toBe(2);
            expect(created[0]?.owner).toBe('user-1');
            expect(created[1]?.owner).toBe('user-2');
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
