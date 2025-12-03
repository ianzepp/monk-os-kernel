# Phase 4: Core Observers

## Overview

Observers implement the behavioral enforcement specified in field/model metadata. Each observer runs at a specific ring and priority, handling specific operations on specific models.

## Implementation Status

| Ring | Priority | Observer | Status | Notes |
|------|----------|----------|--------|-------|
| 0 | 50 | UpdateMerger | ❌ Not started | |
| 1 | 10 | Frozen | ✅ Implemented | Not yet registered |
| 1 | 30 | Immutable | ✅ Implemented | Not yet registered |
| 1 | 40 | Constraints | ✅ Implemented | Not yet registered |
| 4 | 50 | TransformProcessor | ❌ Not started | |
| 5 | 50 | SqlCreate | ✅ Registered | Active in pipeline |
| 5 | 50 | SqlUpdate | ✅ Registered | Active in pipeline |
| 5 | 50 | SqlDelete | ✅ Registered | Active in pipeline |
| 6 | 10 | DdlCreateModel | ✅ Implemented | Not yet registered |
| 6 | 10 | DdlCreateField | ✅ Implemented | Not yet registered |
| 7 | 60 | Tracked | ❌ Not started | |
| 8 | 50 | Cache | ❌ Not started | |

## Observer Inventory

### Essential Observers (Minimum Viable)

| Ring | Priority | Observer | Operations | Purpose |
|------|----------|----------|------------|---------|
| 0 | 50 | UpdateMerger | update | Merge input with existing data |
| 1 | 10 | Frozen | create, update, delete | Block changes to frozen models |
| 1 | 30 | Immutable | update | Block changes to immutable fields |
| 1 | 40 | Constraints | create, update | Validate types and constraints |
| 4 | 50 | TransformProcessor | create, update | Apply auto-transforms |
| 5 | 50 | SqlCreate | create | Execute INSERT |
| 5 | 50 | SqlUpdate | update | Execute UPDATE |
| 5 | 50 | SqlDelete | delete | Execute soft DELETE |
| 6 | 10 | DdlCreateModel | create (models) | CREATE TABLE |
| 6 | 10 | DdlCreateField | create (fields) | ALTER TABLE ADD COLUMN |
| 7 | 60 | Tracked | create, update, delete | Record change history |
| 8 | 50 | Cache | * (models, fields) | Invalidate model cache |

### Nice-to-Have Observers

| Ring | Priority | Observer | Purpose |
|------|----------|----------|---------|
| 1 | 20 | ModelSudoValidator | Require sudo for model operations |
| 1 | 25 | FieldSudoValidator | Require sudo for field operations |
| 2 | 50 | ExistenceValidator | Verify record exists for update/delete |
| 6 | 10 | DdlDeleteField | ALTER TABLE DROP COLUMN |
| 6 | 20 | DdlIndexes | CREATE/DROP INDEX |

## System Interfaces

These interfaces in `src/model/observers/interfaces.ts` define the contracts for observer execution:

### DatabaseAdapter

```typescript
/**
 * Database connection for SQL operations.
 * Ring 5 observers use this to execute INSERT/UPDATE/DELETE.
 */
export interface DatabaseAdapter {
    /**
     * Execute an INSERT/UPDATE/DELETE statement.
     * @param sql - SQL statement with ? placeholders
     * @param params - Parameter values (positional)
     * @returns Promise resolving to affected row count
     */
    execute(sql: string, params?: unknown[]): Promise<number>;

    /**
     * Execute a SELECT query and return all rows.
     */
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

    /**
     * Execute raw SQL (multiple statements allowed).
     */
    exec(sql: string): Promise<void>;
}
```

### ModelCacheAdapter

```typescript
/**
 * Model cache for metadata lookup.
 * Ring 8 (CacheInvalidator) uses this to clear cache after model/field changes.
 */
export interface ModelCacheAdapter {
    /**
     * Invalidate cached model metadata.
     * @param modelName - Model to invalidate
     */
    invalidate(modelName: string): void;
}
```

### SystemContext

```typescript
/**
 * System services available to observers.
 */
export interface SystemContext {
    /** Database connection for SQL operations */
    db: DatabaseAdapter;

    /** Model metadata cache */
    cache: ModelCacheAdapter;
}
```

### Model Interface

