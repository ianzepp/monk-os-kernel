# Phase 2: Schema - Models and Fields Tables

## Overview

The schema defines how model and field metadata is stored. This is the foundation for the entity+data architecture - every VFS entry has an entity stored in these tables.

**Key Point:** Both system models (file, folder, device, proc, link) and user models (invoice, customer) are defined here. There is no distinction in how they're handled - all entity mutations flow through the observer pipeline.

See [README.md](./README.md) for the complete entity+data architecture.

## Source Reference

**Source:** `monk-api/src/lib/sql/tenant.sqlite.sql`

## Schema Definition

Create `src/model/schema.sql`:

```sql
-- =============================================================================
-- MONK OS MODEL SCHEMA
-- =============================================================================
-- Core tables for the entity+data architecture.
-- All VFS entries have their entity metadata stored here.
-- Blob data is stored separately in HAL block storage.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- =============================================================================
-- SYSTEM FIELDS
-- =============================================================================
-- All entity tables include these columns automatically:
--   id            UUID primary key
--   created_at    Creation timestamp
--   updated_at    Last modification timestamp
--   trashed_at    Soft delete timestamp (null = active)
--   expired_at    Hard delete timestamp (null = not purged)

-- =============================================================================
-- MODELS TABLE
-- =============================================================================
-- Defines entity types in the system (both system and user models)

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
    sudo        INTEGER DEFAULT 0,  -- Requires elevated access to modify entities
    frozen      INTEGER DEFAULT 0,  -- All entity changes prevented
    immutable   INTEGER DEFAULT 0,  -- Entities are write-once (no updates)
    external    INTEGER DEFAULT 0,  -- Managed externally (reject local changes)
    passthrough INTEGER DEFAULT 0   -- Skip observer pipeline (dangerous)
);

CREATE INDEX IF NOT EXISTS idx_models_status ON models(status) WHERE trashed_at IS NULL;

-- =============================================================================
-- FIELDS TABLE
-- =============================================================================
-- Defines entity fields for each model

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
-- SEED DATA: SYSTEM MODELS (Meta)
-- =============================================================================

INSERT OR IGNORE INTO models (model_name, status, sudo, description) VALUES
    ('models', 'system', 1, 'Model definitions'),
    ('fields', 'system', 1, 'Field definitions'),
    ('tracked', 'system', 1, 'Change tracking history');

-- =============================================================================
-- SEED DATA: SYSTEM MODELS (VFS)
-- =============================================================================
-- These are the core VFS entity types. Their blob data (if any) is stored
-- separately in HAL block storage.

INSERT OR IGNORE INTO models (model_name, status, description) VALUES
    ('file', 'system', 'Regular file entity'),
    ('folder', 'system', 'Directory entity'),
    ('device', 'system', 'Device node entity'),
    ('proc', 'system', 'Process/virtual file entity'),
    ('link', 'system', 'Symbolic link entity');

-- =============================================================================
-- SEED DATA: FILE FIELDS
-- =============================================================================
-- Fields for the file entity type

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('file', 'name', 'text', 1, 'File name'),
    ('file', 'parent', 'uuid', 0, 'Parent folder ID'),
    ('file', 'owner', 'uuid', 1, 'Owner user/process ID'),
    ('file', 'size', 'integer', 0, 'Blob size in bytes'),
    ('file', 'mimetype', 'text', 0, 'MIME type'),
    ('file', 'checksum', 'text', 0, 'Content hash');

-- =============================================================================
-- SEED DATA: FOLDER FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('folder', 'name', 'text', 1, 'Folder name'),
    ('folder', 'parent', 'uuid', 0, 'Parent folder ID'),
    ('folder', 'owner', 'uuid', 1, 'Owner user/process ID');

-- =============================================================================
-- SEED DATA: DEVICE FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('device', 'name', 'text', 1, 'Device name'),
    ('device', 'parent', 'uuid', 0, 'Parent folder ID'),
    ('device', 'owner', 'uuid', 1, 'Owner user/process ID'),
    ('device', 'driver', 'text', 1, 'Device driver identifier');

-- =============================================================================
-- SEED DATA: PROC FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('proc', 'name', 'text', 1, 'Proc name'),
    ('proc', 'parent', 'uuid', 0, 'Parent folder ID'),
    ('proc', 'owner', 'uuid', 1, 'Owner user/process ID'),
    ('proc', 'handler', 'text', 1, 'Handler function identifier');

-- =============================================================================
-- SEED DATA: LINK FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('link', 'name', 'text', 1, 'Link name'),
    ('link', 'parent', 'uuid', 0, 'Parent folder ID'),
    ('link', 'owner', 'uuid', 1, 'Owner user/process ID'),
    ('link', 'target', 'text', 1, 'Link target path');

-- =============================================================================
-- SEED DATA: MODELS FIELDS (Meta)
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('models', 'model_name', 'text', 1, 'Unique name for the model'),
    ('models', 'status', 'text', 0, 'Model status (active, disabled, system)'),
    ('models', 'description', 'text', 0, 'Human-readable description'),
    ('models', 'sudo', 'boolean', 0, 'Requires sudo for entity modifications'),
    ('models', 'frozen', 'boolean', 0, 'All entity changes prevented'),
    ('models', 'immutable', 'boolean', 0, 'Entities are write-once'),
    ('models', 'external', 'boolean', 0, 'Managed externally'),
    ('models', 'passthrough', 'boolean', 0, 'Skip observer pipeline');

-- =============================================================================
-- SEED DATA: FIELDS FIELDS (Meta)
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
-- SEED DATA: TRACKED FIELDS (Meta)
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('tracked', 'change_id', 'integer', 1, 'Change sequence number'),
    ('tracked', 'model_name', 'text', 1, 'Model where change occurred'),
    ('tracked', 'record_id', 'text', 1, 'Entity that changed'),
    ('tracked', 'operation', 'text', 1, 'Operation type'),
    ('tracked', 'changes', 'text', 1, 'Field changes (JSON)'),
    ('tracked', 'created_by', 'text', 0, 'User/process'),
    ('tracked', 'request_id', 'text', 0, 'Correlation ID'),
    ('tracked', 'metadata', 'text', 0, 'Additional context');
```

