-- =============================================================================
-- MONK OS MODEL SCHEMA
-- =============================================================================
--
-- ARCHITECTURE OVERVIEW
-- =====================
-- This schema defines how model and field metadata is stored in Monk OS.
-- It is the foundation for the entity+data architecture where:
--
-- - Entity metadata (structured) is stored in SQLite tables defined here
-- - Blob data (raw bytes) is stored separately in HAL block storage
--
-- All VFS entries have their entity metadata stored in these tables. System
-- models (file, folder, device, proc, link) and user-defined models (invoice,
-- customer) are treated identically - all entity mutations flow through the
-- observer pipeline.
--
-- TABLE HIERARCHY
-- ===============
-- ```
--   models          Field definitions for each model
--      |
--      +-- fields   One row per field per model
--      |
--      +-- tracked  Change history for audited fields
-- ```
--
-- SYSTEM FIELDS
-- =============
-- All entity tables include these columns automatically:
--   id            UUID primary key (32 hex chars, lowercase)
--   created_at    Creation timestamp (ISO 8601)
--   updated_at    Last modification timestamp (ISO 8601)
--   trashed_at    Soft delete timestamp (null = active)
--   expired_at    Hard delete timestamp (null = not purged)
--
-- INVARIANTS
-- ==========
-- INV-1: All tables have the 5 system fields above
-- INV-2: model_name is unique and serves as natural key for models
-- INV-3: (model_name, field_name) is unique in fields table
-- INV-4: Foreign keys enforce referential integrity
-- INV-5: Soft delete (trashed_at) hides records from normal queries
--
-- BUN TOUCHPOINTS
-- ===============
-- - bun:sqlite Database class
-- - WAL mode for concurrent reads
-- - randomblob() for UUID generation
-- - datetime() for timestamps

-- =============================================================================
-- PRAGMAS
-- =============================================================================
-- WAL mode enables concurrent reads while writing.
-- Foreign keys ensure referential integrity.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- =============================================================================
-- MODELS TABLE
-- =============================================================================
-- Defines entity types in the system (both system and user models).
--
-- WHY model_name as natural key: Enables human-readable references in fields
-- table and queries. The UUID id is for system consistency.
--
-- WHY behavioral flags: Allow per-model customization of mutation behavior
-- without code changes. Observers check these flags at runtime.

CREATE TABLE IF NOT EXISTS models (
    -- -------------------------------------------------------------------------
    -- System Fields
    -- -------------------------------------------------------------------------
    -- WHY lowercase hex: Consistent with UUID formatting elsewhere in codebase.
    -- WHY 16 bytes: 128-bit UUID provides sufficient uniqueness.
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- -------------------------------------------------------------------------
    -- Model Identity
    -- -------------------------------------------------------------------------
    -- WHY UNIQUE on model_name: Natural key for human-readable references.
    -- WHY NOT NULL: Every model must have a name.
    model_name  TEXT NOT NULL UNIQUE,

    -- WHY status enum: Controls model visibility and protection level.
    -- 'active' = normal user model, 'disabled' = hidden, 'system' = protected
    status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'system')),

    -- Human-readable description for documentation/UI
    description TEXT,

    -- -------------------------------------------------------------------------
    -- Behavioral Flags
    -- -------------------------------------------------------------------------
    -- WHY boolean as INTEGER: SQLite has no native boolean type.
    -- WHY default 0: Opt-in to restrictive behaviors.

    -- sudo: Requires elevated access (kernel/root) to modify entities
    sudo        INTEGER DEFAULT 0,

    -- frozen: No entity changes allowed at all (read-only model)
    frozen      INTEGER DEFAULT 0,

    -- immutable: Entities can be created/deleted but not updated
    immutable   INTEGER DEFAULT 0,

    -- external: Model is managed by external system, reject local changes
    external    INTEGER DEFAULT 0,

    -- passthrough: Skip observer pipeline entirely (DANGEROUS - use sparingly)
    passthrough INTEGER DEFAULT 0
);

