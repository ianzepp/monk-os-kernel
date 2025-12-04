/**
 * Ring 1: Constraints Observer Tests
 *
 * Tests for the Constraints observer which validates field data against
 * schema constraints (required, type, min/max, pattern, enum).
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Constraints } from '@src/ems/ring/1/index.js';
import { ObserverRing, EOBSINVALID } from '@src/ems/observers/index.js';
import type {
    ObserverContext,
    Model,
    ModelRecord,
    FieldRow,
    DatabaseAdapter,
    ModelCacheAdapter,
} from '@src/ems/observers/index.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockDatabase(): DatabaseAdapter {
    return {
        async execute(_sql: string, _params?: unknown[]): Promise<number> {
            return 1;
        },
        async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
            return [];
        },
        async exec(_sql: string): Promise<void> {},
        async transaction(_statements: Array<{ sql: string; params?: unknown[] }>): Promise<number[]> {
            return [];
        },
    };
}

function createMockCache(): ModelCacheAdapter {
    return {
        invalidate(_modelName: string): void {},
    };
}

function createFieldRow(overrides: Partial<FieldRow> = {}): FieldRow {
    return {
        field_name: 'test_field',
        type: 'text',
        is_array: false,
        required: false,
        default_value: null,
        minimum: null,
        maximum: null,
        pattern: null,
        enum_values: null,
        immutable: false,
        transform: null,
        ...overrides,
    };
}

function createMockModel(
    name = 'test_model',
    validationFields: FieldRow[] = []
): Model {
    return {
        modelName: name,
        isFrozen: false,
        isImmutable: false,
        requiresSudo: false,
        getImmutableFields: () => new Set(),
        getTrackedFields: () => new Set(),
        getTransformFields: () => new Map(),
        getValidationFields: () => validationFields,
        getFields: () => validationFields,
    };
}

function createMockRecord(
    oldData: Record<string, unknown> = {},
    newData: Record<string, unknown> = {}
): ModelRecord {
    const merged = { ...oldData, ...newData };
    const changedFields = Object.keys(newData);

    return {
        isNew: () => Object.keys(oldData).length === 0,
        old: (field: string) => oldData[field],
        get: (field: string) => merged[field],
        has: (field: string) => field in newData,
        set: (field: string, value: unknown) => {
            newData[field] = value;
            merged[field] = value;
        },
        getChangedFields: () => changedFields,
        toRecord: () => ({ ...merged }),
        toChanges: () => ({ ...newData }),
        getDiff: () => {
            const diff: Record<string, { old: unknown; new: unknown }> = {};
            for (const field of changedFields) {
                diff[field] = { old: oldData[field], new: newData[field] };
            }
            return diff;
        },
        getDiffForFields: (fields: Set<string>) => {
            const diff: Record<string, { old: unknown; new: unknown }> = {};
            for (const field of changedFields) {
                if (!fields.has(field)) continue;
                if (oldData[field] !== newData[field]) {
                    diff[field] = { old: oldData[field], new: newData[field] };
                }
            }
            return diff;
        },
    };
}

function createContext(
    operation: 'create' | 'update' | 'delete',
    model: Model,
    record: ModelRecord
): ObserverContext {
    return {
        system: {
            db: createMockDatabase(),
            cache: createMockCache(),
        },
        operation,
        model,
        record,
        recordIndex: 0,
        errors: [],
        warnings: [],
    };
}

// =============================================================================
// CONSTRAINTS OBSERVER TESTS
// =============================================================================

describe('Constraints', () => {
    let observer: Constraints;

    beforeEach(() => {
        observer = new Constraints();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('Constraints');
        });

        it('should be in Ring 1 (InputValidation)', () => {
            expect(observer.ring).toBe(ObserverRing.InputValidation);
        });

        it('should have priority 40', () => {
            expect(observer.priority).toBe(40);
        });

        it('should handle create and update operations', () => {
            expect(observer.operations).toContain('create');
            expect(observer.operations).toContain('update');
            expect(observer.operations).toHaveLength(2);
        });
    });

    describe('no validation fields', () => {
        it('should pass when model has no validation fields', async () => {
            const model = createMockModel('users', []);
            const record = createMockRecord({}, { name: 'Test' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });
    });

    describe('required constraint', () => {
        it('should fail when required field is null on create', async () => {
            const fields = [createFieldRow({ field_name: 'name', required: true })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { name: null });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should fail when required field is undefined on create', async () => {
            const fields = [createFieldRow({ field_name: 'name', required: true })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, {}); // name not present
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should pass when required field has value on create', async () => {
            const fields = [createFieldRow({ field_name: 'name', required: true })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { name: 'John' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should not check required on update if field not changed', async () => {
            const fields = [createFieldRow({ field_name: 'name', required: true })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({ id: '1', name: 'John' }, { status: 'active' });
            const ctx = createContext('update', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should include field name in error', async () => {
            const fields = [createFieldRow({ field_name: 'email', required: true })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { email: null });
            const ctx = createContext('create', model, record);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSINVALID);
                expect((err as EOBSINVALID).field).toBe('email');
                expect((err as EOBSINVALID).message).toContain('email');
                expect((err as EOBSINVALID).message).toContain('required');
            }
        });
    });

    describe('type constraint - text', () => {
        it('should pass for string value', async () => {
            const fields = [createFieldRow({ field_name: 'name', type: 'text' })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { name: 'John' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should fail for number value', async () => {
            const fields = [createFieldRow({ field_name: 'name', type: 'text' })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { name: 123 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should pass for null value (not required)', async () => {
            const fields = [createFieldRow({ field_name: 'name', type: 'text' })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { name: null });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });
    });

    describe('type constraint - integer', () => {
        it('should pass for integer value', async () => {
            const fields = [createFieldRow({ field_name: 'count', type: 'integer' })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { count: 42 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should fail for decimal value', async () => {
            const fields = [createFieldRow({ field_name: 'count', type: 'integer' })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { count: 42.5 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should fail for string value', async () => {
            const fields = [createFieldRow({ field_name: 'count', type: 'integer' })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { count: '42' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });
    });

    describe('type constraint - numeric', () => {
        it('should pass for integer value', async () => {
            const fields = [createFieldRow({ field_name: 'price', type: 'numeric' })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { price: 100 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should pass for decimal value', async () => {
            const fields = [createFieldRow({ field_name: 'price', type: 'numeric' })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { price: 99.99 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should fail for string value', async () => {
            const fields = [createFieldRow({ field_name: 'price', type: 'numeric' })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { price: '99.99' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });
    });

    describe('type constraint - boolean', () => {
        it('should pass for true', async () => {
            const fields = [createFieldRow({ field_name: 'active', type: 'boolean' })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { active: true });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should pass for false', async () => {
            const fields = [createFieldRow({ field_name: 'active', type: 'boolean' })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { active: false });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should fail for number 0', async () => {
            const fields = [createFieldRow({ field_name: 'active', type: 'boolean' })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { active: 0 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should fail for string "true"', async () => {
            const fields = [createFieldRow({ field_name: 'active', type: 'boolean' })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { active: 'true' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });
    });

    describe('type constraint - jsonb', () => {
        it('should pass for object', async () => {
            const fields = [createFieldRow({ field_name: 'data', type: 'jsonb' })];
            const model = createMockModel('configs', fields);
            const record = createMockRecord({}, { data: { key: 'value' } });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should pass for array', async () => {
            const fields = [createFieldRow({ field_name: 'data', type: 'jsonb' })];
            const model = createMockModel('configs', fields);
            const record = createMockRecord({}, { data: [1, 2, 3] });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should pass for string', async () => {
            const fields = [createFieldRow({ field_name: 'data', type: 'jsonb' })];
            const model = createMockModel('configs', fields);
            const record = createMockRecord({}, { data: 'plain string' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should pass for number', async () => {
            const fields = [createFieldRow({ field_name: 'data', type: 'jsonb' })];
            const model = createMockModel('configs', fields);
            const record = createMockRecord({}, { data: 42 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });
    });

    describe('type constraint - array', () => {
        it('should pass for array of correct type', async () => {
            const fields = [createFieldRow({ field_name: 'tags', type: 'text', is_array: true })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { tags: ['a', 'b', 'c'] });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should fail for non-array value', async () => {
            const fields = [createFieldRow({ field_name: 'tags', type: 'text', is_array: true })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { tags: 'not an array' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should fail for array with wrong element type', async () => {
            const fields = [createFieldRow({ field_name: 'tags', type: 'text', is_array: true })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { tags: ['a', 123, 'c'] });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should pass for empty array', async () => {
            const fields = [createFieldRow({ field_name: 'tags', type: 'text', is_array: true })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { tags: [] });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should pass for array of integers', async () => {
            const fields = [createFieldRow({ field_name: 'counts', type: 'integer', is_array: true })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { counts: [1, 2, 3] });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });
    });

    describe('minimum/maximum constraints', () => {
        it('should pass when value equals minimum', async () => {
            const fields = [createFieldRow({ field_name: 'age', type: 'integer', minimum: 18 })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { age: 18 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should pass when value equals maximum', async () => {
            const fields = [createFieldRow({ field_name: 'age', type: 'integer', maximum: 100 })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { age: 100 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should fail when value below minimum', async () => {
            const fields = [createFieldRow({ field_name: 'age', type: 'integer', minimum: 18 })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { age: 17 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should fail when value above maximum', async () => {
            const fields = [createFieldRow({ field_name: 'age', type: 'integer', maximum: 100 })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { age: 101 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should pass when value within range', async () => {
            const fields = [createFieldRow({ field_name: 'age', type: 'integer', minimum: 18, maximum: 100 })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { age: 50 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should work with numeric (decimal) values', async () => {
            const fields = [createFieldRow({ field_name: 'price', type: 'numeric', minimum: 0.01, maximum: 9999.99 })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { price: 99.99 });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should include constraint in error message', async () => {
            const fields = [createFieldRow({ field_name: 'age', type: 'integer', minimum: 18 })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { age: 10 });
            const ctx = createContext('create', model, record);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect((err as EOBSINVALID).message).toContain('>= 18');
            }
        });
    });

    describe('pattern constraint', () => {
        it('should pass when value matches pattern', async () => {
            const fields = [createFieldRow({ field_name: 'email', type: 'text', pattern: '^[^@]+@[^@]+$' })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { email: 'test@example.com' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should fail when value does not match pattern', async () => {
            const fields = [createFieldRow({ field_name: 'email', type: 'text', pattern: '^[^@]+@[^@]+$' })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { email: 'invalid-email' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should include pattern in error message', async () => {
            const fields = [createFieldRow({ field_name: 'code', type: 'text', pattern: '^[A-Z]{3}$' })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { code: 'abc' });
            const ctx = createContext('create', model, record);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect((err as EOBSINVALID).message).toContain('^[A-Z]{3}$');
            }
        });
    });

    describe('enum constraint', () => {
        it('should pass for valid enum value', async () => {
            const fields = [createFieldRow({ field_name: 'status', type: 'text', enum_values: '["pending","active","closed"]' })];
            const model = createMockModel('orders', fields);
            const record = createMockRecord({}, { status: 'active' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });

        it('should fail for invalid enum value', async () => {
            const fields = [createFieldRow({ field_name: 'status', type: 'text', enum_values: '["pending","active","closed"]' })];
            const model = createMockModel('orders', fields);
            const record = createMockRecord({}, { status: 'unknown' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).rejects.toThrow(EOBSINVALID);
        });

        it('should include allowed values in error message', async () => {
            const fields = [createFieldRow({ field_name: 'status', type: 'text', enum_values: '["a","b","c"]' })];
            const model = createMockModel('items', fields);
            const record = createMockRecord({}, { status: 'x' });
            const ctx = createContext('create', model, record);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect((err as EOBSINVALID).message).toContain('a, b, c');
            }
        });
    });

    describe('multiple fields', () => {
        it('should validate all fields and report first error', async () => {
            const fields = [
                createFieldRow({ field_name: 'name', type: 'text', required: true }),
                createFieldRow({ field_name: 'age', type: 'integer', minimum: 18 }),
            ];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { name: null, age: 10 });
            const ctx = createContext('create', model, record);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSINVALID);
                // First field with error
                expect((err as EOBSINVALID).field).toBe('name');
            }
        });

        it('should pass when all fields are valid', async () => {
            const fields = [
                createFieldRow({ field_name: 'name', type: 'text', required: true }),
                createFieldRow({ field_name: 'age', type: 'integer', minimum: 18, maximum: 100 }),
                createFieldRow({ field_name: 'status', type: 'text', enum_values: '["active","inactive"]' }),
            ];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { name: 'John', age: 25, status: 'active' });
            const ctx = createContext('create', model, record);

            await expect(observer.execute(ctx)).resolves.toBeUndefined();
        });
    });

    describe('error details', () => {
        it('should have correct error code', async () => {
            const fields = [createFieldRow({ field_name: 'name', required: true })];
            const model = createMockModel('users', fields);
            const record = createMockRecord({}, { name: null });
            const ctx = createContext('create', model, record);

            try {
                await observer.execute(ctx);
                expect.unreachable('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSINVALID);
                expect((err as EOBSINVALID).code).toBe('EOBSINVALID');
                expect((err as EOBSINVALID).errno).toBe(1001);
            }
        });
    });
});
