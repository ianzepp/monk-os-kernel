# Phase 3: Database Layer

## Overview

The database layer provides high-level CRUD operations for **entity metadata**. This is the structured SQL side of the entity+data architecture (see [README.md](./README.md)).

- **Entity reads** (`selectOne`, `selectById`) bypass observers for performance
- **Entity mutations** (`createOne`, `updateOne`, `deleteOne`) always go through the observer pipeline
- **Blob data** (raw file contents) is handled separately via HAL block storage

The VFS will call this layer for `stat()`, `setstat()`, `create()`, `unlink()` operations.

## Core Components

### 1. Model Class (`src/model/model.ts`)

**Source:** `monk-api/src/lib/model.ts`

Wraps model metadata with convenient field accessors:

```typescript
import type { Database } from 'bun:sqlite';

export interface ModelRow {
    id: string;
    model_name: string;
    status: string;
    description?: string;
    sudo: boolean;
    frozen: boolean;
    immutable: boolean;
    external: boolean;
    passthrough: boolean;
}

export interface FieldRow {
    id: string;
    model_name: string;
    field_name: string;
    type: string;
    is_array: boolean;
    required: boolean;
    default_value?: string;
    minimum?: number;
    maximum?: number;
    pattern?: string;
    enum_values?: string;  // JSON array
    immutable: boolean;
    sudo: boolean;
    unique_: boolean;
    index_: boolean;
    tracked: boolean;
    searchable: boolean;
    transform?: string;
    relationship_type?: string;
    related_model?: string;
    description?: string;
}

/**
 * Model wrapper with field metadata caching
 */
export class Model {
    private _fields: Map<string, FieldRow> = new Map();
    private _fieldsByCategory: {
        required: Set<string>;
        immutable: Set<string>;
        sudo: Set<string>;
        tracked: Set<string>;
        transforms: Map<string, string>;
        validation: FieldRow[];
    } | null = null;

    constructor(
        public readonly row: ModelRow,
        fields: FieldRow[]
    ) {
        for (const field of fields) {
            this._fields.set(field.field_name, field);
        }
    }

    get model_name(): string {
        return this.row.model_name;
    }

    get isSystem(): boolean {
        return this.row.status === 'system';
    }

    get isFrozen(): boolean {
        return this.row.frozen;
    }

    get isImmutable(): boolean {
        return this.row.immutable;
    }

    get requiresSudo(): boolean {
        return this.row.sudo;
    }

    /**
     * Get field by name
     */
    getField(name: string): FieldRow | undefined {
        return this._fields.get(name);
    }

    /**
     * Get all fields
     */
    getFields(): FieldRow[] {
        return Array.from(this._fields.values());
    }

    /**
     * Get field names that are required
     */
    getRequiredFields(): Set<string> {
        return this.categorize().required;
    }

    /**
     * Get field names that are immutable
     */
    getImmutableFields(): Set<string> {
        return this.categorize().immutable;
    }

    /**
     * Get field names that require sudo
     */
    getSudoFields(): Set<string> {
        return this.categorize().sudo;
    }

    /**
     * Get field names that are tracked
     */
    getTrackedFields(): Set<string> {
        return this.categorize().tracked;
    }

    /**
     * Get fields with transforms
     */
    getTransformFields(): Map<string, string> {
        return this.categorize().transforms;
    }

    /**
     * Get fields that need validation (have type/constraints)
     */
    getValidationFields(): FieldRow[] {
        return this.categorize().validation;
    }

    private categorize() {
        if (this._fieldsByCategory) return this._fieldsByCategory;

        const required = new Set<string>();
        const immutable = new Set<string>();
        const sudo = new Set<string>();
        const tracked = new Set<string>();
        const transforms = new Map<string, string>();
        const validation: FieldRow[] = [];

        for (const field of this._fields.values()) {
            if (field.required) required.add(field.field_name);
            if (field.immutable) immutable.add(field.field_name);
            if (field.sudo) sudo.add(field.field_name);
            if (field.tracked) tracked.add(field.field_name);
            if (field.transform) transforms.set(field.field_name, field.transform);

            // Fields needing validation
            if (field.type || field.required || field.minimum !== null ||
                field.maximum !== null || field.pattern || field.enum_values) {
                validation.push(field);
            }
        }

        this._fieldsByCategory = { required, immutable, sudo, tracked, transforms, validation };
        return this._fieldsByCategory;
    }
}
```