-- Index active models by status for listing queries
-- WHY partial index: Only index non-trashed rows
CREATE INDEX IF NOT EXISTS idx_models_status
    ON models(status)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- FIELDS TABLE
-- =============================================================================
-- Defines entity fields for each model.
--
-- WHY FK to model_name: Enables readable YAML definitions without ID lookups.
-- WHY ON DELETE CASCADE: Deleting a model removes its field definitions.

CREATE TABLE IF NOT EXISTS fields (
    -- -------------------------------------------------------------------------
    -- System Fields
    -- -------------------------------------------------------------------------
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- -------------------------------------------------------------------------
    -- Field Identity
    -- -------------------------------------------------------------------------
    -- WHY REFERENCES model_name: Foreign key to models table natural key.
    -- WHY CASCADE: If model is deleted, its fields are deleted too.
    model_name  TEXT NOT NULL REFERENCES models(model_name) ON DELETE CASCADE,
    field_name  TEXT NOT NULL,

    -- -------------------------------------------------------------------------
    -- Type Information
    -- -------------------------------------------------------------------------
    -- WHY default 'text': Text is the safest default type.
    -- Supported types: text, integer, numeric, boolean, uuid, timestamp, date, jsonb, binary
    type        TEXT NOT NULL DEFAULT 'text',

    -- WHY is_array flag: Simpler than parsing type[] syntax.
    -- Arrays are stored as JSON in TEXT column.
    is_array    INTEGER DEFAULT 0,

    -- -------------------------------------------------------------------------
    -- Constraints
    -- -------------------------------------------------------------------------
    -- WHY separate columns vs JSON: Enables SQL-level validation and indexing.

    -- required: Field must have a value on create
    required        INTEGER DEFAULT 0,

    -- default_value: Auto-populated if not provided (stored as TEXT, parsed by type)
    default_value   TEXT,

    -- minimum/maximum: Numeric range validation
    minimum         REAL,
    maximum         REAL,

    -- pattern: Regex validation for text fields
    pattern         TEXT,

    -- enum_values: JSON array of allowed values, e.g., '["draft","sent","paid"]'
    enum_values     TEXT,

    -- -------------------------------------------------------------------------
    -- Relationships
    -- -------------------------------------------------------------------------
    -- WHY relationship_type: Distinguishes owned (child lifecycle tied to parent)
    -- from referenced (independent entities).

    -- 'owned': Parent deletion cascades to children
    -- 'referenced': Parent deletion blocked if references exist (or nullified)
    relationship_type   TEXT CHECK (relationship_type IN ('owned', 'referenced')),

    -- Target model for the relationship
    related_model       TEXT,

    -- Target field (default: 'id')
    related_field       TEXT,

    -- Human-readable name for the relationship
    relationship_name   TEXT,

    -- cascade_delete: Delete children when parent deleted (for 'owned')
    cascade_delete      INTEGER DEFAULT 0,

    -- required_relationship: Related entity must exist
    required_relationship INTEGER DEFAULT 0,

    -- -------------------------------------------------------------------------
    -- Behavioral Flags
    -- -------------------------------------------------------------------------

    -- immutable: Cannot change after entity creation
    immutable   INTEGER DEFAULT 0,

    -- sudo: Requires elevated access to modify this specific field
    sudo        INTEGER DEFAULT 0,

    -- unique_: Unique constraint on field value within model
    -- WHY trailing underscore: 'unique' is a SQL keyword
    unique_     INTEGER DEFAULT 0,

    -- index_: Create database index for faster queries
    index_      INTEGER DEFAULT 0,

    -- tracked: Record changes to this field in tracked table
    tracked     INTEGER DEFAULT 0,

    -- searchable: Include in full-text search
    searchable  INTEGER DEFAULT 0,

    -- transform: Auto-transform value (e.g., 'lowercase', 'trim', 'uppercase')
    transform   TEXT,

    -- -------------------------------------------------------------------------
    -- Documentation
    -- -------------------------------------------------------------------------
    description TEXT,

    -- -------------------------------------------------------------------------
    -- Constraints
    -- -------------------------------------------------------------------------
    -- Ensure unique field names per model
    UNIQUE(model_name, field_name)
);