## Entity vs Blob

The schema only stores **entity metadata**. Blob data is stored separately:

| What | Where | Example |
|------|-------|---------|
| Entity (metadata) | SQLite table for model | `SELECT * FROM file WHERE id = 'abc'` |
| Blob (raw bytes) | HAL block storage | `hal.block.read('abc')` |

A file entity has fields like `name`, `size`, `mimetype`. The actual file contents are in blob storage, keyed by entity ID.

## Field Types

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
| `binary` | BLOB | Raw bytes (rarely used - prefer blob storage) |
| `text[]` | TEXT | JSON array |
| `integer[]` | TEXT | JSON array |
| `uuid[]` | TEXT | JSON array |

## Model Behavioral Flags

| Flag | Purpose |
|------|---------|
| `sudo` | All entity operations require elevated access |
| `frozen` | No entity changes allowed (read-only) |
| `immutable` | Entities cannot be updated, only created/deleted |
| `external` | Model is managed externally, reject local changes |
| `passthrough` | Skip observer pipeline (dangerous) |

## Directory Structure

```
src/model/
├── schema.sql        # Full schema definition
├── connection.ts     # Database connection management
└── migrations/       # Future: schema migrations
```

## Database Connection

```typescript
// src/model/connection.ts
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
        const names = models.map(m => m.model_name);
        expect(names).toContain('models');
        expect(names).toContain('fields');
        expect(names).toContain('file');
        expect(names).toContain('folder');
    });

    it('seeds fields for file entity', () => {
        const fields = db.query("SELECT field_name FROM fields WHERE model_name = 'file'").all();
        const names = fields.map(f => f.field_name);
        expect(names).toContain('name');
        expect(names).toContain('parent');
        expect(names).toContain('size');
        expect(names).toContain('mimetype');
    });
});
```

## Acceptance Criteria

- [ ] `models` table created with all columns
- [ ] `fields` table created with all columns
- [ ] `tracked` table created for change history
- [ ] System meta-models seeded (models, fields, tracked)
- [ ] System VFS models seeded (file, folder, device, proc, link)
- [ ] Fields for all system models seeded
- [ ] Foreign key constraint works (fields.model_name → models.model_name)
- [ ] Unique constraints enforced

## Next Phase

Once schema is complete, proceed to [Phase 3: Database Layer](./03-database-layer.md) to build the CRUD service.
