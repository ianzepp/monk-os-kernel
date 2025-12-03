# Phase 4: Core Observers

## Overview

Observers implement the behavioral enforcement specified in field/model metadata. Each observer runs at a specific ring and priority, handling specific operations on specific models.

## Observer Inventory

### Essential Observers (Minimum Viable)

| Ring | Priority | Observer | Operations | Purpose |
|------|----------|----------|------------|---------|
| 0 | 50 | UpdateMerger | update | Merge input with existing data |
| 1 | 10 | FrozenValidator | create, update, delete | Block changes to frozen models |
| 1 | 30 | ImmutableValidator | update | Block changes to immutable fields |
| 1 | 40 | DataValidator | create, update | Validate types and constraints |
| 4 | 50 | TransformProcessor | create, update | Apply auto-transforms |
| 5 | 50 | SqlCreate | create | Execute INSERT |
| 5 | 50 | SqlUpdate | update | Execute UPDATE |
| 5 | 50 | SqlDelete | delete | Execute soft DELETE |
| 6 | 10 | ModelDdlCreate | create (models) | CREATE TABLE |
| 6 | 10 | FieldDdlCreate | create (fields) | ALTER TABLE ADD COLUMN |
| 7 | 60 | Tracked | create, update, delete | Record change history |
| 8 | 50 | CacheInvalidator | * (models, fields) | Invalidate model cache |

### Nice-to-Have Observers

| Ring | Priority | Observer | Purpose |
|------|----------|----------|---------|
| 1 | 20 | ModelSudoValidator | Require sudo for model operations |
| 1 | 25 | FieldSudoValidator | Require sudo for field operations |
| 2 | 50 | ExistenceValidator | Verify record exists for update/delete |
| 6 | 10 | FieldDdlDelete | ALTER TABLE DROP COLUMN |
| 6 | 20 | DdlIndexes | CREATE/DROP INDEX |

## Observer Implementations

### Ring 0: Data Preparation

#### UpdateMerger (`src/model/observers/impl/update-merger.ts`)

**Source:** `monk-api/src/observers/all/0/50-update-merger.ts`

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';

/**
 * Merges input data with existing record for updates
 *
 * This is handled by ModelRecord, but we ensure the merge is complete
 * and apply any default values for missing fields.
 */
export default class UpdateMerger extends BaseObserver {
    readonly name = 'UpdateMerger';
    readonly ring = ObserverRing.DataPreparation;
    readonly priority = 50;
    readonly operations = ['update'] as const;

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

        // Ensure updated_at will be set (done in DatabaseService, but verify)
        if (!record.has('updated_at')) {
            record.set('updated_at', new Date().toISOString());
        }
    }
}
```

### Ring 1: Input Validation

#### FrozenValidator (`src/model/observers/impl/frozen-validator.ts`)

**Source:** `monk-api/src/observers/all/1/10-frozen-validator.ts`

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';
import { EOBSFROZEN } from '../errors';

/**
 * Prevents any data changes to frozen models
 */
export default class FrozenValidator extends BaseObserver {
    readonly name = 'FrozenValidator';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 10;
    readonly operations = ['create', 'update', 'delete'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { model } = context;

        if (model.isFrozen) {
            throw new EOBSFROZEN(
                `Model '${model.model_name}' is frozen and cannot be modified`
            );
        }
    }
}
```

#### ImmutableValidator (`src/model/observers/impl/immutable-validator.ts`)

**Source:** `monk-api/src/observers/all/1/30-immutable-validator.ts`

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';
import { EOBSIMMUT } from '../errors';

/**
 * Prevents changes to fields marked as immutable
 */