-- Index fields by model for listing queries
CREATE INDEX IF NOT EXISTS idx_fields_model
    ON fields(model_name)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- TRACKED TABLE
-- =============================================================================
-- Change history for fields with tracked=1.
--
-- WHY separate table: Keeps entity tables clean while providing full audit.
-- WHY JSON changes: Flexible schema for any field changes.

CREATE TABLE IF NOT EXISTS tracked (
    -- -------------------------------------------------------------------------
    -- System Fields
    -- -------------------------------------------------------------------------
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- -------------------------------------------------------------------------
    -- Change Identity
    -- -------------------------------------------------------------------------
    -- WHY change_id: Sequence number for ordering changes within a record.
    -- Computed by observer at insert time (MAX(change_id) + 1 for record).
    change_id   INTEGER,

    -- Model and record that changed
    model_name  TEXT NOT NULL,
    record_id   TEXT NOT NULL,

    -- -------------------------------------------------------------------------
    -- Change Details
    -- -------------------------------------------------------------------------
    -- operation: What happened to the entity
    operation   TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),

    -- changes: JSON object with changed fields, e.g.:
    -- { "status": { "old": "draft", "new": "sent" } }
    changes     TEXT NOT NULL,

    -- Who made the change (user ID, process ID, or system)
    created_by  TEXT,

    -- Correlation ID for request tracing
    request_id  TEXT,

    -- Additional context (JSON)
    metadata    TEXT
);

-- Index for retrieving change history for a specific record
-- WHY DESC on change_id: Most recent changes first
CREATE INDEX IF NOT EXISTS idx_tracked_record
    ON tracked(model_name, record_id, change_id DESC);

-- =============================================================================
-- SYSTEM ENTITY TABLES
-- =============================================================================
-- These are the actual storage tables for VFS entity metadata.
--
-- WHY static DDL for system models: Bootstrap problem - observers need the
-- models/fields tables to exist, but DDL observers would create entity tables.
-- System models (file, folder, device, proc, link) are part of the OS firmware,
-- so they get static DDL here. User-defined models use dynamic DDL via observers.
--
-- WHY separate tables per model: Enables SQL-level constraints, indexes, and
-- efficient queries. Alternative (single entities table with JSON) would lose
-- queryability - violating the "files are queryable" principle from AGENTS.md.
--
-- BLOB DATA: Not stored here. Entity tables hold metadata only.
-- Blob content is in HAL block storage, keyed by entity ID.

-- =============================================================================
-- FILE TABLE
-- =============================================================================
-- Regular file entities. Metadata here, blob content in HAL block storage.
--
-- WHY no FK on parent: Parent could be folder or null (root-level).
-- Referential integrity enforced by application layer (observers).

CREATE TABLE IF NOT EXISTS file (
    -- -------------------------------------------------------------------------
    -- System Fields (all entities have these - see INV-1)
    -- -------------------------------------------------------------------------
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- -------------------------------------------------------------------------
    -- File-Specific Fields
    -- -------------------------------------------------------------------------
    -- WHY name NOT NULL: Every file must have a name.
    name        TEXT NOT NULL,

    -- WHY parent nullable: Root-level files have no parent.
    -- References folder.id but no FK constraint (cross-table complexity).
    parent      TEXT,

    -- WHY owner NOT NULL: Every file must have an owner for permissions.
    owner       TEXT NOT NULL,

    -- WHY size default 0: New files start empty.
    size        INTEGER DEFAULT 0,

    -- WHY mimetype nullable: Can be auto-detected or unset.
    mimetype    TEXT,

    -- WHY checksum nullable: Computed lazily on first read or explicitly.
    checksum    TEXT
);

-- Index for listing files in a folder (readdir)
CREATE INDEX IF NOT EXISTS idx_file_parent
    ON file(parent)
    WHERE trashed_at IS NULL;

-- Index for finding files by name within a folder (path resolution)
CREATE INDEX IF NOT EXISTS idx_file_parent_name
    ON file(parent, name)
    WHERE trashed_at IS NULL;