### 2. ModelRecord Class (`src/model/model-record.ts`)

**Source:** `monk-api/src/lib/model-record.ts`

Tracks changes between original and new values:

```typescript
/**
 * Wraps a record with change tracking
 *
 * Provides:
 * - Access to original values (from DB)
 * - Access to new values (from input)
 * - Merged view (new overrides original)
 * - Change detection
 */
export class ModelRecord {
    private original: Record<string, unknown>;
    private changes: Map<string, unknown> = new Map();

    constructor(
        originalData: Record<string, unknown> = {},
        inputData: Record<string, unknown> = {}
    ) {
        this.original = { ...originalData };

        // Apply input as changes
        for (const [key, value] of Object.entries(inputData)) {
            this.set(key, value);
        }
    }

    /**
     * Is this a new record (no original data)?
     */
    isNew(): boolean {
        return Object.keys(this.original).length === 0 || !this.original.id;
    }

    /**
     * Get original value (from DB)
     */
    old(field: string): unknown {
        return this.original[field];
    }

    /**
     * Get new value (from input)
     */
    new(field: string): unknown {
        return this.changes.get(field);
    }

    /**
     * Get merged value (new if changed, else original)
     */
    get(field: string): unknown {
        if (this.changes.has(field)) {
            return this.changes.get(field);
        }
        return this.original[field];
    }

    /**
     * Check if field is being changed
     */
    has(field: string): boolean {
        return this.changes.has(field);
    }

    /**
     * Set a new value
     */
    set(field: string, value: unknown): void {
        this.changes.set(field, value);
    }

    /**
     * Remove a change (revert to original)
     */
    unset(field: string): void {
        this.changes.delete(field);
    }

    /**
     * Get all changed field names
     */
    getChangedFields(): string[] {
        return Array.from(this.changes.keys());
    }

    /**
     * Get merged record for database insert/update
     */
    toRecord(): Record<string, unknown> {
        const result = { ...this.original };
        for (const [key, value] of this.changes) {
            result[key] = value;
        }
        return result;
    }

    /**
     * Get only the changes (for update statements)
     */
    toChanges(): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const [key, value] of this.changes) {
            result[key] = value;
        }
        return result;
    }

    /**
     * Get change diff for tracking
     */
    getDiff(): Record<string, { old: unknown; new: unknown }> {
        const diff: Record<string, { old: unknown; new: unknown }> = {};
        for (const [key, newValue] of this.changes) {
            const oldValue = this.original[key];
            if (oldValue !== newValue) {
                diff[key] = { old: oldValue, new: newValue };
            }
        }
        return diff;
    }
}
```

### 3. Model Cache (`src/model/model-cache.ts`)

Caches loaded models to avoid repeated queries:

```typescript
import type { Database } from 'bun:sqlite';
import { Model, type ModelRow, type FieldRow } from './model';

/**
 * Caches model metadata for fast lookup
 */
export class ModelCache {
    private models: Map<string, Model> = new Map();
    private fieldsStmt: ReturnType<Database['prepare']>;
    private modelStmt: ReturnType<Database['prepare']>;

    constructor(private db: Database) {
        this.modelStmt = db.prepare(`
            SELECT * FROM models
            WHERE model_name = ? AND trashed_at IS NULL
        `);
        this.fieldsStmt = db.prepare(`
            SELECT * FROM fields
            WHERE model_name = ? AND trashed_at IS NULL
            ORDER BY field_name
        `);
    }

    /**
     * Get model by name (cached)
     */
    get(modelName: string): Model | undefined {
        if (this.models.has(modelName)) {
            return this.models.get(modelName);
        }

        const row = this.modelStmt.get(modelName) as ModelRow | null;
        if (!row) return undefined;

        const fields = this.fieldsStmt.all(modelName) as FieldRow[];
        const model = new Model(row, fields);

        this.models.set(modelName, model);
        return model;
    }

    /**
     * Get model or throw 404
     */
    require(modelName: string): Model {
        const model = this.get(modelName);
        if (!model) {
            throw new Error(`Model '${modelName}' not found`);
        }
        return model;
    }

    /**
     * Invalidate cache for model
     */
    invalidate(modelName: string): void {
        this.models.delete(modelName);
    }

    /**
     * Clear entire cache
     */
    clear(): void {
        this.models.clear();
    }
}
```

### 4. Database Service (`src/model/database.ts`)

**Source:** `monk-api/src/lib/database/service.ts`

High-level CRUD with observer pipeline:

```typescript
import type { Database as SqliteDb } from 'bun:sqlite';
import { Model } from './model';
import { ModelRecord } from './model-record';
import { ModelCache } from './model-cache';
import { ObserverRunner } from './observers/runner';
import type { ObserverContext } from './observers/interfaces';

export interface SystemContext {
    db: SqliteDb;
    cache: ModelCache;
    runner: ObserverRunner;
}

export interface DbRecord {
    id: string;
    created_at: string;
    updated_at: string;
    trashed_at: string | null;
    expired_at: string | null;
    [key: string]: unknown;
}

/**
 * Database service with observer pipeline
 */
export class DatabaseService {
    constructor(private ctx: SystemContext) {}

    // =========================================================================
    // SELECT OPERATIONS (bypass observer pipeline)
    // =========================================================================

    /**
     * Select multiple records
     */
    selectAny<T extends DbRecord>(
        modelName: string,
        where: Record<string, unknown> = {},
        options: { limit?: number; offset?: number; order?: string[] } = {}
    ): T[] {
        const model = this.ctx.cache.require(modelName);
        const tableName = this.getTableName(model);

        // Build WHERE clause
        const conditions: string[] = ['trashed_at IS NULL'];
        const params: unknown[] = [];

        for (const [key, value] of Object.entries(where)) {
            conditions.push(`${key} = ?`);
            params.push(value);
        }

        let sql = `SELECT * FROM ${tableName} WHERE ${conditions.join(' AND ')}`;

        if (options.order?.length) {
            sql += ` ORDER BY ${options.order.join(', ')}`;
        }
        if (options.limit) {
            sql += ` LIMIT ${options.limit}`;
        }
        if (options.offset) {
            sql += ` OFFSET ${options.offset}`;
        }

        return this.ctx.db.prepare(sql).all(...params) as T[];
    }

    /**
     * Select single record by filter
     */
    selectOne<T extends DbRecord>(
        modelName: string,
        where: Record<string, unknown>
    ): T | null {
        const results = this.selectAny<T>(modelName, where, { limit: 1 });
        return results[0] || null;
    }

    /**
     * Select single record or throw
     */
    select404<T extends DbRecord>(
        modelName: string,
        where: Record<string, unknown>,
        message?: string
    ): T {
        const result = this.selectOne<T>(modelName, where);
        if (!result) {
            throw new Error(message || `Record not found in ${modelName}`);
        }
        return result;
    }

    /**
     * Select by ID
     */
    selectById<T extends DbRecord>(modelName: string, id: string): T | null {
        return this.selectOne<T>(modelName, { id });
    }

    /**
     * Count records
     */
    count(modelName: string, where: Record<string, unknown> = {}): number {
        const model = this.ctx.cache.require(modelName);
        const tableName = this.getTableName(model);

        const conditions: string[] = ['trashed_at IS NULL'];
        const params: unknown[] = [];

        for (const [key, value] of Object.entries(where)) {
            conditions.push(`${key} = ?`);
            params.push(value);
        }

        const sql = `SELECT COUNT(*) as count FROM ${tableName} WHERE ${conditions.join(' AND ')}`;
        const result = this.ctx.db.prepare(sql).get(...params) as { count: number };
        return result.count;
    }

    // =========================================================================
    // MUTATION OPERATIONS (through observer pipeline)
    // =========================================================================

    /**
     * Create a single record
     */
    async createOne<T extends DbRecord>(
        modelName: string,
        data: Record<string, unknown>
    ): Promise<T> {
        const model = this.ctx.cache.require(modelName);
        const record = new ModelRecord({}, data);

        // Generate ID if not provided
        if (!record.get('id')) {
            record.set('id', crypto.randomUUID());
        }

        // Set timestamps
        const now = new Date().toISOString();
        record.set('created_at', now);
        record.set('updated_at', now);

        const context = this.createContext('create', model, record);
        await this.ctx.runner.run(context);

        return this.selectById<T>(modelName, record.get('id') as string)!;
    }

    /**
     * Create multiple records
     */
    async createAll<T extends DbRecord>(
        modelName: string,
        dataArray: Record<string, unknown>[]
    ): Promise<T[]> {
        const results: T[] = [];
        for (const data of dataArray) {
            const result = await this.createOne<T>(modelName, data);
            results.push(result);
        }
        return results;
    }

    /**
     * Update a single record by ID
     */
    async updateOne<T extends DbRecord>(
        modelName: string,
        id: string,
        changes: Record<string, unknown>
    ): Promise<T> {
        const model = this.ctx.cache.require(modelName);

        // Load existing record
        const existing = this.selectById(modelName, id);
        if (!existing) {
            throw new Error(`Record ${id} not found in ${modelName}`);
        }

        const record = new ModelRecord(existing, changes);
        record.set('updated_at', new Date().toISOString());

        const context = this.createContext('update', model, record);
        await this.ctx.runner.run(context);

        return this.selectById<T>(modelName, id)!;
    }

    /**
     * Soft delete a record
     */
    async deleteOne<T extends DbRecord>(
        modelName: string,
        id: string
    ): Promise<T> {
        const model = this.ctx.cache.require(modelName);

        const existing = this.selectById(modelName, id);
        if (!existing) {
            throw new Error(`Record ${id} not found in ${modelName}`);
        }

        const record = new ModelRecord(existing, {
            trashed_at: new Date().toISOString(),
        });

        const context = this.createContext('delete', model, record);
        await this.ctx.runner.run(context);

        // Return the record as it was before deletion
        return existing as T;
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    private getTableName(model: Model): string {
        // System models use their name directly
        // User models could be prefixed or use a different naming scheme
        return model.model_name;
    }

    private createContext(
        operation: 'create' | 'update' | 'delete',
        model: Model,
        record: ModelRecord,
        index: number = 0
    ): ObserverContext {
        return {
            system: this.ctx,
            operation,
            model,
            record,
            recordIndex: index,
            errors: [],
            warnings: [],
        };
    }
}
```

### 5. System Context Factory (`src/model/context.ts`)

Creates the system context:

```typescript
import { Database } from 'bun:sqlite';
import { ModelCache } from './model-cache';
import { createObserverRunner } from './observers/registry';
import { DatabaseService, type SystemContext } from './database';

export interface DbConfig {
    path?: string;  // SQLite path, default ':memory:'
}

/**
 * Initialize database system
 */
export function createDbContext(config: DbConfig = {}): SystemContext {
    const db = new Database(config.path || ':memory:');

    // Initialize schema
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // Execute schema.sql here...

    const cache = new ModelCache(db);
    const runner = createObserverRunner();

    return { db, cache, runner };
}

/**
 * Create database service
 */
export function createDatabase(ctx: SystemContext): DatabaseService {
    return new DatabaseService(ctx);
}
```

## Directory Structure

