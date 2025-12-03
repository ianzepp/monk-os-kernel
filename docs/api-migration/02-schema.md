# Phase 2: Schema - Models and Fields Tables

## Overview

The schema defines how model and field metadata is stored. This is the foundation for the data-driven system - everything else interprets these tables.

## Source Reference

**Source:** `monk-api/src/lib/sql/tenant.sqlite.sql`

## Schema Definition

Create `src/db/schema.sql`:

```sql
-- =============================================================================
-- MONK OS DATABASE SCHEMA
-- =============================================================================
-- Core tables for data-driven model/field system
-- SQLite with WAL mode for concurrent access

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- =============================================================================
-- SYSTEM FIELDS
-- =============================================================================
-- All tables include these columns automatically:
--   id            UUID primary key
--   created_at    Creation timestamp
--   updated_at    Last modification timestamp
--   trashed_at    Soft delete timestamp (null = active)
--   expired_at    Hard delete timestamp (null = not purged)

-- =============================================================================
-- MODELS TABLE
-- =============================================================================
-- Defines entity types (tables) in the system

CREATE TABLE IF NOT EXISTS models (
    -- System fields
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Model identity
    model_name  TEXT NOT NULL UNIQUE,
    status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'system')),
    description TEXT,

    -- Behavioral flags
    sudo        INTEGER DEFAULT 0,  -- Requires elevated access to modify records
    frozen      INTEGER DEFAULT 0,  -- All data changes prevented
    immutable   INTEGER DEFAULT 0,  -- Records are write-once (no updates)
    external    INTEGER DEFAULT 0,  -- Managed externally (reject local changes)
    passthrough INTEGER DEFAULT 0   -- Skip observer pipeline
);

CREATE INDEX IF NOT EXISTS idx_models_status ON models(status) WHERE trashed_at IS NULL;

-- =============================================================================
-- FIELDS TABLE
-- =============================================================================
-- Defines columns for each model

CREATE TABLE IF NOT EXISTS fields (
    -- System fields
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Field identity
    model_name  TEXT NOT NULL REFERENCES models(model_name) ON DELETE CASCADE,
    field_name  TEXT NOT NULL,

    -- Type information
    type        TEXT NOT NULL DEFAULT 'text',
    is_array    INTEGER DEFAULT 0,

    -- Constraints
    required        INTEGER DEFAULT 0,
    default_value   TEXT,
    minimum         REAL,
    maximum         REAL,
    pattern         TEXT,           -- Regex pattern
    enum_values     TEXT,           -- JSON array of allowed values

    -- Relationships
    relationship_type   TEXT CHECK (relationship_type IN ('owned', 'referenced')),
    related_model       TEXT,
    related_field       TEXT,
    relationship_name   TEXT,
    cascade_delete      INTEGER DEFAULT 0,
    required_relationship INTEGER DEFAULT 0,

    -- Behavioral flags
    immutable   INTEGER DEFAULT 0,  -- Cannot change after creation
    sudo        INTEGER DEFAULT 0,  -- Requires elevated access
    unique_     INTEGER DEFAULT 0,  -- Unique constraint
    index_      INTEGER DEFAULT 0,  -- Create index
    tracked     INTEGER DEFAULT 0,  -- Track changes
    searchable  INTEGER DEFAULT 0,  -- Full-text search
    transform   TEXT,               -- Auto-transform (lowercase, trim, etc.)

    -- Documentation
    description TEXT,

    -- Ensure unique field names per model
    UNIQUE(model_name, field_name)
);

CREATE INDEX IF NOT EXISTS idx_fields_model ON fields(model_name) WHERE trashed_at IS NULL;

-- =============================================================================
-- TRACKED TABLE
-- =============================================================================
-- Change history for fields with tracked=1

CREATE TABLE IF NOT EXISTS tracked (
    -- System fields
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Change identity
    change_id   INTEGER,  -- Auto-increment per model/record
    model_name  TEXT NOT NULL,
    record_id   TEXT NOT NULL,

    -- Change details
    operation   TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    changes     TEXT NOT NULL,  -- JSON: { field: { old, new } }
    created_by  TEXT,           -- User/process that made change
    request_id  TEXT,           -- Correlation ID
    metadata    TEXT            -- Additional context (JSON)
);

CREATE INDEX IF NOT EXISTS idx_tracked_record
    ON tracked(model_name, record_id, change_id DESC);

-- =============================================================================
-- SEED DATA: SYSTEM MODELS
-- =============================================================================

INSERT OR IGNORE INTO models (model_name, status, sudo, description) VALUES
    ('models', 'system', 1, 'Model definitions'),
    ('fields', 'system', 1, 'Field definitions'),
    ('tracked', 'system', 1, 'Change tracking history');

-- =============================================================================
-- SEED DATA: MODELS FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('models', 'model_name', 'text', 1, 'Unique name for the model'),
    ('models', 'status', 'text', 0, 'Model status (active, disabled, system)'),
    ('models', 'description', 'text', 0, 'Human-readable description'),
    ('models', 'sudo', 'boolean', 0, 'Requires sudo for record modifications'),
    ('models', 'frozen', 'boolean', 0, 'All data changes prevented'),
    ('models', 'immutable', 'boolean', 0, 'Records are write-once'),
    ('models', 'external', 'boolean', 0, 'Managed externally'),
    ('models', 'passthrough', 'boolean', 0, 'Skip observer pipeline');

-- =============================================================================
-- SEED DATA: FIELDS FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('fields', 'model_name', 'text', 1, 'Parent model name'),
    ('fields', 'field_name', 'text', 1, 'Field name'),
    ('fields', 'type', 'text', 1, 'Data type'),
    ('fields', 'is_array', 'boolean', 0, 'Whether field holds array'),
    ('fields', 'required', 'boolean', 0, 'Field is required'),
    ('fields', 'default_value', 'text', 0, 'Default value'),
    ('fields', 'minimum', 'numeric', 0, 'Minimum value'),
    ('fields', 'maximum', 'numeric', 0, 'Maximum value'),
    ('fields', 'pattern', 'text', 0, 'Regex pattern'),
    ('fields', 'enum_values', 'text', 0, 'Allowed values (JSON array)'),
    ('fields', 'relationship_type', 'text', 0, 'Relationship type'),
    ('fields', 'related_model', 'text', 0, 'Related model name'),
    ('fields', 'related_field', 'text', 0, 'Related field name'),
    ('fields', 'relationship_name', 'text', 0, 'Relationship name'),
    ('fields', 'cascade_delete', 'boolean', 0, 'Cascade delete'),
    ('fields', 'required_relationship', 'boolean', 0, 'Relationship required'),
    ('fields', 'immutable', 'boolean', 0, 'Cannot change after creation'),
    ('fields', 'sudo', 'boolean', 0, 'Requires sudo to modify'),
    ('fields', 'unique_', 'boolean', 0, 'Unique constraint'),
    ('fields', 'index_', 'boolean', 0, 'Create index'),
    ('fields', 'tracked', 'boolean', 0, 'Track changes'),
    ('fields', 'searchable', 'boolean', 0, 'Full-text search'),
    ('fields', 'transform', 'text', 0, 'Auto-transform'),
    ('fields', 'description', 'text', 0, 'Field description');

-- =============================================================================
-- SEED DATA: TRACKED FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('tracked', 'change_id', 'integer', 1, 'Change sequence number'),
    ('tracked', 'model_name', 'text', 1, 'Model where change occurred'),
    ('tracked', 'record_id', 'text', 1, 'Record that changed'),
    ('tracked', 'operation', 'text', 1, 'Operation type'),
    ('tracked', 'changes', 'text', 1, 'Field changes (JSON)'),
    ('tracked', 'created_by', 'text', 0, 'User/process'),
    ('tracked', 'request_id', 'text', 0, 'Correlation ID'),
    ('tracked', 'metadata', 'text', 0, 'Additional context');
```