```typescript
/**
 * Model metadata wrapper.
 * Note: Uses camelCase (modelName, isFrozen) not snake_case.
 */
export interface Model {
    readonly modelName: string;      // NOT model_name
    readonly isFrozen: boolean;
    readonly isImmutable: boolean;
    readonly requiresSudo: boolean;

    getImmutableFields(): Set<string>;
    getTrackedFields(): Set<string>;
    getTransformFields(): Map<string, string>;
    getValidationFields(): FieldRow[];
    getFields(): FieldRow[];
}
```

## Observer Implementations

### Ring 0: Data Preparation

#### UpdateMerger (`src/model/ring/0/50-update-merger.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

/**
 * Merges input data with existing record for updates.
 *
 * Ensures updated_at is set and applies default values for missing fields.
 */
export class UpdateMerger extends BaseObserver {
    readonly name = 'UpdateMerger';
    readonly ring = ObserverRing.DataPreparation;
    readonly priority = 50;
    readonly operations: readonly OperationType[] = ['update'];

    async execute(context: ObserverContext): Promise<void> {
        const { record, model } = context;

        // Apply default values for fields not in the update
        for (const field of model.getFields()) {
            if (field.default_value !== null &&
                record.get(field.field_name) === undefined) {
                // Only apply default if field is completely missing
                // (not just null - null is a valid value)
            }
        }

        // Ensure updated_at will be set
        if (!record.has('updated_at')) {
            record.set('updated_at', new Date().toISOString());
        }
    }
}

export default UpdateMerger;
```

### Ring 1: Input Validation

#### Frozen (`src/model/ring/1/10-frozen.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSFROZEN } from '../../observers/errors.js';

/**
 * Prevents any data changes to frozen models.
 */
export class Frozen extends BaseObserver {
    readonly name = 'Frozen';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create', 'update', 'delete'];

    async execute(context: ObserverContext): Promise<void> {
        const { model } = context;

        if (model.isFrozen) {
            throw new EOBSFROZEN(
                `Model '${model.modelName}' is frozen and cannot be modified`
            );
        }
    }
}

export default Frozen;
```

#### Immutable (`src/model/ring/1/30-immutable.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSIMMUT } from '../../observers/errors.js';

/**
 * Prevents changes to fields marked as immutable.
 */
export class Immutable extends BaseObserver {
    readonly name = 'Immutable';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 30;
    readonly operations: readonly OperationType[] = ['update'];

    async execute(context: ObserverContext): Promise<void> {
        const { model, record } = context;

        if (record.isNew()) return;

        const immutableFields = model.getImmutableFields();
        if (immutableFields.size === 0) return;

        const violations: { field: string; old: unknown; new: unknown }[] = [];

        for (const fieldName of record.getChangedFields()) {
            if (!immutableFields.has(fieldName)) continue;

            const oldValue = record.old(fieldName);
            const newValue = record.get(fieldName);

            // Allow first write (old was null/undefined)
            if (oldValue === null || oldValue === undefined) continue;

            if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
                violations.push({ field: fieldName, old: oldValue, new: newValue });
            }
        }

        if (violations.length > 0) {
            const details = violations
                .map(v => `${v.field} (was: ${JSON.stringify(v.old)})`)
                .join(', ');

            throw new EOBSIMMUT(
                `Cannot modify immutable field(s): ${details}`,
                violations[0].field
            );
        }
    }
}

export default Immutable;
```

#### Constraints (`src/model/ring/1/40-constraints.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext, FieldRow } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSINVALID } from '../../observers/errors.js';

interface ValidationErrorDetail {
    field: string;
    message: string;
    code: string;
}

/**
 * Validates field data against constraints.
 */
export class Constraints extends BaseObserver {
    readonly name = 'Constraints';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 40;
    readonly operations: readonly OperationType[] = ['create', 'update'];

    async execute(context: ObserverContext): Promise<void> {
        const { model, record, operation } = context;

        const validationFields = model.getValidationFields();
        if (validationFields.length === 0) return;

        const errors: ValidationErrorDetail[] = [];

        for (const field of validationFields) {
            if (operation === 'update' && !record.has(field.field_name)) {
                continue;
            }

            const value = record.get(field.field_name);
            this.validateField(field, value, operation, errors);
        }

        if (errors.length > 0) {
            const summary = errors.map(e => `${e.field}: ${e.message}`).join('; ');
            throw new EOBSINVALID(
                `Validation failed: ${summary}`,
                errors[0].field
            );
        }
    }

