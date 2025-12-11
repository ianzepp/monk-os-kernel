/**
 * Ring 4: TransformProcessor Observer Tests
 *
 * Tests for the TransformProcessor observer which applies automatic
 * transformations to field values before database persistence.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { TransformProcessor } from '@src/ems/ring/4/index.js';
import { ObserverRing } from '@src/ems/observers/index.js';
import { getDialect } from '@src/ems/dialect.js';
import type {
    ObserverContext,
    Model,
    ModelRecord,
    DatabaseAdapter,
    ModelCacheAdapter,
} from '@src/ems/observers/index.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock database adapter
 */
function createMockDatabase(): DatabaseAdapter {
    return {
        dialect: 'sqlite',
        async execute(_sql: string, _params?: unknown[]): Promise<number> {
            return 1;
        },
        async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
            return [];
        },
        async exec(_sql: string): Promise<void> {
            // no-op
        },
        async transaction(_statements: Array<{ sql: string; params?: unknown[] }>): Promise<number[]> {
            return [];
        },
    };
}

/**
 * Create a mock cache adapter
 */
function createMockCache(): ModelCacheAdapter {
    return {
        invalidate(_modelName: string): void {
            // no-op
        },
    };
}

/**
 * Create a mock model for testing
 */
function createMockModel(
    name: string,
    transforms: Map<string, string> = new Map(),
): Model {
    return {
        modelName: name,
        tableName: name,
        isFrozen: false,
        isImmutable: false,
        requiresSudo: false,
        getImmutableFields: () => new Set(),
        getTrackedFields: () => new Set(),
        getTransformFields: () => transforms,
        getValidationFields: () => [],
        getFields: () => [],
    };
}

/**
 * Create a mock record for testing with mutable state
 */
function createMockRecord(
    oldData: Record<string, unknown> = {},
    newData: Record<string, unknown> = {},
): ModelRecord & { _newData: Record<string, unknown> } {
    const _newData = { ...newData };
    const merged = { ...oldData, ..._newData };

    return {
        _newData,
        isNew: () => Object.keys(oldData).length === 0,
        old: (field: string) => oldData[field],
        get: (field: string) => (field in _newData ? _newData[field] : oldData[field]),
        has: (field: string) => field in _newData,
        set: (field: string, value: unknown) => {
            _newData[field] = value;
            merged[field] = value;
        },
        getChangedFields: () => Object.keys(_newData),
        toRecord: () => ({ ...oldData, ..._newData }),
        toChanges: () => ({ ..._newData }),
        getDiff: () => {
            const diff: Record<string, { old: unknown; new: unknown }> = {};

            for (const field of Object.keys(_newData)) {
                diff[field] = { old: oldData[field], new: _newData[field] };
            }

            return diff;
        },
        getDiffForFields: (fields: Set<string>) => {
            const diff: Record<string, { old: unknown; new: unknown }> = {};

            for (const field of Object.keys(_newData)) {
                if (!fields.has(field)) {
                    continue;
                }

                diff[field] = { old: oldData[field], new: _newData[field] };
            }

            return diff;
        },
    };
}

/**
 * Create a context for testing observers
 */
function createContext(
    operation: 'create' | 'update' | 'delete',
    modelName: string,
    record: ModelRecord,
    transforms: Map<string, string> = new Map(),
): ObserverContext {
    return {
        system: {
            db: createMockDatabase(),
            cache: createMockCache(),
            dialect: getDialect('sqlite'),
        },
        operation,
        model: createMockModel(modelName, transforms),
        record,
        recordIndex: 0,
        errors: [],
        warnings: [],
    };
}

// =============================================================================
// TRANSFORM PROCESSOR TESTS
// =============================================================================