export default class ImmutableValidator extends BaseObserver {
    readonly name = 'ImmutableValidator';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 30;
    readonly operations = ['update'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { model, record } = context;

        // Skip for new records
        if (record.isNew()) return;

        const immutableFields = model.getImmutableFields();
        if (immutableFields.size === 0) return;

        const violations: { field: string; old: unknown; new: unknown }[] = [];

        for (const fieldName of record.getChangedFields()) {
            if (!immutableFields.has(fieldName)) continue;

            const oldValue = record.old(fieldName);
            const newValue = record.new(fieldName);

            // Allow first write (old was null/undefined)
            if (oldValue === null || oldValue === undefined) continue;

            // Check if actually changing
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
```

#### DataValidator (`src/model/observers/impl/data-validator.ts`)

**Source:** `monk-api/src/observers/all/1/40-data-validator.ts`

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';
import { EOBSINVALID } from '../errors';
import type { FieldRow } from '../interfaces';

interface ValidationErrorDetail {
    field: string;
    message: string;
    code: string;
}

/**
 * Validates field data against constraints
 */
export default class DataValidator extends BaseObserver {
    readonly name = 'DataValidator';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 40;
    readonly operations = ['create', 'update'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { model, record, operation } = context;

        const validationFields = model.getValidationFields();
        if (validationFields.length === 0) return;

        const errors: ValidationErrorDetail[] = [];

        for (const field of validationFields) {
            // For updates, only validate fields being changed
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
            // For creates, always require
            // For updates, only if the field is being set to null
            if (operation === 'create') {
                errors.push({
                    field: field.field_name,
                    message: 'is required',
                    code: 'REQUIRED',
                });
            }
            return;  // Skip other validations if null
        }

        // Skip further validation for null values
        if (value === null || value === undefined) return;

        // Type check
        const typeError = this.validateType(value, field.type, field.is_array);
        if (typeError) {
            errors.push({
                field: field.field_name,
                message: typeError,
                code: 'INVALID_TYPE',
            });
            return;  // Skip constraint checks if wrong type
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
            // Validate array elements
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
                // Any value is valid for JSON
                break;
        }
        return null;
    }
}
```

### Ring 4: Enrichment

#### TransformProcessor (`src/model/observers/impl/transform-processor.ts`)

**Source:** `monk-api/src/observers/all/4/50-transform-processor.ts`

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';

/**
 * Applies auto-transforms to field values
 */
export default class TransformProcessor extends BaseObserver {
    readonly name = 'TransformProcessor';
    readonly ring = ObserverRing.Enrichment;
    readonly priority = 50;
    readonly operations = ['create', 'update'] as const;

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
```

### Ring 5: Database Operations

#### SqlCreate (`src/model/observers/impl/sql-create.ts`)

**Source:** `monk-api/src/observers/all/5/50-sql-create-sqlite.ts`

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';

/**
 * Executes INSERT statement
 */
export default class SqlCreate extends BaseObserver {
    readonly name = 'SqlCreate';
    readonly ring = ObserverRing.Database;
    readonly priority = 50;
    readonly operations = ['create'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        const data = record.toRecord();
        const fields = Object.keys(data);
        const placeholders = fields.map(() => '?');
        const values = fields.map(f => data[f]);

        const sql = `
            INSERT INTO ${model.model_name} (${fields.join(', ')})
            VALUES (${placeholders.join(', ')})
        `;

        system.db.prepare(sql).run(...values);
    }
}
```

#### SqlUpdate (`src/model/observers/impl/sql-update.ts`)

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';

/**
 * Executes UPDATE statement
 */
export default class SqlUpdate extends BaseObserver {
    readonly name = 'SqlUpdate';
    readonly ring = ObserverRing.Database;
    readonly priority = 50;
    readonly operations = ['update'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        const changes = record.toChanges();
        const id = record.get('id');

        const setClauses = Object.keys(changes).map(f => `${f} = ?`);
        const values = [...Object.values(changes), id];

        const sql = `
            UPDATE ${model.model_name}
            SET ${setClauses.join(', ')}
            WHERE id = ?
        `;

        system.db.prepare(sql).run(...values);
    }
}
```

#### SqlDelete (`src/model/observers/impl/sql-delete.ts`)

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';

/**
 * Executes soft DELETE (sets trashed_at)
 */
export default class SqlDelete extends BaseObserver {
    readonly name = 'SqlDelete';
    readonly ring = ObserverRing.Database;
    readonly priority = 50;
    readonly operations = ['delete'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        const id = record.get('id');
        const trashedAt = record.get('trashed_at');

        const sql = `
            UPDATE ${model.model_name}
            SET trashed_at = ?
            WHERE id = ?
        `;

        system.db.prepare(sql).run(trashedAt, id);
    }
}
```

### Ring 6: DDL Operations

#### ModelDdlCreate (`src/model/observers/impl/model-ddl-create.ts`)

**Source:** `monk-api/src/observers/models/6/10-model-ddl-create-sqlite.ts`

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';

/**
 * Creates table for new model
 */
export default class ModelDdlCreate extends BaseObserver {
    readonly name = 'ModelDdlCreate';
    readonly ring = ObserverRing.PostDatabase;
    readonly priority = 10;
    readonly operations = ['create'] as const;
    readonly models = ['models'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;

        const modelName = record.get('model_name') as string;

        // Create table with system fields
        const sql = `
            CREATE TABLE IF NOT EXISTS ${modelName} (
                id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                created_at  TEXT DEFAULT (datetime('now')),
                updated_at  TEXT DEFAULT (datetime('now')),
                trashed_at  TEXT,
                expired_at  TEXT
            )
        `;

        system.db.exec(sql);
    }
}
```

#### FieldDdlCreate (`src/model/observers/impl/field-ddl-create.ts`)

**Source:** `monk-api/src/observers/fields/6/10-field-ddl-create-sqlite.ts`

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';

/**
 * Adds column for new field
 */
export default class FieldDdlCreate extends BaseObserver {
    readonly name = 'FieldDdlCreate';
    readonly ring = ObserverRing.PostDatabase;
    readonly priority = 10;
    readonly operations = ['create'] as const;
    readonly models = ['fields'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;

        const modelName = record.get('model_name') as string;
        const fieldName = record.get('field_name') as string;
        const fieldType = record.get('type') as string;

        const sqlType = this.mapType(fieldType);

        const sql = `ALTER TABLE ${modelName} ADD COLUMN ${fieldName} ${sqlType}`;

        try {
            system.db.exec(sql);
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
```

### Ring 7: Audit

#### Tracked (`src/model/observers/impl/tracked.ts`)

**Source:** `monk-api/src/observers/all/7/60-tracked.ts`

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';

/**
 * Records changes to tracked fields
 */
export default class Tracked extends BaseObserver {
    readonly name = 'Tracked';
    readonly ring = ObserverRing.Audit;
    readonly priority = 60;
    readonly operations = ['create', 'update', 'delete'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record, operation } = context;

        const trackedFields = model.getTrackedFields();
        if (trackedFields.size === 0) return;

        // Build changes object
        const diff = record.getDiff();
        const trackedChanges: Record<string, { old: unknown; new: unknown }> = {};

        for (const [field, change] of Object.entries(diff)) {
            if (trackedFields.has(field)) {
                trackedChanges[field] = change;
            }
        }

        if (Object.keys(trackedChanges).length === 0) return;

        // Insert tracking record
        const trackRecord = {
            id: crypto.randomUUID(),
            model_name: model.model_name,
            record_id: record.get('id'),
            operation,
            changes: JSON.stringify(trackedChanges),
            created_at: new Date().toISOString(),
        };

        const sql = `
            INSERT INTO tracked (id, model_name, record_id, operation, changes, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        system.db.prepare(sql).run(
            trackRecord.id,
            trackRecord.model_name,
            trackRecord.record_id,
            trackRecord.operation,
            trackRecord.changes,
            trackRecord.created_at
        );
    }
}
```

### Ring 8: Integration

#### CacheInvalidator (`src/model/observers/impl/cache-invalidator.ts`)

```typescript
import { BaseObserver } from '../base-observer';
import type { ObserverContext } from '../interfaces';
import { ObserverRing } from '../types';

/**
 * Invalidates model cache after model/field changes
 */
export default class CacheInvalidator extends BaseObserver {
    readonly name = 'CacheInvalidator';
    readonly ring = ObserverRing.Integration;
    readonly priority = 50;
    readonly operations = ['create', 'update', 'delete'] as const;
    readonly models = ['models', 'fields'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record } = context;

        // Determine which model to invalidate
        let targetModel: string;

        if (model.model_name === 'models') {
            targetModel = record.get('model_name') as string;
        } else {
            // fields table
            targetModel = record.get('model_name') as string;
        }

        system.cache.invalidate(targetModel);
    }
}
```

## Observer Registry

Update `src/model/observers/registry.ts`:

```typescript
import { ObserverRunner } from './runner';

// Ring 0
import UpdateMerger from './impl/update-merger';

// Ring 1
import FrozenValidator from './impl/frozen-validator';
import ImmutableValidator from './impl/immutable-validator';
import DataValidator from './impl/data-validator';

// Ring 4
import TransformProcessor from './impl/transform-processor';

// Ring 5
import SqlCreate from './impl/sql-create';
import SqlUpdate from './impl/sql-update';
import SqlDelete from './impl/sql-delete';

// Ring 6
import ModelDdlCreate from './impl/model-ddl-create';
import FieldDdlCreate from './impl/field-ddl-create';

// Ring 7
import Tracked from './impl/tracked';

// Ring 8
import CacheInvalidator from './impl/cache-invalidator';

export function createObserverRunner(): ObserverRunner {
    const runner = new ObserverRunner();

    // Ring 0: Data Preparation
    runner.register(new UpdateMerger());

    // Ring 1: Input Validation
    runner.register(new FrozenValidator());
    runner.register(new ImmutableValidator());
    runner.register(new DataValidator());

    // Ring 4: Enrichment
    runner.register(new TransformProcessor());

    // Ring 5: Database
    runner.register(new SqlCreate());
    runner.register(new SqlUpdate());
    runner.register(new SqlDelete());

    // Ring 6: DDL
    runner.register(new ModelDdlCreate());
    runner.register(new FieldDdlCreate());

    // Ring 7: Audit
    runner.register(new Tracked());

    // Ring 8: Integration
    runner.register(new CacheInvalidator());

    return runner;
}
```

## Directory Structure

```
src/model/observers/
├── impl/                        # Observer implementations (Phase 4)
│   ├── update-merger.ts
│   ├── frozen-validator.ts
│   ├── immutable-validator.ts
│   ├── data-validator.ts
│   ├── transform-processor.ts
│   ├── sql-create.ts
│   ├── sql-update.ts
│   ├── sql-delete.ts
│   ├── model-ddl-create.ts
│   ├── field-ddl-create.ts
│   ├── tracked.ts
│   └── cache-invalidator.ts
├── types.ts                     # (Phase 1 - IMPLEMENTED)
├── interfaces.ts                # (Phase 1 - IMPLEMENTED)
├── errors.ts                    # EOBS* error classes (Phase 1 - IMPLEMENTED)
├── base-observer.ts             # (Phase 1 - IMPLEMENTED)
├── runner.ts                    # (Phase 1 - IMPLEMENTED)
├── registry.ts                  # (Phase 1 - IMPLEMENTED, empty until Phase 4)
└── index.ts                     # (Phase 1 - IMPLEMENTED)
```

## Acceptance Criteria

- [ ] FrozenValidator blocks changes to frozen models
- [ ] ImmutableValidator blocks changes to immutable fields
- [ ] DataValidator validates required, type, min/max, pattern, enum
- [ ] TransformProcessor applies lowercase, uppercase, trim, normalize_*
- [ ] SqlCreate inserts records
- [ ] SqlUpdate updates records
- [ ] SqlDelete soft-deletes records
- [ ] ModelDdlCreate creates tables for new models
- [ ] FieldDdlCreate adds columns for new fields
- [ ] Tracked records change history
- [ ] CacheInvalidator clears cache on model/field changes

## Next Phase

Once observers are complete, proceed to [Phase 5: Model Loader](./05-model-loader.md) to load YAML/JSON definitions.