    private validateField(
        field: FieldRow,
        value: unknown,
        operation: string,
        errors: ValidationErrorDetail[]
    ): void {
        // Required check
        if (field.required && (value === null || value === undefined)) {
            if (operation === 'create') {
                errors.push({
                    field: field.field_name,
                    message: 'is required',
                    code: 'REQUIRED',
                });
            }
            return;
        }

        if (value === null || value === undefined) return;

        // Type check
        const typeError = this.validateType(value, field.type, field.is_array);
        if (typeError) {
            errors.push({
                field: field.field_name,
                message: typeError,
                code: 'INVALID_TYPE',
            });
            return;
        }

        // Minimum/maximum for numbers
        if (field.minimum !== null && typeof value === 'number') {
            if (value < field.minimum) {
                errors.push({
                    field: field.field_name,
                    message: `must be >= ${field.minimum}`,
                    code: 'BELOW_MINIMUM',
                });
            }
        }
        if (field.maximum !== null && typeof value === 'number') {
            if (value > field.maximum) {
                errors.push({
                    field: field.field_name,
                    message: `must be <= ${field.maximum}`,
                    code: 'ABOVE_MAXIMUM',
                });
            }
        }

        // Pattern for strings
        if (field.pattern && typeof value === 'string') {
            const regex = new RegExp(field.pattern);
            if (!regex.test(value)) {
                errors.push({
                    field: field.field_name,
                    message: `does not match pattern ${field.pattern}`,
                    code: 'PATTERN_MISMATCH',
                });
            }
        }

        // Enum values
        if (field.enum_values) {
            const allowed = JSON.parse(field.enum_values) as string[];
            if (!allowed.includes(String(value))) {
                errors.push({
                    field: field.field_name,
                    message: `must be one of: ${allowed.join(', ')}`,
                    code: 'INVALID_ENUM',
                });
            }
        }
    }

    private validateType(value: unknown, type: string, isArray: boolean): string | null {
        if (isArray) {
            if (!Array.isArray(value)) {
                return `expected array, got ${typeof value}`;
            }
            const baseType = type.replace('[]', '');
            for (const item of value) {
                const itemError = this.validateScalarType(item, baseType);
                if (itemError) return itemError;
            }
            return null;
        }
        return this.validateScalarType(value, type);
    }

    private validateScalarType(value: unknown, type: string): string | null {
        switch (type) {
            case 'text':
            case 'uuid':
            case 'timestamp':
            case 'date':
                if (typeof value !== 'string') {
                    return `expected string, got ${typeof value}`;
                }
                break;
            case 'integer':
                if (typeof value !== 'number' || !Number.isInteger(value)) {
                    return `expected integer, got ${typeof value}`;
                }
                break;
            case 'numeric':
                if (typeof value !== 'number') {
                    return `expected number, got ${typeof value}`;
                }
                break;
            case 'boolean':
                if (typeof value !== 'boolean') {
                    return `expected boolean, got ${typeof value}`;
                }
                break;
            case 'jsonb':
                break;
        }
        return null;
    }
}

export default Constraints;
```

### Ring 4: Enrichment

#### TransformProcessor (`src/model/ring/4/50-transform-processor.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

/**
 * Applies auto-transforms to field values.
 */
export class TransformProcessor extends BaseObserver {
    readonly name = 'TransformProcessor';
    readonly ring = ObserverRing.Enrichment;
    readonly priority = 50;
    readonly operations: readonly OperationType[] = ['create', 'update'];

    async execute(context: ObserverContext): Promise<void> {
        const { model, record } = context;

        const transforms = model.getTransformFields();
        if (transforms.size === 0) return;

        for (const [fieldName, transformType] of transforms) {
            const value = record.new(fieldName);
            if (value === null || value === undefined) continue;

            const transformed = this.applyTransform(value, transformType);
            if (transformed !== value) {
                record.set(fieldName, transformed);
            }
        }
    }

    private applyTransform(value: unknown, transform: string): unknown {
        const str = String(value);

        switch (transform) {
            case 'lowercase':
                return str.toLowerCase();
            case 'uppercase':
                return str.toUpperCase();
            case 'trim':
                return str.trim();
            case 'normalize_email':
                return str.trim().toLowerCase();
            case 'normalize_phone':
                const hasPlus = str.trimStart().startsWith('+');
                const digits = str.replace(/\D/g, '');
                return (hasPlus ? '+' : '') + digits;
            default:
                console.warn(`Unknown transform: ${transform}`);
                return value;
        }
    }
}