-- Index for listing files by owner
CREATE INDEX IF NOT EXISTS idx_file_owner
    ON file(owner)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- FOLDER TABLE
-- =============================================================================
-- Directory entities. No blob data - children computed via parent field query.

CREATE TABLE IF NOT EXISTS folder (
    -- -------------------------------------------------------------------------
    -- System Fields
    -- -------------------------------------------------------------------------
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- -------------------------------------------------------------------------
    -- Folder-Specific Fields
    -- -------------------------------------------------------------------------
    name        TEXT NOT NULL,
    parent      TEXT,  -- null for root folders
    owner       TEXT NOT NULL
);

-- Index for listing folders in a folder (readdir)
CREATE INDEX IF NOT EXISTS idx_folder_parent
    ON folder(parent)
    WHERE trashed_at IS NULL;

-- Index for finding folders by name within a folder (path resolution)
CREATE INDEX IF NOT EXISTS idx_folder_parent_name
    ON folder(parent, name)
    WHERE trashed_at IS NULL;

-- Index for listing folders by owner
CREATE INDEX IF NOT EXISTS idx_folder_owner
    ON folder(owner)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- DEVICE TABLE
-- =============================================================================
-- Device node entities. Kernel-provided virtual files (/dev/console, etc.).
--
-- WHY driver field: Maps to HAL device implementation.
-- Format: "hal:{device}" (e.g., "hal:console", "hal:random", "hal:entropy")

CREATE TABLE IF NOT EXISTS device (
    -- -------------------------------------------------------------------------
    -- System Fields
    -- -------------------------------------------------------------------------
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- -------------------------------------------------------------------------
    -- Device-Specific Fields
    -- -------------------------------------------------------------------------
    name        TEXT NOT NULL,
    parent      TEXT,  -- typically /dev folder
    owner       TEXT NOT NULL,

    -- WHY driver NOT NULL: Every device must map to a HAL implementation.
    driver      TEXT NOT NULL
);

-- Index for listing devices in a folder
CREATE INDEX IF NOT EXISTS idx_device_parent
    ON device(parent)
    WHERE trashed_at IS NULL;

-- Index for finding devices by name within a folder
CREATE INDEX IF NOT EXISTS idx_device_parent_name
    ON device(parent, name)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- PROC TABLE
-- =============================================================================
-- Process/virtual file entities. Dynamic content generated by handler.
--
-- WHY handler field: Function identifier for content generation.
-- Format: "kernel:{handler}" (e.g., "kernel:proc_stat", "kernel:proc_env")

CREATE TABLE IF NOT EXISTS proc (
    -- -------------------------------------------------------------------------
    -- System Fields
    -- -------------------------------------------------------------------------
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- -------------------------------------------------------------------------
    -- Proc-Specific Fields
    -- -------------------------------------------------------------------------
    name        TEXT NOT NULL,
    parent      TEXT,  -- typically /proc/{pid} folder
    owner       TEXT NOT NULL,

    -- WHY handler NOT NULL: Every proc entry must have content generator.
    handler     TEXT NOT NULL
);

-- Index for listing proc entries in a folder
CREATE INDEX IF NOT EXISTS idx_proc_parent
    ON proc(parent)
    WHERE trashed_at IS NULL;

-- Index for finding proc entries by name within a folder
CREATE INDEX IF NOT EXISTS idx_proc_parent_name
    ON proc(parent, name)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- LINK TABLE
-- =============================================================================
-- Symbolic link entities. Redirect path resolution to another location.
--
-- WHY target as text not UUID: Can point to paths, not just entities.
-- Supports both absolute (/vol/data/file) and relative (../other) targets.

CREATE TABLE IF NOT EXISTS link (
    -- -------------------------------------------------------------------------
    -- System Fields
    -- -------------------------------------------------------------------------
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- -------------------------------------------------------------------------
    -- Link-Specific Fields
    -- -------------------------------------------------------------------------
    name        TEXT NOT NULL,
    parent      TEXT,
    owner       TEXT NOT NULL,

    -- WHY target NOT NULL: A link without a target is meaningless.
    -- WHY TEXT not UUID: Target is a path, not necessarily an entity ID.
    target      TEXT NOT NULL
);

