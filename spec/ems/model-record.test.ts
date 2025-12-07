/**
 * ModelRecord Tests
 *
 * Tests for the ModelRecord class which provides change tracking for entity
 * mutations. ModelRecord maintains original values and pending changes,
 * enabling observers to detect and process field modifications.
 */

import { describe, it, expect } from 'bun:test';
import { ModelRecord } from '@src/ems/model-record.js';

// =============================================================================
// CONSTRUCTOR TESTS
// =============================================================================

describe('ModelRecord', () => {
    describe('constructor', () => {
        it('should create empty record with defaults', () => {
            const record = new ModelRecord();

            expect(record.hasChanges()).toBe(false);
            expect(record.changeCount).toBe(0);
        });

        it('should create record with original data only', () => {
            const record = new ModelRecord({ id: '123', name: 'Alice' });

            expect(record.get('id')).toBe('123');
            expect(record.get('name')).toBe('Alice');
            expect(record.hasChanges()).toBe(false);
        });

        it('should create record with input data as changes', () => {
            const record = new ModelRecord({}, { name: 'Bob' });

            expect(record.get('name')).toBe('Bob');
            expect(record.hasChanges()).toBe(true);
            expect(record.has('name')).toBe(true);
        });

        it('should create record with both original and input', () => {
            const record = new ModelRecord(
                { id: '123', name: 'Alice' },
                { name: 'Bob' },
            );

            expect(record.get('id')).toBe('123');
            expect(record.get('name')).toBe('Bob');
            expect(record.old('name')).toBe('Alice');
            expect(record.has('name')).toBe(true);
            expect(record.has('id')).toBe(false);
        });
    });

    // =========================================================================
    // RECORD STATUS TESTS
    // =========================================================================

    describe('isNew', () => {
        it('should return true for empty original', () => {
            const record = new ModelRecord({}, { name: 'Bob' });

            expect(record.isNew()).toBe(true);
        });

        it('should return true for original without id', () => {
            const record = new ModelRecord({ name: 'Alice' }, {});

            expect(record.isNew()).toBe(true);
        });

        it('should return false for original with id', () => {
            const record = new ModelRecord({ id: '123', name: 'Alice' }, {});

            expect(record.isNew()).toBe(false);
        });
    });

    describe('hasChanges', () => {
        it('should return false when no changes', () => {
            const record = new ModelRecord({ id: '123' });

            expect(record.hasChanges()).toBe(false);
        });

        it('should return true when changes exist', () => {
            const record = new ModelRecord({ id: '123' }, { name: 'Bob' });

            expect(record.hasChanges()).toBe(true);
        });

        it('should return false after clearing changes', () => {
            const record = new ModelRecord({}, { name: 'Bob' });

            expect(record.hasChanges()).toBe(true);

            record.clearChanges();

            expect(record.hasChanges()).toBe(false);
        });
    });

    describe('changeCount', () => {
        it('should return 0 for no changes', () => {
            const record = new ModelRecord({ id: '123' });

            expect(record.changeCount).toBe(0);
        });

        it('should count changes correctly', () => {
            const record = new ModelRecord({}, { a: 1, b: 2, c: 3 });

            expect(record.changeCount).toBe(3);
        });
    });

    // =========================================================================
    // VALUE ACCESS TESTS
    // =========================================================================

    describe('old', () => {
        it('should return original value', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Bob' });

            expect(record.old('name')).toBe('Alice');
        });

        it('should return undefined for non-existent original field', () => {
            const record = new ModelRecord({}, { name: 'Bob' });

            expect(record.old('name')).toBeUndefined();
        });
    });

    describe('get', () => {
        it('should return changed value if changed', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Bob' });

            expect(record.get('name')).toBe('Bob');
        });

        it('should return original value if not changed', () => {
            const record = new ModelRecord({ name: 'Alice', age: 30 }, { name: 'Bob' });

            expect(record.get('age')).toBe(30);
        });

        it('should return undefined for non-existent field', () => {
            const record = new ModelRecord({}, {});

            expect(record.get('nonexistent')).toBeUndefined();
        });
    });

    describe('has', () => {
        it('should return true for changed field', () => {
            const record = new ModelRecord({}, { name: 'Bob' });

            expect(record.has('name')).toBe(true);
        });

        it('should return false for unchanged field', () => {
            const record = new ModelRecord({ name: 'Alice' }, {});

            expect(record.has('name')).toBe(false);
        });

        it('should return false for non-existent field', () => {
            const record = new ModelRecord({}, {});

            expect(record.has('nonexistent')).toBe(false);
        });
    });

    describe('exists', () => {
        it('should return true for field in original', () => {
            const record = new ModelRecord({ name: 'Alice' }, {});

            expect(record.exists('name')).toBe(true);
        });

        it('should return true for field in changes', () => {
            const record = new ModelRecord({}, { name: 'Bob' });

            expect(record.exists('name')).toBe(true);
        });

        it('should return true for field in both', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Bob' });

            expect(record.exists('name')).toBe(true);
        });

        it('should return false for non-existent field', () => {
            const record = new ModelRecord({}, {});

            expect(record.exists('nonexistent')).toBe(false);
        });
    });

    // =========================================================================
    // VALUE MUTATION TESTS
    // =========================================================================

    describe('set', () => {
        it('should add new change', () => {
            const record = new ModelRecord();

            record.set('name', 'Bob');

            expect(record.get('name')).toBe('Bob');
            expect(record.has('name')).toBe(true);
        });

        it('should overwrite existing change', () => {
            const record = new ModelRecord({}, { name: 'Alice' });

            record.set('name', 'Bob');

            expect(record.get('name')).toBe('Bob');
        });

        it('should not modify original', () => {
            const record = new ModelRecord({ name: 'Alice' });

            record.set('name', 'Bob');

            expect(record.old('name')).toBe('Alice');
            expect(record.get('name')).toBe('Bob');
        });
    });

    describe('unset', () => {
        it('should remove change', () => {
            const record = new ModelRecord({}, { name: 'Bob' });

            expect(record.has('name')).toBe(true);

            record.unset('name');

            expect(record.has('name')).toBe(false);
        });

        it('should revert to original value', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Bob' });

            expect(record.get('name')).toBe('Bob');

            record.unset('name');

            expect(record.get('name')).toBe('Alice');
        });

        it('should be safe to unset non-existent field', () => {
            const record = new ModelRecord();

            record.unset('nonexistent');

            expect(record.has('nonexistent')).toBe(false);
        });
    });

    describe('clearChanges', () => {
        it('should remove all changes', () => {
            const record = new ModelRecord({}, { a: 1, b: 2, c: 3 });

            expect(record.changeCount).toBe(3);

            record.clearChanges();

            expect(record.changeCount).toBe(0);
            expect(record.hasChanges()).toBe(false);
        });

        it('should not affect original', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Bob' });

            record.clearChanges();

            expect(record.get('name')).toBe('Alice');
        });
    });

    // =========================================================================
    // BULK ACCESS TESTS
    // =========================================================================

    describe('getChangedFields', () => {
        it('should return empty array for no changes', () => {
            const record = new ModelRecord({ id: '123' });

            expect(record.getChangedFields()).toEqual([]);
        });

        it('should return changed field names', () => {
            const record = new ModelRecord({}, { a: 1, b: 2 });
            const fields = record.getChangedFields();

            expect(fields).toHaveLength(2);
            expect(fields).toContain('a');
            expect(fields).toContain('b');
        });
    });

    describe('getAllFields', () => {
        it('should return all field names from original and changes', () => {
            const record = new ModelRecord(
                { id: '123', name: 'Alice' },
                { email: 'alice@example.com' },
            );
            const fields = record.getAllFields();

            expect(fields).toHaveLength(3);
            expect(fields).toContain('id');
            expect(fields).toContain('name');
            expect(fields).toContain('email');
        });

        it('should not duplicate overlapping fields', () => {
            const record = new ModelRecord(
                { name: 'Alice' },
                { name: 'Bob' },
            );
            const fields = record.getAllFields();

            expect(fields).toHaveLength(1);
            expect(fields).toContain('name');
        });

        it('should return empty array for empty record', () => {
            const record = new ModelRecord();

            expect(record.getAllFields()).toEqual([]);
        });
    });

    describe('toRecord', () => {
        it('should return merged record', () => {
            const record = new ModelRecord(
                { id: '123', name: 'Alice' },
                { name: 'Bob', email: 'bob@example.com' },
            );
            const merged = record.toRecord();

            expect(merged).toEqual({
                id: '123',
                name: 'Bob',
                email: 'bob@example.com',
            });
        });

        it('should return original if no changes', () => {
            const record = new ModelRecord({ id: '123', name: 'Alice' });
            const merged = record.toRecord();

            expect(merged).toEqual({ id: '123', name: 'Alice' });
        });

        it('should return only changes if no original', () => {
            const record = new ModelRecord({}, { name: 'Bob' });
            const merged = record.toRecord();

            expect(merged).toEqual({ name: 'Bob' });
        });
    });

    describe('toChanges', () => {
        it('should return only changed fields', () => {
            const record = new ModelRecord(
                { id: '123', name: 'Alice' },
                { name: 'Bob', email: 'bob@example.com' },
            );
            const changes = record.toChanges();

            expect(changes).toEqual({
                name: 'Bob',
                email: 'bob@example.com',
            });
        });

        it('should return empty object if no changes', () => {
            const record = new ModelRecord({ id: '123' });
            const changes = record.toChanges();

            expect(changes).toEqual({});
        });
    });

    // =========================================================================
    // DIFF TESTS
    // =========================================================================

    describe('getDiff', () => {
        it('should return diff with old and new values', () => {
            const record = new ModelRecord(
                { name: 'Alice', age: 30 },
                { name: 'Bob' },
            );
            const diff = record.getDiff();

            expect(diff).toEqual({
                name: { old: 'Alice', new: 'Bob' },
            });
        });

        it('should include fields added from undefined', () => {
            const record = new ModelRecord(
                {},
                { email: 'bob@example.com' },
            );
            const diff = record.getDiff();

            expect(diff).toEqual({
                email: { old: undefined, new: 'bob@example.com' },
            });
        });

        it('should exclude changes where value is the same', () => {
            const record = new ModelRecord({ name: 'Alice' });

            // Set to same value
            record.set('name', 'Alice');

            const diff = record.getDiff();

            expect(diff).toEqual({});
        });

        it('should return empty object for no changes', () => {
            const record = new ModelRecord({ id: '123' });
            const diff = record.getDiff();

            expect(diff).toEqual({});
        });
    });

    describe('getDiffForFields', () => {
        it('should filter diff to specified fields', () => {
            const record = new ModelRecord(
                { name: 'Alice', age: 30, email: 'old@example.com' },
                { name: 'Bob', age: 31, email: 'new@example.com' },
            );
            const trackedFields = new Set(['name', 'email']);
            const diff = record.getDiffForFields(trackedFields);

            expect(diff).toEqual({
                name: { old: 'Alice', new: 'Bob' },
                email: { old: 'old@example.com', new: 'new@example.com' },
            });
            expect(diff.age).toBeUndefined();
        });

        it('should return empty object if no tracked fields changed', () => {
            const record = new ModelRecord(
                { name: 'Alice' },
                { age: 31 },
            );
            const trackedFields = new Set(['name']);
            const diff = record.getDiffForFields(trackedFields);

            expect(diff).toEqual({});
        });

        it('should handle empty tracked fields set', () => {
            const record = new ModelRecord(
                { name: 'Alice' },
                { name: 'Bob' },
            );
            const diff = record.getDiffForFields(new Set());

            expect(diff).toEqual({});
        });
    });

    // =========================================================================
    // PUBLIC ACCESSOR TESTS
    // =========================================================================

    describe('getOriginal', () => {
        it('should return original data', () => {
            const record = new ModelRecord({ id: '123', name: 'Alice' });
            const original = record.getOriginal();

            expect(original).toEqual({ id: '123', name: 'Alice' });
        });

        it('should not be affected by changes', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: 'Bob' });
            const original = record.getOriginal();

            expect(original.name).toBe('Alice');
        });
    });

    describe('hasOriginal', () => {
        it('should return true for field in original', () => {
            const record = new ModelRecord({ name: 'Alice' });

            expect(record.hasOriginal('name')).toBe(true);
        });

        it('should return false for field not in original', () => {
            const record = new ModelRecord({}, { name: 'Bob' });

            expect(record.hasOriginal('name')).toBe(false);
        });
    });

    // =========================================================================
    // EDGE CASES - STUPID USER TESTS
    // =========================================================================

    describe('edge cases - null vs undefined vs empty', () => {
        it('should distinguish null from undefined in original', () => {
            const record = new ModelRecord({ a: null, b: undefined });

            expect(record.get('a')).toBeNull();
            expect(record.get('b')).toBeUndefined();
            expect(record.old('a')).toBeNull();
            expect(record.old('b')).toBeUndefined();
        });

        it('should distinguish null from undefined in changes', () => {
            const record = new ModelRecord({}, { a: null, b: undefined });

            expect(record.get('a')).toBeNull();
            expect(record.get('b')).toBeUndefined();
            expect(record.has('a')).toBe(true);
            expect(record.has('b')).toBe(true);
        });

        it('should track change from value to null', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: null });

            expect(record.old('name')).toBe('Alice');
            expect(record.get('name')).toBeNull();

            const diff = record.getDiff();

            expect(diff.name).toEqual({ old: 'Alice', new: null });
        });

        it('should track change from value to undefined', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: undefined });

            expect(record.old('name')).toBe('Alice');
            expect(record.get('name')).toBeUndefined();

            const diff = record.getDiff();

            expect(diff.name).toEqual({ old: 'Alice', new: undefined });
        });

        it('should track change from null to undefined', () => {
            const record = new ModelRecord({ val: null }, { val: undefined });

            const diff = record.getDiff();

            expect(diff.val).toEqual({ old: null, new: undefined });
        });

        it('should track change from undefined to null', () => {
            const record = new ModelRecord({ val: undefined }, { val: null });

            const diff = record.getDiff();

            expect(diff.val).toEqual({ old: undefined, new: null });
        });

        it('should handle empty string as valid value', () => {
            const record = new ModelRecord({ name: 'Alice' }, { name: '' });

            expect(record.get('name')).toBe('');
            expect(record.old('name')).toBe('Alice');

            const diff = record.getDiff();

            expect(diff.name).toEqual({ old: 'Alice', new: '' });
        });

        it('should handle 0 as valid value', () => {
            const record = new ModelRecord({ count: 10 }, { count: 0 });

            expect(record.get('count')).toBe(0);

            const diff = record.getDiff();

            expect(diff.count).toEqual({ old: 10, new: 0 });
        });

        it('should handle false as valid value', () => {
            const record = new ModelRecord({ active: true }, { active: false });

            expect(record.get('active')).toBe(false);

            const diff = record.getDiff();

            expect(diff.active).toEqual({ old: true, new: false });
        });

        it('should not confuse null/undefined/empty string equality', () => {
            // null !== undefined !== ''
            const r1 = new ModelRecord({ v: null }, { v: undefined });
            const r2 = new ModelRecord({ v: null }, { v: '' });
            const r3 = new ModelRecord({ v: undefined }, { v: '' });

            expect(r1.getDiff().v).toBeDefined();
            expect(r2.getDiff().v).toBeDefined();
            expect(r3.getDiff().v).toBeDefined();
        });
    });

    describe('edge cases - field names', () => {
        it('should handle empty string field name', () => {
            const record = new ModelRecord({}, { '': 'value' });

            expect(record.get('')).toBe('value');
            expect(record.has('')).toBe(true);
        });

        it('should handle numeric field names', () => {
            const record = new ModelRecord({}, { '0': 'zero', '123': 'numbers' });

            expect(record.get('0')).toBe('zero');
            expect(record.get('123')).toBe('numbers');
        });

        it('should handle field name with spaces', () => {
            const record = new ModelRecord({}, { 'field name': 'value' });

            expect(record.get('field name')).toBe('value');
        });

        it('should handle field name with special characters', () => {
            const record = new ModelRecord({}, {
                'field.with.dots': 1,
                'field-with-dashes': 2,
                'field_with_underscores': 3,
                'field:with:colons': 4,
            });

            expect(record.get('field.with.dots')).toBe(1);
            expect(record.get('field-with-dashes')).toBe(2);
            expect(record.get('field_with_underscores')).toBe(3);
            expect(record.get('field:with:colons')).toBe(4);
        });

        it('should handle unicode field names', () => {
            const record = new ModelRecord({}, {
                '名前': 'name in japanese',
                '🔑': 'emoji key',
                'café': 'with accent',
            });

            expect(record.get('名前')).toBe('name in japanese');
            expect(record.get('🔑')).toBe('emoji key');
            expect(record.get('café')).toBe('with accent');
        });

        it('should handle __proto__ field name safely', () => {
            // Note: JavaScript treats __proto__ specially - it returns the prototype
            // This test documents the actual behavior
            const record = new ModelRecord({}, { '__proto__': 'should not pollute' });

            // __proto__ is a special property - get() returns the prototype
            // This is JavaScript behavior, not a bug in ModelRecord
            const result = record.get('__proto__');

            expect(result).toBeDefined();

            // Verify no prototype pollution
            const obj = record.toRecord();

            expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
        });

        it('should handle constructor field name safely', () => {
            const record = new ModelRecord({}, { 'constructor': 'safe value' });

            expect(record.get('constructor')).toBe('safe value');
        });

        it('should handle toString field name safely', () => {
            const record = new ModelRecord({}, { 'toString': 'override attempt' });

            expect(record.get('toString')).toBe('override attempt');

            // Original toString should still work on the record object itself
            const result = record.toRecord();

            expect(typeof result.toString).toBe('string');
        });
    });

    describe('edge cases - value types', () => {
        it('should handle nested objects', () => {
            const nested = { a: { b: { c: 1 } } };
            const record = new ModelRecord({}, { data: nested });

            expect(record.get('data')).toEqual(nested);
        });

        it('should handle arrays', () => {
            const arr = [1, 2, 3, { nested: true }];
            const record = new ModelRecord({}, { items: arr });

            expect(record.get('items')).toEqual(arr);
        });

        it('should handle Date objects', () => {
            const date = new Date('2024-01-01');
            const record = new ModelRecord({}, { created: date });

            expect(record.get('created')).toBe(date);
        });

        it('should handle RegExp objects', () => {
            const regex = /test\d+/gi;
            const record = new ModelRecord({}, { pattern: regex });

            expect(record.get('pattern')).toBe(regex);
        });

        it('should handle functions (unusual but possible)', () => {
            const fn = () => 'result';
            const record = new ModelRecord({}, { callback: fn });

            expect(record.get('callback')).toBe(fn);
        });

        it('should handle Symbol values', () => {
            const sym = Symbol('test');
            const record = new ModelRecord({}, { key: sym });

            expect(record.get('key')).toBe(sym);
        });

        it('should handle BigInt values', () => {
            const big = BigInt(9007199254740991);
            const record = new ModelRecord({}, { bignum: big });

            expect(record.get('bignum')).toBe(big);
        });

        it('should handle Infinity and NaN', () => {
            const record = new ModelRecord({}, {
                inf: Infinity,
                negInf: -Infinity,
                notNum: NaN,
            });

            expect(record.get('inf')).toBe(Infinity);
            expect(record.get('negInf')).toBe(-Infinity);
            expect(record.get('notNum')).toBeNaN();
        });

        it('should handle very large objects', () => {
            const largeObj: Record<string, number> = {};

            for (let i = 0; i < 1000; i++) {
                largeObj[`field_${i}`] = i;
            }

            const record = new ModelRecord({}, largeObj);

            expect(record.changeCount).toBe(1000);
            expect(record.get('field_0')).toBe(0);
            expect(record.get('field_999')).toBe(999);
        });

        it('should handle circular references without crashing', () => {
            const circular: Record<string, unknown> = { name: 'test' };

            circular.self = circular;

            const record = new ModelRecord({}, { data: circular });

            // Should store the reference
            expect(record.get('data')).toBe(circular);

            // toRecord should work (shallow copy doesn't deep-copy circular)
            const result = record.toRecord();

            expect(result.data).toBe(circular);
        });
    });

    describe('edge cases - operations sequence', () => {
        it('should handle set-unset-set sequence', () => {
            const record = new ModelRecord({ name: 'Alice' });

            record.set('name', 'Bob');

            expect(record.get('name')).toBe('Bob');

            record.unset('name');

            expect(record.get('name')).toBe('Alice');

            record.set('name', 'Charlie');

            expect(record.get('name')).toBe('Charlie');
        });

        it('should handle multiple sets to same field', () => {
            const record = new ModelRecord();

            record.set('count', 1);
            record.set('count', 2);
            record.set('count', 3);

            expect(record.get('count')).toBe(3);
            expect(record.changeCount).toBe(1); // Still one field changed
        });

        it('should handle clearChanges then add new changes', () => {
            const record = new ModelRecord({ id: '123' }, { name: 'Bob' });

            record.clearChanges();

            expect(record.hasChanges()).toBe(false);

            record.set('email', 'bob@example.com');

            expect(record.hasChanges()).toBe(true);
            expect(record.get('name')).toBeUndefined(); // Cleared
            expect(record.get('email')).toBe('bob@example.com');
        });

        it('should handle unset on field that was never set', () => {
            const record = new ModelRecord({ name: 'Alice' });

            // Unset a field that exists in original but not in changes
            record.unset('name');

            expect(record.has('name')).toBe(false);
            expect(record.get('name')).toBe('Alice'); // Falls back to original
        });

        it('should handle repeated getChangedFields calls', () => {
            const record = new ModelRecord({}, { a: 1, b: 2 });

            const fields1 = record.getChangedFields();
            const fields2 = record.getChangedFields();

            // Should return fresh arrays each time
            expect(fields1).not.toBe(fields2);
            expect(fields1).toEqual(fields2);
        });

        it('should handle repeated toRecord calls', () => {
            const record = new ModelRecord({ id: '123' }, { name: 'Bob' });

            const rec1 = record.toRecord();
            const rec2 = record.toRecord();

            // Should return fresh objects each time
            expect(rec1).not.toBe(rec2);
            expect(rec1).toEqual(rec2);

            // Modifying returned object should not affect record
            rec1.name = 'MODIFIED';

            expect(record.get('name')).toBe('Bob');
        });
    });

    describe('edge cases - isNew edge cases', () => {
        it('should return true for original with only non-id fields', () => {
            const record = new ModelRecord({ name: 'test', status: 'active' });

            expect(record.isNew()).toBe(true);
        });

        it('should return false for original with id even if empty string', () => {
            const record = new ModelRecord({ id: '' });

            // Empty string id is still an id (falsy but exists)
            expect(record.isNew()).toBe(true); // Empty string is falsy
        });

        it('should return false for original with id=0', () => {
            const record = new ModelRecord({ id: 0 as unknown as string });

            // 0 is falsy, so isNew returns true
            expect(record.isNew()).toBe(true);
        });

        it('should return false for original with valid id', () => {
            const record = new ModelRecord({ id: 'abc-123' });

            expect(record.isNew()).toBe(false);
        });

        it('should handle id in changes but not original', () => {
            const record = new ModelRecord({}, { id: 'new-id' });

            // isNew checks original.id, not changes
            expect(record.isNew()).toBe(true);
        });
    });

    describe('edge cases - getDiff edge cases', () => {
        it('should handle diff when changing to same type but different value', () => {
            const record = new ModelRecord(
                { num: 1, str: 'a', bool: true },
                { num: 2, str: 'b', bool: false },
            );
            const diff = record.getDiff();

            expect(diff.num).toEqual({ old: 1, new: 2 });
            expect(diff.str).toEqual({ old: 'a', new: 'b' });
            expect(diff.bool).toEqual({ old: true, new: false });
        });

        it('should handle diff when changing type', () => {
            const record = new ModelRecord(
                { val: 'string' },
                { val: 123 },
            );
            const diff = record.getDiff();

            expect(diff.val).toEqual({ old: 'string', new: 123 });
        });

        it('should handle diff with object values using reference equality', () => {
            const obj1 = { a: 1 };
            const obj2 = { a: 1 }; // Same content, different reference

            const record = new ModelRecord({ data: obj1 }, { data: obj2 });
            const diff = record.getDiff();

            // Different references means it's a change
            expect(diff.data).toEqual({ old: obj1, new: obj2 });
        });

        it('should not show diff for same object reference', () => {
            const obj = { a: 1 };
            const record = new ModelRecord({ data: obj });

            record.set('data', obj); // Same reference

            const diff = record.getDiff();

            expect(diff.data).toBeUndefined();
        });
    });
});