export default TransformProcessor;
```

### Ring 5: Database Operations

Ring 5 observers are the persistence boundary - records that pass Ring 5 are committed to the database. Prior rings can reject; post-database rings (6-9) observe but cannot undo.

#### SqlCreate (`src/model/ring/5/50-sql-create.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

/**
 * Executes INSERT statement for new records.
 *
 * INVARIANTS:
 * - Record must have an id before reaching this observer
 * - Record must have created_at and updated_at set
 * - SQL execution uses parameterized queries (no string interpolation)
 * - Database errors are wrapped in EOBSSYS
 */
export class SqlCreate extends BaseObserver {
    readonly name = 'SqlCreate';
    readonly ring = ObserverRing.Database;
    readonly priority = 50;
    readonly operations: readonly OperationType[] = ['create'];

    async execute(context: ObserverContext): Promise<void> {
        const { model, record, system } = context;

        const data = record.toRecord();
        const columns = Object.keys(data);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map((col) => data[col]);

        const sql = `INSERT INTO ${model.modelName} (${columns.join(', ')}) VALUES (${placeholders})`;

        try {
            await system.db.execute(sql, values);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const recordId = data.id ?? 'unknown';
            throw new EOBSSYS(
                `INSERT failed for ${model.modelName}[${recordId}]: ${message}`
            );
        }
    }
}

export default SqlCreate;
```

#### SqlUpdate (`src/model/ring/5/50-sql-update.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

/**
 * Executes UPDATE statement for modified records.
 *
 * INVARIANTS:
 * - Record must have an id
 * - Only changed fields are included in SET clause
 * - Empty changes result in no-op (no SQL executed)
 */
export class SqlUpdate extends BaseObserver {
    readonly name = 'SqlUpdate';
    readonly ring = ObserverRing.Database;
    readonly priority = 50;
    readonly operations: readonly OperationType[] = ['update'];

    async execute(context: ObserverContext): Promise<void> {
        const { model, record, system } = context;

        const changes = record.toChanges();
        const id = record.get('id') as string;
        const columns = Object.keys(changes);

        // No changes to apply - valid no-op
        if (columns.length === 0) {
            return;
        }

        const setClauses = columns.map((col) => `${col} = ?`).join(', ');
        const values = columns.map((col) => changes[col]);
        values.push(id);

        const sql = `UPDATE ${model.modelName} SET ${setClauses} WHERE id = ?`;

        try {
            await system.db.execute(sql, values);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new EOBSSYS(
                `UPDATE failed for ${model.modelName}[${id}]: ${message}`
            );
        }
    }
}

export default SqlUpdate;
```

#### SqlDelete (`src/model/ring/5/50-sql-delete.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

/**
 * Executes soft DELETE (sets trashed_at) for records.
 *
 * WHY soft delete: Preserves data for recovery and audit. Hard delete
 * (expireAll) is a separate, explicit operation for permanent removal.
 *
 * INVARIANTS:
 * - Record must have an id
 * - trashed_at is set by DatabaseOps before observer pipeline
 * - Soft delete is UPDATE, not DELETE (data preserved)
 */
export class SqlDelete extends BaseObserver {
    readonly name = 'SqlDelete';
    readonly ring = ObserverRing.Database;
    readonly priority = 50;
    readonly operations: readonly OperationType[] = ['delete'];

    async execute(context: ObserverContext): Promise<void> {
        const { model, record, system } = context;

        const id = record.get('id') as string;
        const trashedAt = record.get('trashed_at');

        const sql = `UPDATE ${model.modelName} SET trashed_at = ? WHERE id = ?`;

        try {
            await system.db.execute(sql, [trashedAt, id]);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new EOBSSYS(
                `DELETE (soft) failed for ${model.modelName}[${id}]: ${message}`
            );
        }
    }
}

export default SqlDelete;
```

#### Ring 5 Index (`src/model/ring/5/index.ts`)

```typescript
export { SqlCreate } from './50-sql-create.js';
export { SqlUpdate } from './50-sql-update.js';
export { SqlDelete } from './50-sql-delete.js';
```

### Ring 6: DDL Operations

#### DdlCreateModel (`src/model/ring/6/10-ddl-create-model.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

/**
 * Creates table for new model.
 * Only runs for 'models' table creates.
 */