-- Index for listing links in a folder
CREATE INDEX IF NOT EXISTS idx_link_parent
    ON link(parent)
    WHERE trashed_at IS NULL;

-- Index for finding links by name within a folder
CREATE INDEX IF NOT EXISTS idx_link_parent_name
    ON link(parent, name)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- SEED DATA: SYSTEM META-MODELS
-- =============================================================================
-- These models define the schema system itself. They require sudo access
-- because modifying them affects the entire system.
--
-- WHY INSERT OR IGNORE: Idempotent - safe to run multiple times.

INSERT OR IGNORE INTO models (model_name, status, sudo, description) VALUES
    ('models', 'system', 1, 'Model definitions - schema for entity types'),
    ('fields', 'system', 1, 'Field definitions - columns for each model'),
    ('tracked', 'system', 1, 'Change tracking history - audit log');

-- =============================================================================
-- SEED DATA: VFS SYSTEM MODELS
-- =============================================================================
-- Core VFS entity types. Their blob data (if any) is stored separately
-- in HAL block storage, keyed by entity ID.
--
-- WHY status='system': Protected from accidental modification.
-- WHY sudo=0: Normal operations can create/modify files, but model
-- definition changes still require sudo via the models table.

INSERT OR IGNORE INTO models (model_name, status, description) VALUES
    ('file', 'system', 'Regular file entity - has associated blob data'),
    ('folder', 'system', 'Directory entity - contains child entries'),
    ('device', 'system', 'Device node entity - kernel device interface'),
    ('proc', 'system', 'Process/virtual file entity - dynamic content'),
    ('link', 'system', 'Symbolic link entity - path redirection');

-- =============================================================================
-- SEED DATA: MODELS TABLE FIELDS (Meta-model)
-- =============================================================================
-- Fields that describe the models table itself.

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('models', 'model_name', 'text', 1, 'Unique identifier for the model'),
    ('models', 'status', 'text', 0, 'Model status: active, disabled, or system'),
    ('models', 'description', 'text', 0, 'Human-readable description'),
    ('models', 'sudo', 'boolean', 0, 'Requires sudo for entity modifications'),
    ('models', 'frozen', 'boolean', 0, 'All entity changes prevented'),
    ('models', 'immutable', 'boolean', 0, 'Entities are write-once (no updates)'),
    ('models', 'external', 'boolean', 0, 'Managed by external system'),
    ('models', 'passthrough', 'boolean', 0, 'Skip observer pipeline (dangerous)');

-- =============================================================================
-- SEED DATA: FIELDS TABLE FIELDS (Meta-model)
-- =============================================================================
-- Fields that describe the fields table itself.

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('fields', 'model_name', 'text', 1, 'Parent model this field belongs to'),
    ('fields', 'field_name', 'text', 1, 'Name of the field'),
    ('fields', 'type', 'text', 1, 'Data type: text, integer, numeric, boolean, uuid, timestamp, date, jsonb'),
    ('fields', 'is_array', 'boolean', 0, 'Whether field holds an array'),
    ('fields', 'required', 'boolean', 0, 'Field is required on create'),
    ('fields', 'default_value', 'text', 0, 'Default value if not provided'),
    ('fields', 'minimum', 'numeric', 0, 'Minimum value for numeric types'),
    ('fields', 'maximum', 'numeric', 0, 'Maximum value for numeric types'),
    ('fields', 'pattern', 'text', 0, 'Regex pattern for text validation'),
    ('fields', 'enum_values', 'text', 0, 'Allowed values as JSON array'),
    ('fields', 'relationship_type', 'text', 0, 'Relationship type: owned or referenced'),
    ('fields', 'related_model', 'text', 0, 'Target model for relationship'),
    ('fields', 'related_field', 'text', 0, 'Target field for relationship'),
    ('fields', 'relationship_name', 'text', 0, 'Human-readable relationship name'),
    ('fields', 'cascade_delete', 'boolean', 0, 'Cascade delete to related records'),
    ('fields', 'required_relationship', 'boolean', 0, 'Related record must exist'),
    ('fields', 'immutable', 'boolean', 0, 'Cannot change after creation'),
    ('fields', 'sudo', 'boolean', 0, 'Requires sudo to modify'),
    ('fields', 'unique_', 'boolean', 0, 'Unique constraint on values'),
    ('fields', 'index_', 'boolean', 0, 'Create database index'),
    ('fields', 'tracked', 'boolean', 0, 'Track changes in audit log'),
    ('fields', 'searchable', 'boolean', 0, 'Include in full-text search'),
    ('fields', 'transform', 'text', 0, 'Auto-transform: lowercase, trim, uppercase'),
    ('fields', 'description', 'text', 0, 'Field description');