describe('TransformProcessor', () => {
    let observer: TransformProcessor;

    beforeEach(() => {
        observer = new TransformProcessor();
    });

    describe('configuration', () => {
        it('should have correct name', () => {
            expect(observer.name).toBe('TransformProcessor');
        });

        it('should be in Ring 4 (Enrichment)', () => {
            expect(observer.ring).toBe(ObserverRing.Enrichment);
        });

        it('should have priority 50', () => {
            expect(observer.priority).toBe(50);
        });

        it('should handle create and update operations', () => {
            expect(observer.operations).toContain('create');
            expect(observer.operations).toContain('update');
            expect(observer.operations).not.toContain('delete');
            expect(observer.operations).toHaveLength(2);
        });

        it('should not have model filter (runs for all models)', () => {
            expect(observer.models).toBeUndefined();
        });
    });

    describe('lowercase transform', () => {
        it('should convert string to lowercase', async () => {
            const transforms = new Map([['name', 'lowercase']]);
            const record = createMockRecord({}, { name: 'HELLO WORLD' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('hello world');
        });

        it('should handle mixed case', async () => {
            const transforms = new Map([['name', 'lowercase']]);
            const record = createMockRecord({}, { name: 'HeLLo WoRLd' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('hello world');
        });

        it('should handle already lowercase', async () => {
            const transforms = new Map([['name', 'lowercase']]);
            const record = createMockRecord({}, { name: 'already lowercase' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('already lowercase');
        });
    });

    describe('uppercase transform', () => {
        it('should convert string to uppercase', async () => {
            const transforms = new Map([['code', 'uppercase']]);
            const record = createMockRecord({}, { code: 'hello world' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('code')).toBe('HELLO WORLD');
        });

        it('should handle mixed case', async () => {
            const transforms = new Map([['code', 'uppercase']]);
            const record = createMockRecord({}, { code: 'HeLLo WoRLd' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('code')).toBe('HELLO WORLD');
        });
    });

    describe('trim transform', () => {
        it('should remove leading whitespace', async () => {
            const transforms = new Map([['name', 'trim']]);
            const record = createMockRecord({}, { name: '   hello' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('hello');
        });

        it('should remove trailing whitespace', async () => {
            const transforms = new Map([['name', 'trim']]);
            const record = createMockRecord({}, { name: 'hello   ' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('hello');
        });

        it('should remove both leading and trailing whitespace', async () => {
            const transforms = new Map([['name', 'trim']]);
            const record = createMockRecord({}, { name: '   hello world   ' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('hello world');
        });

        it('should preserve internal whitespace', async () => {
            const transforms = new Map([['name', 'trim']]);
            const record = createMockRecord({}, { name: '  hello   world  ' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('hello   world');
        });
    });

    describe('normalize_email transform', () => {
        it('should lowercase and trim email', async () => {
            const transforms = new Map([['email', 'normalize_email']]);
            const record = createMockRecord({}, { email: '  John.Doe@Example.COM  ' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('email')).toBe('john.doe@example.com');
        });

        it('should handle already normalized email', async () => {
            const transforms = new Map([['email', 'normalize_email']]);
            const record = createMockRecord({}, { email: 'test@example.com' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('email')).toBe('test@example.com');
        });

        it('should handle email with special characters', async () => {
            const transforms = new Map([['email', 'normalize_email']]);
            const record = createMockRecord({}, { email: 'Test+Tag@Example.COM' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('email')).toBe('test+tag@example.com');
        });
    });

    describe('normalize_phone transform', () => {
        it('should extract digits and preserve + prefix', async () => {
            const transforms = new Map([['phone', 'normalize_phone']]);
            const record = createMockRecord({}, { phone: '+1 (555) 123-4567' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('phone')).toBe('+15551234567');
        });

        it('should extract digits without + prefix', async () => {
            const transforms = new Map([['phone', 'normalize_phone']]);
            const record = createMockRecord({}, { phone: '(555) 123-4567' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('phone')).toBe('5551234567');
        });

        it('should handle phone with spaces only', async () => {
            const transforms = new Map([['phone', 'normalize_phone']]);
            const record = createMockRecord({}, { phone: '555 123 4567' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('phone')).toBe('5551234567');
        });

        it('should handle international format with + after space', async () => {
            const transforms = new Map([['phone', 'normalize_phone']]);
            const record = createMockRecord({}, { phone: ' +44 20 7946 0958' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('phone')).toBe('+442079460958');
        });

        it('should handle already normalized phone', async () => {
            const transforms = new Map([['phone', 'normalize_phone']]);
            const record = createMockRecord({}, { phone: '+15551234567' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('phone')).toBe('+15551234567');
        });
    });

    describe('skipping conditions', () => {
        it('should skip when model has no transforms', async () => {
            const transforms = new Map<string, string>();
            const record = createMockRecord({}, { name: 'HELLO' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            // Value should be unchanged
            expect(record.get('name')).toBe('HELLO');
        });

        it('should skip fields not in changes', async () => {
            const transforms = new Map([['name', 'lowercase']]);
            // name is in old data but not in changes
            const record = createMockRecord({ name: 'HELLO' }, { other: 'value' });
            const ctx = createContext('update', 'test', record, transforms);

            await observer.execute(ctx);

            // name should be unchanged (old value)
            expect(record.get('name')).toBe('HELLO');
        });

        it('should skip null values', async () => {
            const transforms = new Map([['name', 'lowercase']]);
            const record = createMockRecord({}, { name: null });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe(null);
        });

        it('should skip undefined values', async () => {
            const transforms = new Map([['name', 'lowercase']]);
            const record = createMockRecord({}, { name: undefined });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe(undefined);
        });

        it('should skip non-string values', async () => {
            const transforms = new Map([['count', 'lowercase']]);
            const record = createMockRecord({}, { count: 123 });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            // Number should be unchanged
            expect(record.get('count')).toBe(123);
        });
    });

    describe('multiple transforms', () => {
        it('should apply transforms to multiple fields', async () => {
            const transforms = new Map([
                ['email', 'normalize_email'],
                ['phone', 'normalize_phone'],
                ['code', 'uppercase'],
            ]);
            const record = createMockRecord({}, {
                email: '  John@Example.COM  ',
                phone: '+1 (555) 123-4567',
                code: 'abc123',
            });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('email')).toBe('john@example.com');
            expect(record.get('phone')).toBe('+15551234567');
            expect(record.get('code')).toBe('ABC123');
        });

        it('should only transform fields that are changed', async () => {
            const transforms = new Map([
                ['name', 'lowercase'],
                ['code', 'uppercase'],
            ]);
            // Only name is in changes
            const record = createMockRecord(
                { code: 'old_value' },
                { name: 'HELLO' },
            );
            const ctx = createContext('update', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('hello');
            expect(record.get('code')).toBe('old_value'); // unchanged
        });
    });

    describe('unknown transform', () => {
        it('should not modify value for unknown transform', async () => {
            const transforms = new Map([['name', 'unknown_transform']]);
            const record = createMockRecord({}, { name: 'Hello World' });
            const ctx = createContext('create', 'test', record, transforms);

            // Should log warning but not throw
            await observer.execute(ctx);

            // Value should be unchanged
            expect(record.get('name')).toBe('Hello World');
        });
    });

    describe('edge cases', () => {
        it('should handle empty string', async () => {
            const transforms = new Map([['name', 'lowercase']]);
            const record = createMockRecord({}, { name: '' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('');
        });

        it('should handle whitespace-only string with trim', async () => {
            const transforms = new Map([['name', 'trim']]);
            const record = createMockRecord({}, { name: '   ' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('');
        });

        it('should handle unicode characters', async () => {
            const transforms = new Map([['name', 'lowercase']]);
            const record = createMockRecord({}, { name: 'CAFÉ' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);

            expect(record.get('name')).toBe('café');
        });

        it('should be idempotent - applying twice gives same result', async () => {
            const transforms = new Map([['email', 'normalize_email']]);
            const record = createMockRecord({}, { email: '  John@Example.COM  ' });
            const ctx = createContext('create', 'test', record, transforms);

            await observer.execute(ctx);
            const firstResult = record.get('email');

            await observer.execute(ctx);
            const secondResult = record.get('email');

            expect(firstResult).toBe(secondResult);
            expect(secondResult).toBe('john@example.com');
        });
    });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Ring 4 Integration', () => {
    it('should export TransformProcessor from index', async () => {
        const exports = await import('@src/ems/ring/4/index.js');

        expect(exports.TransformProcessor).toBeDefined();
    });

    it('should be importable from registry', async () => {
        const { createObserverRunner } = await import('@src/ems/observers/registry.js');
        const runner = createObserverRunner();

        // Runner should be created without errors
        expect(runner).toBeDefined();
    });

    it('should have correct ring ordering (Ring 4 > Ring 1, Ring 4 < Ring 5)', async () => {
        // Verify ring enum values enforce correct ordering
        const { ObserverRing } = await import('@src/ems/observers/index.js');

        // Ring 4 (Enrichment) should be greater than Ring 1 (InputValidation)
        expect(ObserverRing.Enrichment).toBeGreaterThan(ObserverRing.InputValidation);

        // Ring 4 (Enrichment) should be less than Ring 5 (Database)
        expect(ObserverRing.Enrichment).toBeLessThan(ObserverRing.Database);
    });
});

// =============================================================================
// PROOF TESTS
// =============================================================================

describe('Transform proof', () => {
    it('should normalize user input before database storage', async () => {
        const { TransformProcessor } = await import('@src/ems/ring/4/index.js');
        const observer = new TransformProcessor();

        // Simulate messy user input
        const transforms = new Map([
            ['email', 'normalize_email'],
            ['phone', 'normalize_phone'],
            ['username', 'lowercase'],
        ]);
        const record = createMockRecord({}, {
            email: '  JOHN.DOE@EXAMPLE.COM  ',
            phone: '  +1 (555) 123-4567  ',
            username: '  JohnDoe123  ',
        });
        const ctx = createContext('create', 'users', record, transforms);

        await observer.execute(ctx);

        // All values should be normalized
        expect(record.get('email')).toBe('john.doe@example.com');
        expect(record.get('phone')).toBe('+15551234567');
        expect(record.get('username')).toBe('  JohnDoe123  '.toLowerCase()); // lowercase only, no trim
    });

    it('should only transform changed fields on update', async () => {
        const { TransformProcessor } = await import('@src/ems/ring/4/index.js');
        const observer = new TransformProcessor();

        // Existing user with normalized data
        const transforms = new Map([
            ['email', 'normalize_email'],
            ['phone', 'normalize_phone'],
        ]);

        // User only updating phone, not email
        const record = createMockRecord(
            { id: 'user-123', email: 'existing@example.com', phone: '+11111111111' },
            { phone: '+1 (222) 333-4444' },
        );
        const ctx = createContext('update', 'users', record, transforms);

        await observer.execute(ctx);

        // Only phone should be transformed, email unchanged
        expect(record.get('phone')).toBe('+12223334444');
        expect(record.get('email')).toBe('existing@example.com');
    });
});
