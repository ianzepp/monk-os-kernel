/**
 * Model Tests
 *
 * Tests for the Model class which wraps model metadata and provides
 * field accessors for the observer pipeline.
 */

import { describe, it, expect } from 'bun:test';
import { Model, type ModelRow, type FieldRow } from '@src/ems/model.js';

// =============================================================================
// TEST DATA FACTORIES
// =============================================================================

function createModelRow(overrides: Partial<ModelRow> = {}): ModelRow {
    return {
        id: 'model-uuid-123',
        model_name: 'test_model',
        status: 'active',
        description: 'Test model description',
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
        id: 'field-uuid-123',
        model_name: 'test_model',
        field_name: 'test_field',
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

// =============================================================================
// TESTS
// =============================================================================

describe('Model', () => {
    // =========================================================================
    // CONSTRUCTOR TESTS
    // =========================================================================

    describe('constructor', () => {
        it('should create model with row data', () => {
            const row = createModelRow({ model_name: 'invoice' });
            const model = new Model(row, []);

            expect(model.modelName).toBe('invoice');
            expect(model.row).toBe(row);
        });

        it('should create model with fields', () => {
            const row = createModelRow();
            const fields = [
                createFieldRow({ field_name: 'name' }),
                createFieldRow({ field_name: 'email' }),
            ];
            const model = new Model(row, fields);

            expect(model.fieldCount).toBe(2);
            expect(model.hasField('name')).toBe(true);
            expect(model.hasField('email')).toBe(true);
        });
    });

    // =========================================================================
    // MODEL IDENTITY TESTS
    // =========================================================================

    describe('modelName', () => {
        it('should return model name from row', () => {
            const model = new Model(createModelRow({ model_name: 'customer' }), []);

            expect(model.modelName).toBe('customer');
        });
    });

    describe('status', () => {
        it('should return status from row', () => {
            const model = new Model(createModelRow({ status: 'disabled' }), []);

            expect(model.status).toBe('disabled');
        });
    });

    describe('description', () => {
        it('should return description from row', () => {
            const model = new Model(createModelRow({ description: 'My model' }), []);

            expect(model.description).toBe('My model');
        });

        it('should return null if no description', () => {
            const model = new Model(createModelRow({ description: null }), []);

            expect(model.description).toBeNull();
        });
    });

    // =========================================================================
    // MODEL BEHAVIORAL FLAGS TESTS
    // =========================================================================

    describe('isSystem', () => {
        it('should return true for system status', () => {
            const model = new Model(createModelRow({ status: 'system' }), []);

            expect(model.isSystem).toBe(true);
        });

        it('should return false for active status', () => {
            const model = new Model(createModelRow({ status: 'active' }), []);

            expect(model.isSystem).toBe(false);
        });

        it('should return false for disabled status', () => {
            const model = new Model(createModelRow({ status: 'disabled' }), []);

            expect(model.isSystem).toBe(false);
        });
    });

    describe('isFrozen', () => {
        it('should return true when frozen=1', () => {
            const model = new Model(createModelRow({ frozen: 1 }), []);

            expect(model.isFrozen).toBe(true);
        });

        it('should return false when frozen=0', () => {
            const model = new Model(createModelRow({ frozen: 0 }), []);

            expect(model.isFrozen).toBe(false);
        });
    });

    describe('isImmutable', () => {
        it('should return true when immutable=1', () => {
            const model = new Model(createModelRow({ immutable: 1 }), []);

            expect(model.isImmutable).toBe(true);
        });

        it('should return false when immutable=0', () => {
            const model = new Model(createModelRow({ immutable: 0 }), []);

            expect(model.isImmutable).toBe(false);
        });
    });

    describe('requiresSudo', () => {
        it('should return true when sudo=1', () => {
            const model = new Model(createModelRow({ sudo: 1 }), []);

            expect(model.requiresSudo).toBe(true);
        });

        it('should return false when sudo=0', () => {
            const model = new Model(createModelRow({ sudo: 0 }), []);

            expect(model.requiresSudo).toBe(false);
        });
    });

    describe('isExternal', () => {
        it('should return true when external=1', () => {
            const model = new Model(createModelRow({ external: 1 }), []);

            expect(model.isExternal).toBe(true);
        });

        it('should return false when external=0', () => {
            const model = new Model(createModelRow({ external: 0 }), []);

            expect(model.isExternal).toBe(false);
        });
    });

    describe('isPassthrough', () => {
        it('should return true when passthrough=1', () => {
            const model = new Model(createModelRow({ passthrough: 1 }), []);

            expect(model.isPassthrough).toBe(true);
        });

        it('should return false when passthrough=0', () => {
            const model = new Model(createModelRow({ passthrough: 0 }), []);

            expect(model.isPassthrough).toBe(false);
        });
    });

    // =========================================================================
    // FIELD ACCESS TESTS
    // =========================================================================

    describe('getField', () => {
        it('should return field by name', () => {
            const nameField = createFieldRow({ field_name: 'name', type: 'text' });
            const model = new Model(createModelRow(), [nameField]);

            const field = model.getField('name');

            expect(field).toBe(nameField);
            expect(field?.type).toBe('text');
        });

        it('should return undefined for non-existent field', () => {
            const model = new Model(createModelRow(), []);

            expect(model.getField('nonexistent')).toBeUndefined();
        });
    });

    describe('hasField', () => {
        it('should return true for existing field', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'email' }),
            ]);

            expect(model.hasField('email')).toBe(true);
        });

        it('should return false for non-existent field', () => {
            const model = new Model(createModelRow(), []);

            expect(model.hasField('email')).toBe(false);
        });
    });

    describe('getFields', () => {
        it('should return all fields', () => {
            const fields = [
                createFieldRow({ field_name: 'a' }),
                createFieldRow({ field_name: 'b' }),
                createFieldRow({ field_name: 'c' }),
            ];
            const model = new Model(createModelRow(), fields);

            const result = model.getFields();

            expect(result).toHaveLength(3);
            expect(result).toContain(fields[0]);
            expect(result).toContain(fields[1]);
            expect(result).toContain(fields[2]);
        });

        it('should return empty array for model with no fields', () => {
            const model = new Model(createModelRow(), []);

            expect(model.getFields()).toEqual([]);
        });
    });

    describe('getFieldNames', () => {
        it('should return field names', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'alpha' }),
                createFieldRow({ field_name: 'beta' }),
            ]);

            const names = model.getFieldNames();

            expect(names).toHaveLength(2);
            expect(names).toContain('alpha');
            expect(names).toContain('beta');
        });
    });

    describe('fieldCount', () => {
        it('should return number of fields', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'a' }),
                createFieldRow({ field_name: 'b' }),
            ]);

            expect(model.fieldCount).toBe(2);
        });

        it('should return 0 for model with no fields', () => {
            const model = new Model(createModelRow(), []);

            expect(model.fieldCount).toBe(0);
        });
    });

    // =========================================================================
    // CATEGORIZED FIELD ACCESS TESTS
    // =========================================================================

    describe('getRequiredFields', () => {
        it('should return set of required field names', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'name', required: 1 }),
                createFieldRow({ field_name: 'email', required: 1 }),
                createFieldRow({ field_name: 'phone', required: 0 }),
            ]);

            const required = model.getRequiredFields();

            expect(required.size).toBe(2);
            expect(required.has('name')).toBe(true);
            expect(required.has('email')).toBe(true);
            expect(required.has('phone')).toBe(false);
        });

        it('should return empty set if no required fields', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'optional', required: 0 }),
            ]);

            expect(model.getRequiredFields().size).toBe(0);
        });
    });

    describe('getImmutableFields', () => {
        it('should return set of immutable field names', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'id', immutable: 1 }),
                createFieldRow({ field_name: 'created_at', immutable: 1 }),
                createFieldRow({ field_name: 'name', immutable: 0 }),
            ]);

            const immutable = model.getImmutableFields();

            expect(immutable.size).toBe(2);
            expect(immutable.has('id')).toBe(true);
            expect(immutable.has('created_at')).toBe(true);
            expect(immutable.has('name')).toBe(false);
        });
    });

    describe('getSudoFields', () => {
        it('should return set of sudo field names', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'admin_notes', sudo: 1 }),
                createFieldRow({ field_name: 'name', sudo: 0 }),
            ]);

            const sudo = model.getSudoFields();

            expect(sudo.size).toBe(1);
            expect(sudo.has('admin_notes')).toBe(true);
        });
    });

    describe('getTrackedFields', () => {
        it('should return set of tracked field names', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'balance', tracked: 1 }),
                createFieldRow({ field_name: 'status', tracked: 1 }),
                createFieldRow({ field_name: 'notes', tracked: 0 }),
            ]);

            const tracked = model.getTrackedFields();

            expect(tracked.size).toBe(2);
            expect(tracked.has('balance')).toBe(true);
            expect(tracked.has('status')).toBe(true);
        });
    });

    describe('getTransformFields', () => {
        it('should return map of field names to transforms', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'email', transform: 'lowercase' }),
                createFieldRow({ field_name: 'name', transform: 'trim' }),
                createFieldRow({ field_name: 'code', transform: 'uppercase' }),
                createFieldRow({ field_name: 'notes', transform: null }),
            ]);

            const transforms = model.getTransformFields();

            expect(transforms.size).toBe(3);
            expect(transforms.get('email')).toBe('lowercase');
            expect(transforms.get('name')).toBe('trim');
            expect(transforms.get('code')).toBe('uppercase');
            expect(transforms.has('notes')).toBe(false);
        });
    });

    describe('getValidationFields', () => {
        it('should return fields needing validation', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'age', type: 'integer', minimum: 0, maximum: 150 }),
                createFieldRow({ field_name: 'email', type: 'text', pattern: '^.+@.+$' }),
                createFieldRow({ field_name: 'status', type: 'text', enum_values: '["active","inactive"]' }),
                createFieldRow({ field_name: 'name', type: 'text', required: 1 }),
                createFieldRow({ field_name: 'notes', type: 'text' }), // No validation needed
            ]);

            const validation = model.getValidationFields();

            // age (integer type + range), email (pattern), status (enum), name (required)
            expect(validation.length).toBe(4);

            const names = validation.map(f => f.field_name);

            expect(names).toContain('age');
            expect(names).toContain('email');
            expect(names).toContain('status');
            expect(names).toContain('name');
            expect(names).not.toContain('notes');
        });
    });

    // =========================================================================
    // LAZY CATEGORIZATION TESTS
    // =========================================================================

    describe('isCategorized', () => {
        it('should return false before first access', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'name', required: 1 }),
            ]);

            expect(model.isCategorized()).toBe(false);
        });

        it('should return true after categorized access', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'name', required: 1 }),
            ]);

            // Trigger categorization
            model.getRequiredFields();

            expect(model.isCategorized()).toBe(true);
        });

        it('should only categorize once', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'name', required: 1, immutable: 1 }),
            ]);

            // Multiple accesses should reuse cached categories
            const required1 = model.getRequiredFields();
            const required2 = model.getRequiredFields();
            const immutable = model.getImmutableFields();

            expect(required1).toBe(required2); // Same Set instance
            expect(model.isCategorized()).toBe(true);
        });
    });

    // =========================================================================
    // COMPLEX MODEL TESTS
    // =========================================================================

    describe('complex model', () => {
        it('should handle model with all flags', () => {
            const model = new Model(
                createModelRow({
                    model_name: 'audit_log',
                    status: 'system',
                    frozen: 1,
                    immutable: 1,
                    sudo: 1,
                    external: 1,
                    passthrough: 1,
                }),
                [],
            );

            expect(model.isSystem).toBe(true);
            expect(model.isFrozen).toBe(true);
            expect(model.isImmutable).toBe(true);
            expect(model.requiresSudo).toBe(true);
            expect(model.isExternal).toBe(true);
            expect(model.isPassthrough).toBe(true);
        });

        it('should handle field with all flags', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({
                    field_name: 'sensitive_data',
                    required: 1,
                    immutable: 1,
                    sudo: 1,
                    tracked: 1,
                    transform: 'trim',
                }),
            ]);

            expect(model.getRequiredFields().has('sensitive_data')).toBe(true);
            expect(model.getImmutableFields().has('sensitive_data')).toBe(true);
            expect(model.getSudoFields().has('sensitive_data')).toBe(true);
            expect(model.getTrackedFields().has('sensitive_data')).toBe(true);
            expect(model.getTransformFields().get('sensitive_data')).toBe('trim');
        });
    });

    // =========================================================================
    // EDGE CASES - STUPID USER TESTS
    // =========================================================================

    describe('edge cases - model name variations', () => {
        it('should handle empty model name', () => {
            const model = new Model(createModelRow({ model_name: '' }), []);

            expect(model.modelName).toBe('');
        });

        it('should handle model name with special characters', () => {
            const model = new Model(createModelRow({ model_name: 'my-model_v2.0' }), []);

            expect(model.modelName).toBe('my-model_v2.0');
        });

        it('should handle model name with unicode', () => {
            const model = new Model(createModelRow({ model_name: '用户表' }), []);

            expect(model.modelName).toBe('用户表');
        });

        it('should handle very long model name', () => {
            const longName = 'a'.repeat(1000);
            const model = new Model(createModelRow({ model_name: longName }), []);

            expect(model.modelName).toBe(longName);
        });
    });

    describe('edge cases - field name variations', () => {
        it('should handle empty field name', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: '' }),
            ]);

            expect(model.hasField('')).toBe(true);
            expect(model.getField('')).toBeDefined();
        });

        it('should handle field name with dots', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'user.name' }),
            ]);

            expect(model.hasField('user.name')).toBe(true);
        });

        it('should handle field name with unicode', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: '名前' }),
            ]);

            expect(model.hasField('名前')).toBe(true);
        });

        it('should handle field name with emoji', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: '📧email' }),
            ]);

            expect(model.hasField('📧email')).toBe(true);
        });

        it('should handle duplicate field names (last wins)', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'dup', type: 'text' }),
                createFieldRow({ field_name: 'dup', type: 'integer' }),
            ]);

            // Map overwrites, so second one wins
            expect(model.getField('dup')?.type).toBe('integer');
            expect(model.fieldCount).toBe(1);
        });
    });

    describe('edge cases - flag value variations', () => {
        it('should treat 0 as false for boolean flags', () => {
            const model = new Model(createModelRow({
                frozen: 0,
                immutable: 0,
                sudo: 0,
                external: 0,
                passthrough: 0,
            }), []);

            expect(model.isFrozen).toBe(false);
            expect(model.isImmutable).toBe(false);
            expect(model.requiresSudo).toBe(false);
            expect(model.isExternal).toBe(false);
            expect(model.isPassthrough).toBe(false);
        });

        it('should treat any non-1 number as false for boolean flags', () => {
            const model = new Model(createModelRow({
                frozen: 2,
                immutable: -1,
                sudo: 100,
            }), []);

            expect(model.isFrozen).toBe(false);
            expect(model.isImmutable).toBe(false);
            expect(model.requiresSudo).toBe(false);
        });

        it('should handle field flags the same way', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'a', required: 0 }),
                createFieldRow({ field_name: 'b', required: 2 }),
                createFieldRow({ field_name: 'c', required: 1 }),
            ]);

            const required = model.getRequiredFields();

            expect(required.has('a')).toBe(false);
            expect(required.has('b')).toBe(false);
            expect(required.has('c')).toBe(true);
        });
    });

    describe('edge cases - status variations', () => {
        it('should only treat "system" as isSystem', () => {
            expect(new Model(createModelRow({ status: 'system' }), []).isSystem).toBe(true);
            expect(new Model(createModelRow({ status: 'SYSTEM' }), []).isSystem).toBe(false);
            expect(new Model(createModelRow({ status: 'System' }), []).isSystem).toBe(false);
            expect(new Model(createModelRow({ status: ' system' }), []).isSystem).toBe(false);
        });

        it('should handle unknown status values', () => {
            const model = new Model(createModelRow({ status: 'unknown_status' }), []);

            expect(model.status).toBe('unknown_status');
            expect(model.isSystem).toBe(false);
        });

        it('should handle empty status', () => {
            const model = new Model(createModelRow({ status: '' }), []);

            expect(model.status).toBe('');
            expect(model.isSystem).toBe(false);
        });
    });

    describe('edge cases - null and undefined handling', () => {
        it('should handle null description', () => {
            const model = new Model(createModelRow({ description: null }), []);

            expect(model.description).toBeNull();
        });

        it('should handle empty string description', () => {
            const model = new Model(createModelRow({ description: '' }), []);

            expect(model.description).toBe('');
        });

        it('should handle null transform', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'f', transform: null }),
            ]);

            expect(model.getTransformFields().has('f')).toBe(false);
        });

        it('should handle empty string transform', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'f', transform: '' }),
            ]);

            // Empty string is treated as falsy (no transform)
            // This is intentional - empty string means "no transform"
            expect(model.getTransformFields().has('f')).toBe(false);
        });
    });

    describe('edge cases - many fields', () => {
        it('should handle model with many fields', () => {
            const fields: ReturnType<typeof createFieldRow>[] = [];

            for (let i = 0; i < 500; i++) {
                fields.push(createFieldRow({
                    field_name: `field_${i}`,
                    required: i % 2,
                    immutable: i % 3 === 0 ? 1 : 0,
                }));
            }

            const model = new Model(createModelRow(), fields);

            expect(model.fieldCount).toBe(500);
            expect(model.hasField('field_0')).toBe(true);
            expect(model.hasField('field_499')).toBe(true);

            // Check categorization works with many fields
            const required = model.getRequiredFields();

            expect(required.size).toBe(250); // Half are required (odd indexes)
        });

        it('should handle model with no fields efficiently', () => {
            const model = new Model(createModelRow(), []);

            expect(model.getRequiredFields().size).toBe(0);
            expect(model.getImmutableFields().size).toBe(0);
            expect(model.getSudoFields().size).toBe(0);
            expect(model.getTrackedFields().size).toBe(0);
            expect(model.getTransformFields().size).toBe(0);
            expect(model.getValidationFields()).toHaveLength(0);
        });
    });

    describe('edge cases - validation fields', () => {
        it('should include integer type in validation fields', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'count', type: 'integer' }),
            ]);

            const validation = model.getValidationFields();

            expect(validation.map(f => f.field_name)).toContain('count');
        });

        it('should include numeric type in validation fields', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'price', type: 'numeric' }),
            ]);

            const validation = model.getValidationFields();

            expect(validation.map(f => f.field_name)).toContain('price');
        });

        it('should include boolean type in validation fields', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'active', type: 'boolean' }),
            ]);

            const validation = model.getValidationFields();

            expect(validation.map(f => f.field_name)).toContain('active');
        });

        it('should exclude plain text type from validation fields', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'notes', type: 'text', required: 0 }),
            ]);

            const validation = model.getValidationFields();

            expect(validation.map(f => f.field_name)).not.toContain('notes');
        });

        it('should include text with pattern in validation fields', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'email', type: 'text', pattern: '^.+@.+$' }),
            ]);

            const validation = model.getValidationFields();

            expect(validation.map(f => f.field_name)).toContain('email');
        });

        it('should include text with minimum in validation fields', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'age', type: 'text', minimum: 0 }),
            ]);

            const validation = model.getValidationFields();

            expect(validation.map(f => f.field_name)).toContain('age');
        });
    });

    describe('edge cases - categorization caching', () => {
        it('should return same Set instances on repeated calls', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'a', required: 1 }),
            ]);

            const req1 = model.getRequiredFields();
            const req2 = model.getRequiredFields();
            const imm1 = model.getImmutableFields();
            const imm2 = model.getImmutableFields();

            expect(req1).toBe(req2);
            expect(imm1).toBe(imm2);
        });

        it('should return same Map instance on repeated calls', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'a', transform: 'trim' }),
            ]);

            const trans1 = model.getTransformFields();
            const trans2 = model.getTransformFields();

            expect(trans1).toBe(trans2);
        });

        it('should return same Array instance on repeated calls', () => {
            const model = new Model(createModelRow(), [
                createFieldRow({ field_name: 'a', type: 'integer' }),
            ]);

            const val1 = model.getValidationFields();
            const val2 = model.getValidationFields();

            expect(val1).toBe(val2);
        });
    });

    describe('edge cases - row access', () => {
        it('should expose raw row for advanced use', () => {
            const row = createModelRow({ model_name: 'test' });
            const model = new Model(row, []);

            expect(model.row).toBe(row);
            expect(model.row.model_name).toBe('test');
        });

        it('should not prevent row modification (user responsibility)', () => {
            const row = createModelRow({ model_name: 'original' });
            const model = new Model(row, []);

            // User could modify row (bad practice but possible)
            row.model_name = 'modified';

            // Model reflects the change (no defensive copy)
            expect(model.modelName).toBe('modified');
        });
    });
});