export class DdlCreateModel extends BaseObserver {
    readonly name = 'DdlCreateModel';
    readonly ring = ObserverRing.PostDatabase;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];
    readonly models: readonly string[] = ['models'];

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;

        const modelName = record.get('model_name') as string;

        const sql = `
            CREATE TABLE IF NOT EXISTS ${modelName} (
                id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                created_at  TEXT DEFAULT (datetime('now')),
                updated_at  TEXT DEFAULT (datetime('now')),
                trashed_at  TEXT,
                expired_at  TEXT
            )
        `;

        await system.db.exec(sql);
    }
}

export default DdlCreateModel;
```

#### DdlCreateField (`src/model/ring/6/10-ddl-create-field.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

/**
 * Adds column for new field.
 * Only runs for 'fields' table creates.
 */
export class DdlCreateField extends BaseObserver {
    readonly name = 'DdlCreateField';
    readonly ring = ObserverRing.PostDatabase;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];
    readonly models: readonly string[] = ['fields'];

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;

        const modelName = record.get('model_name') as string;
        const fieldName = record.get('field_name') as string;
        const fieldType = record.get('type') as string;

        const sqlType = this.mapType(fieldType);
        const sql = `ALTER TABLE ${modelName} ADD COLUMN ${fieldName} ${sqlType}`;

        try {
            await system.db.exec(sql);
        } catch (error) {
            // Column might already exist
            console.warn(`Failed to add column ${fieldName} to ${modelName}:`, error);
        }
    }

    private mapType(type: string): string {
        switch (type) {
            case 'integer':
                return 'INTEGER';
            case 'numeric':
                return 'REAL';
            case 'boolean':
                return 'INTEGER';
            case 'binary':
                return 'BLOB';
            default:
                return 'TEXT';
        }
    }
}

export default DdlCreateField;
```

### Ring 7: Audit

#### Tracked (`src/model/ring/7/60-tracked.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

/**
 * Records changes to tracked fields.
 */
export class Tracked extends BaseObserver {
    readonly name = 'Tracked';
    readonly ring = ObserverRing.Audit;
    readonly priority = 60;
    readonly operations: readonly OperationType[] = ['create', 'update', 'delete'];

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record, operation } = context;

        const trackedFields = model.getTrackedFields();
        if (trackedFields.size === 0) return;

        const diff = record.getDiff();
        const trackedChanges: Record<string, { old: unknown; new: unknown }> = {};

        for (const [field, change] of Object.entries(diff)) {
            if (trackedFields.has(field)) {
                trackedChanges[field] = change;
            }
        }

        if (Object.keys(trackedChanges).length === 0) return;

        const trackRecord = {
            id: crypto.randomUUID(),
            model_name: model.modelName,
            record_id: record.get('id'),
            operation,
            changes: JSON.stringify(trackedChanges),
            created_at: new Date().toISOString(),
        };

        const sql = `
            INSERT INTO tracked (id, model_name, record_id, operation, changes, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        await system.db.execute(sql, [
            trackRecord.id,
            trackRecord.model_name,
            trackRecord.record_id,
            trackRecord.operation,
            trackRecord.changes,
            trackRecord.created_at
        ]);
    }
}

export default Tracked;
```

### Ring 8: Integration

#### Cache (`src/model/ring/8/50-cache.ts`)

```typescript
import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

/**
 * Invalidates model cache after model/field changes.
 * Only runs for 'models' and 'fields' table operations.
 */
export class Cache extends BaseObserver {
    readonly name = 'Cache';
    readonly ring = ObserverRing.Integration;
    readonly priority = 50;
    readonly operations: readonly OperationType[] = ['create', 'update', 'delete'];
    readonly models: readonly string[] = ['models', 'fields'];

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        // Both 'models' and 'fields' tables have model_name column
        const targetModel = record.get('model_name') as string;
        system.cache.invalidate(targetModel);
    }
}

export default Cache;
```

## Observer Registry

`src/model/observers/registry.ts`:

```typescript
import { ObserverRunner } from './runner.js';

// Ring 1: Input Validation (implemented, not yet registered)
import { Frozen, Immutable, Constraints } from '../ring/1/index.js';

// Ring 5: Database Operations (implemented, registered)
import { SqlCreate, SqlUpdate, SqlDelete } from '../ring/5/index.js';

// Ring 6: DDL Operations (implemented, not yet registered)
import { DdlCreateModel, DdlCreateField } from '../ring/6/index.js';

export function createObserverRunner(): ObserverRunner {
    const runner = new ObserverRunner();

    // =========================================================================
    // RING 0: DATA PREPARATION
    // =========================================================================
    // TODO: runner.register(new UpdateMerger());

    // =========================================================================
    // RING 1: INPUT VALIDATION (implemented, needs registration)
    // =========================================================================
    // TODO: runner.register(new Frozen());
    // TODO: runner.register(new Immutable());
    // TODO: runner.register(new Constraints());

    // =========================================================================
    // RING 4: ENRICHMENT
    // =========================================================================
    // TODO: runner.register(new TransformProcessor());

    // =========================================================================
    // RING 5: DATABASE (active)
    // =========================================================================
    runner.register(new SqlCreate());
    runner.register(new SqlUpdate());
    runner.register(new SqlDelete());

    // =========================================================================
    // RING 6: POST-DATABASE (implemented, needs registration)
    // =========================================================================
    // TODO: runner.register(new DdlCreateModel());
    // TODO: runner.register(new DdlCreateField());

    // =========================================================================
    // RING 7: AUDIT
    // =========================================================================
    // TODO: runner.register(new Tracked());

    // =========================================================================
    // RING 8: INTEGRATION
    // =========================================================================
    // TODO: runner.register(new Cache());

    return runner;
}
```

## Directory Structure

```
src/model/
├── observers/                   # Observer infrastructure
│   ├── types.ts                 # ObserverRing enum, OperationType
│   ├── interfaces.ts            # Model, ModelRecord, Observer, SystemContext
│   ├── errors.ts                # EOBS* error classes
│   ├── base-observer.ts         # BaseObserver abstract class
│   ├── runner.ts                # ObserverRunner pipeline executor
│   ├── registry.ts              # createObserverRunner() factory
│   └── index.ts                 # Public exports
├── ring/                        # Observer implementations by ring
│   ├── 0/                       # Ring 0: Data Preparation (not started)
│   │   └── 50-update-merger.ts
│   ├── 1/                       # Ring 1: Input Validation (implemented)
│   │   ├── 10-frozen.ts         ✅
│   │   ├── 30-immutable.ts      ✅
│   │   ├── 40-constraints.ts    ✅
│   │   └── index.ts             ✅
│   ├── 4/                       # Ring 4: Enrichment (not started)
│   │   └── 50-transform-processor.ts
│   ├── 5/                       # Ring 5: Database (registered)
│   │   ├── 50-sql-create.ts     ✅
│   │   ├── 50-sql-update.ts     ✅
│   │   ├── 50-sql-delete.ts     ✅
│   │   └── index.ts             ✅
│   ├── 6/                       # Ring 6: Post-Database (implemented)
│   │   ├── 10-ddl-create-model.ts ✅
│   │   ├── 10-ddl-create-field.ts ✅
│   │   └── index.ts             ✅
│   ├── 7/                       # Ring 7: Audit (not started)
│   │   └── 60-tracked.ts
│   └── 8/                       # Ring 8: Integration (not started)
│       └── 50-cache.ts
```

File naming convention: `{priority}-{observer-name}.ts` (e.g., `50-sql-create.ts`)

## Acceptance Criteria

### Ring 1: Input Validation (implemented, not registered)
- [x] Frozen blocks changes to frozen models
- [x] Immutable blocks changes to immutable fields
- [x] Constraints validates required, type, min/max, pattern, enum

### Ring 4: Enrichment (not started)
- [ ] TransformProcessor applies lowercase, uppercase, trim, normalize_*

### Ring 5: Database (registered, active)
- [x] SqlCreate inserts records
- [x] SqlUpdate updates records
- [x] SqlDelete soft-deletes records

### Ring 6: DDL (implemented, not registered)
- [x] DdlCreateModel creates tables for new models
- [x] DdlCreateField adds columns for new fields

### Ring 7-8: Audit & Integration (not started)
- [ ] Tracked records change history
- [ ] Cache clears cache on model/field changes

## Next Steps

1. **Register Ring 1 observers** - Enable validation in the pipeline
2. **Register Ring 6 observers** - Enable automatic DDL on model/field creation
3. **Implement Ring 0** - UpdateMerger for update operations
4. **Implement Ring 4** - TransformProcessor for auto-transforms
5. **Implement Ring 7-8** - Tracked audit and Cache invalidation

## Next Phase

Once observers are complete, proceed to [Phase 5: Model Loader](./05-model-loader.md) to load YAML/JSON definitions.
