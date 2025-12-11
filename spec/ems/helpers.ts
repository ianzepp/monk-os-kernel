/**
 * Shared test helpers for EMS observer tests.
 *
 * Centralizes mock creation to avoid repetitive boilerplate and ensure
 * consistent test setup across all observer test files.
 */

import { getDialect } from '@src/ems/dialect.js';
import type {
    ObserverContext,
    Model,
    ModelRecord,
    FieldRow,
    DatabaseAdapter,
    ModelCacheAdapter,
    SystemContext,
} from '@src/ems/observers/index.js';

// =============================================================================
// MOCK DATABASE
// =============================================================================

/**
 * Create a mock database adapter with SQLite dialect.
 */
export function createMockDatabase(): DatabaseAdapter {
    return {
        dialect: getDialect('sqlite'),
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

// =============================================================================
// MOCK CACHE
// =============================================================================

/**
 * Create a mock model cache adapter.
 */
export function createMockCache(): ModelCacheAdapter {
    return {
        invalidate(_modelName: string): void {},
    };
}

// =============================================================================
// MOCK SYSTEM CONTEXT
// =============================================================================

/**
 * Create a mock system context with database and cache.
 */
export function createMockSystemContext(overrides?: Partial<SystemContext>): SystemContext {
    return {
        db: createMockDatabase(),
        cache: createMockCache(),
        dialect: getDialect('sqlite'),
        ...overrides,
    };
}

// =============================================================================
// MOCK FIELD
// =============================================================================

/**
 * Create a mock field row with sensible defaults.
 */
export function createMockField(overrides: Partial<FieldRow> = {}): FieldRow {
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

// =============================================================================
// MOCK MODEL
// =============================================================================

/**
 * Create a mock model matching the observer interface.
 */
export function createMockModel(
    name = 'test_model',
    fields: FieldRow[] = [],
): Model {
    return {
        modelName: name,
        tableName: name,
        isFrozen: false,
        isImmutable: false,
        requiresSudo: false,
        getImmutableFields: () => new Set<string>(),
        getTrackedFields: () => new Set<string>(),
        getTransformFields: () => new Map<string, string>(),
        getValidationFields: () => fields,
        getFields: () => fields,
    };
}

// =============================================================================
// MOCK RECORD
// =============================================================================

/**
 * Create a mock model record matching the observer interface.
 */
export function createMockRecord(
    oldData: Record<string, unknown> = {},
    newData: Record<string, unknown> = {},
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
                if (!fields.has(field)) {
                    continue;
                }

                if (oldData[field] !== newData[field]) {
                    diff[field] = { old: oldData[field], new: newData[field] };
                }
            }

            return diff;
        },
    };
}

// =============================================================================
// MOCK CONTEXT
// =============================================================================

/**
 * Create a complete mock observer context.
 */
export function createMockContext(
    operation: 'create' | 'update' | 'delete',
    model: Model,
    record: ModelRecord,
): ObserverContext {
    return {
        system: createMockSystemContext(),
        operation,
        model,
        record,
        recordIndex: 0,
        errors: [],
        warnings: [],
    };
}