## Field Types

Supported types and their SQLite mappings:

| User Type | SQLite Type | Notes |
|-----------|-------------|-------|
| `text` | TEXT | Default type |
| `integer` | INTEGER | Whole numbers |
| `numeric` | REAL | Decimals |
| `boolean` | INTEGER | 0/1 |
| `uuid` | TEXT | Stored as string |
| `timestamp` | TEXT | ISO 8601 format |
| `date` | TEXT | YYYY-MM-DD |
| `jsonb` | TEXT | JSON string |
| `binary` | BLOB | Raw bytes |
| `text[]` | TEXT | JSON array |
| `integer[]` | TEXT | JSON array |
| `uuid[]` | TEXT | JSON array |

## Field Behavioral Properties

| Property | Type | Purpose |
|----------|------|---------|
| `required` | boolean | Field must have non-null value |
| `default_value` | string | Default if not provided |
| `minimum` | number | Min value for numerics |
| `maximum` | number | Max value for numerics |
| `pattern` | string | Regex for text validation |
| `enum_values` | JSON array | Allowed values |
| `immutable` | boolean | Cannot change after creation |
| `sudo` | boolean | Requires elevated access |
| `unique_` | boolean | Unique constraint |
| `index_` | boolean | Create database index |
| `tracked` | boolean | Record change history |
| `searchable` | boolean | Enable full-text search |
| `transform` | string | Auto-transform (lowercase, trim, etc.) |