-- =============================================================================
-- SEED DATA: TRACKED TABLE FIELDS (Meta-model)
-- =============================================================================
-- Fields for the change tracking table.

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('tracked', 'change_id', 'integer', 1, 'Sequence number within record'),
    ('tracked', 'model_name', 'text', 1, 'Model where change occurred'),
    ('tracked', 'record_id', 'text', 1, 'Entity that was changed'),
    ('tracked', 'operation', 'text', 1, 'Operation: create, update, or delete'),
    ('tracked', 'changes', 'text', 1, 'Field changes as JSON object'),
    ('tracked', 'created_by', 'text', 0, 'User or process that made change'),
    ('tracked', 'request_id', 'text', 0, 'Request correlation ID'),
    ('tracked', 'metadata', 'text', 0, 'Additional context as JSON');

-- =============================================================================
-- SEED DATA: FILE MODEL FIELDS
-- =============================================================================
-- Fields for the file entity type. These track metadata; blob content
-- is stored separately in HAL block storage.

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('file', 'name', 'text', 1, 'File name (without path)'),
    ('file', 'parent', 'uuid', 0, 'Parent folder ID (null for root-level)'),
    ('file', 'owner', 'uuid', 1, 'Owner user or process ID'),
    ('file', 'size', 'integer', 0, 'Blob size in bytes'),
    ('file', 'mimetype', 'text', 0, 'MIME type (e.g., application/pdf)'),
    ('file', 'checksum', 'text', 0, 'Content hash for integrity verification');

-- =============================================================================
-- SEED DATA: FOLDER MODEL FIELDS
-- =============================================================================
-- Folders have no blob data. Children are computed via parent field query.

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('folder', 'name', 'text', 1, 'Folder name'),
    ('folder', 'parent', 'uuid', 0, 'Parent folder ID (null for root)'),
    ('folder', 'owner', 'uuid', 1, 'Owner user or process ID');

-- =============================================================================
-- SEED DATA: DEVICE MODEL FIELDS
-- =============================================================================
-- Devices are kernel-provided virtual files (e.g., /dev/console, /dev/random).

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('device', 'name', 'text', 1, 'Device name (e.g., console, random)'),
    ('device', 'parent', 'uuid', 0, 'Parent folder ID'),
    ('device', 'owner', 'uuid', 1, 'Owner user or process ID'),
    ('device', 'driver', 'text', 1, 'Device driver identifier (e.g., hal:console)');

-- =============================================================================
-- SEED DATA: PROC MODEL FIELDS
-- =============================================================================
-- Proc entries are dynamic virtual files with computed content.

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('proc', 'name', 'text', 1, 'Proc entry name'),
    ('proc', 'parent', 'uuid', 0, 'Parent folder ID'),
    ('proc', 'owner', 'uuid', 1, 'Owner user or process ID'),
    ('proc', 'handler', 'text', 1, 'Handler function identifier');

-- =============================================================================
-- SEED DATA: LINK MODEL FIELDS
-- =============================================================================
-- Symbolic links redirect path resolution to another location.

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('link', 'name', 'text', 1, 'Link name'),
    ('link', 'parent', 'uuid', 0, 'Parent folder ID'),
    ('link', 'owner', 'uuid', 1, 'Owner user or process ID'),
    ('link', 'target', 'text', 1, 'Target path (absolute or relative)');