```
src/model/
├── model.ts           # Model class with field metadata
├── model-record.ts    # Change tracking wrapper
├── model-cache.ts     # Model metadata cache
├── database.ts        # DatabaseService (CRUD + pipeline)
├── context.ts         # System context factory
├── schema.sql         # (from Phase 2)
└── observers/         # (from Phase 1 - IMPLEMENTED)
    ├── types.ts
    ├── errors.ts
    ├── interfaces.ts
    ├── base-observer.ts
    ├── runner.ts
    ├── registry.ts
    └── index.ts
```

## Testing Strategy

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { createDbContext, createDatabase } from './context';

describe('DatabaseService', () => {
    let db: DatabaseService;

    beforeEach(() => {
        const ctx = createDbContext();  // In-memory
        db = createDatabase(ctx);
    });

    it('creates a record', async () => {
        // Create a test model first
        await db.createOne('models', { model_name: 'test' });
        await db.createOne('fields', {
            model_name: 'test',
            field_name: 'name',
            type: 'text',
            required: true,
        });

        // Now create a record in the test model
        const record = await db.createOne('test', { name: 'Alice' });

        expect(record.id).toBeDefined();
        expect(record.name).toBe('Alice');
        expect(record.created_at).toBeDefined();
    });

    it('updates a record', async () => {
        await db.createOne('models', { model_name: 'test' });
        const created = await db.createOne('test', { name: 'Alice' });

        const updated = await db.updateOne('test', created.id, { name: 'Bob' });

        expect(updated.name).toBe('Bob');
        expect(updated.updated_at).not.toBe(created.updated_at);
    });

    it('soft deletes a record', async () => {
        await db.createOne('models', { model_name: 'test' });
        const created = await db.createOne('test', { name: 'Alice' });

        await db.deleteOne('test', created.id);

        // Should not appear in normal queries
        const found = db.selectById('test', created.id);
        expect(found).toBeNull();
    });

    it('rejects missing required fields', async () => {
        await db.createOne('models', { model_name: 'test' });
        await db.createOne('fields', {
            model_name: 'test',
            field_name: 'email',
            type: 'text',
            required: true,
        });

        await expect(db.createOne('test', {})).rejects.toThrow(/required/i);
    });
});
```

## Acceptance Criteria

- [x] Model class wraps metadata with field accessors
- [x] ModelRecord tracks changes between original and new values
- [x] ModelCache caches loaded models (async, HAL-based)
- [x] DatabaseService.selectMany/One/ById work
- [x] DatabaseService.createOne runs through observer pipeline
- [x] DatabaseService.updateOne loads existing, applies changes
- [x] DatabaseService.deleteOne performs soft delete
- [x] Timestamps (created_at, updated_at) auto-populated
- [x] IDs auto-generated if not provided
- [x] System entity tables (file, folder, device, proc, link) in schema.sql

## Implementation Notes

**Files Created:**
- `src/model/model.ts` - Model class with lazy field categorization
- `src/model/model-record.ts` - Change tracking with diff generation
- `src/model/model-cache.ts` - Async cache with request deduplication
- `src/model/database.ts` - DatabaseService with observer pipeline integration
- `spec/model/database.test.ts` - 48 tests for Phase 3 classes

**Files Modified:**
- `src/model/schema.sql` - Added 5 system entity tables with indexes
- `src/model/index.ts` - Exports for new classes
- `spec/model/schema.test.ts` - Tests for entity tables

**Key Design Decisions:**
1. All database access through HAL channels (DatabaseConnection)
2. ModelCache is async with pending request deduplication (RC-1)
3. System entity tables have static DDL (solves bootstrap problem)
4. Direct SQL in DatabaseService as fallback until Ring 5 observers (Phase 4)

**Note:** DatabaseService API needs revision in Phase 3.5 to better align with VFS patterns.

## Next Phase

Once database layer is complete, proceed to [Phase 4: Core Observers](./04-observers.md) to implement behavioral enforcement.