## Model Behavioral Flags

| Flag | Purpose |
|------|---------|
| `sudo` | All record operations require elevated access |
| `frozen` | No data changes allowed (read-only) |
| `immutable` | Records cannot be updated, only created/deleted |
| `external` | Model is managed externally, reject local changes |
| `passthrough` | Skip observer pipeline (dangerous) |

## Integration with StorageEngine

### Option A: Separate Database

Create a dedicated SQLite database for the model system:

```typescript
// src/db/connection.ts
import { Database } from 'bun:sqlite';
import schema from './schema.sql';

export function createDatabase(path: string = ':memory:'): Database {
    const db = new Database(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(schema);
    return db;
}
```

### Option B: Enhance StorageEngine

Add relational methods to existing StorageEngine:

```typescript
// Extend StorageEngine interface
interface StorageEngine {
    // Existing KV methods...
    get(key: string): Promise<Uint8Array | null>;
    put(key: string, value: Uint8Array): Promise<void>;

    // New relational methods
    query<T>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): Promise<void>;
}
```

**Recommendation:** Option A - separate database is cleaner and allows independent evolution.

## Schema Evolution

When fields are added/removed/modified, DDL observers (Phase 4) will:

1. **Field Create:** `ALTER TABLE {model} ADD COLUMN {field} {type}`
2. **Field Delete:** `ALTER TABLE {model} DROP COLUMN {field}` (SQLite limitation: requires table rebuild)
3. **Field Update:** May require table rebuild for type changes

## Directory Structure

```
src/db/
├── schema.sql        # Full schema definition
├── connection.ts     # Database connection management
├── migrations/       # Future: schema migrations
│   └── 001-initial.sql
```

## Testing Strategy

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { createDatabase } from './connection';

describe('Schema', () => {
    let db: Database;

    beforeEach(() => {
        db = createDatabase(':memory:');
    });

    it('creates models table', () => {
        const result = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='models'").all();
        expect(result.length).toBe(1);
    });

    it('seeds system models', () => {
        const models = db.query("SELECT model_name FROM models WHERE status = 'system'").all();
        expect(models.map(m => m.model_name)).toContain('models');
        expect(models.map(m => m.model_name)).toContain('fields');
    });

    it('seeds fields for models table', () => {
        const fields = db.query("SELECT field_name FROM fields WHERE model_name = 'models'").all();
        expect(fields.length).toBeGreaterThan(0);
    });

    it('enforces model_name uniqueness', () => {
        expect(() => {
            db.exec("INSERT INTO models (model_name) VALUES ('test')");
            db.exec("INSERT INTO models (model_name) VALUES ('test')");
        }).toThrow();
    });

    it('enforces field uniqueness per model', () => {
        db.exec("INSERT INTO models (model_name) VALUES ('test')");
        expect(() => {
            db.exec("INSERT INTO fields (model_name, field_name, type) VALUES ('test', 'foo', 'text')");
            db.exec("INSERT INTO fields (model_name, field_name, type) VALUES ('test', 'foo', 'text')");
        }).toThrow();
    });
});
```

## Acceptance Criteria

- [ ] `models` table created with all columns
- [ ] `fields` table created with all columns
- [ ] `tracked` table created for change history
- [ ] System models seeded (models, fields, tracked)
- [ ] Fields for system models seeded
- [ ] Foreign key constraint works (fields.model_name → models.model_name)
- [ ] Unique constraints enforced
- [ ] Can insert user-defined model
- [ ] Can insert fields for user-defined model

## Next Phase

Once schema is complete, proceed to [Phase 3: Database Layer](./03-database-layer.md) to build the CRUD service.
