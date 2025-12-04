-- =============================================================================
-- MONK OS MODEL SCHEMA
-- =============================================================================
--
-- ARCHITECTURE OVERVIEW
-- =====================
-- This schema defines how model and field metadata is stored in Monk OS.
-- It is the foundation for the entity+data architecture where:
--
-- - Entity identity and hierarchy is stored in the `entities` table
-- - Entity detail (model-specific fields) is stored in per-model tables
-- - Blob data (raw bytes) is stored separately in HAL block storage
--
-- TABLE HIERARCHY
-- ===============
-- ```
--   entities        Core identity + hierarchy (id, model, parent, name)
--      |
--      +-- file     Detail table (owner, size, mimetype, checksum)
--      +-- folder   Detail table (owner)
--      +-- device   Detail table (owner, driver)
--      +-- proc     Detail table (owner, handler)
--      +-- link     Detail table (owner, target)
--      +-- temp     Detail table (owner, size, mimetype)
--
--   models          Field definitions for each model
--      |
--      +-- fields   One row per field per model
--      |
--      +-- tracked  Change history for audited fields
-- ```
--
-- SYSTEM FIELDS
-- =============
-- The entities table has these columns:
--   id            UUID primary key (32 hex chars, lowercase)
--   model         Model name (determines detail table)
--   parent        Parent entity UUID (null for root)
--   name          Entity name for path resolution
--   created_at    Creation timestamp (ISO 8601)
--   updated_at    Last modification timestamp (ISO 8601)
--   trashed_at    Soft delete timestamp (null = active)
--
-- Detail tables have:
--   id            FK to entities.id (CASCADE on delete)
--   ...           Model-specific fields only
--
-- INVARIANTS
-- ==========
-- INV-1: Every entity has exactly one row in `entities`
-- INV-2: Every entity has exactly one row in its model's detail table
-- INV-3: entities.model matches the detail table name
-- INV-4: entities.parent references a valid entity or is null (root)
-- INV-5: (parent, name) is unique within active entities
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
-- ENTITIES TABLE (Core Identity + Hierarchy)
-- =============================================================================
-- Single source of truth for entity identity and path hierarchy.
-- This table is NOT a model - it's core infrastructure like models/fields.
--
-- WHY separate from model tables:
-- 1. EntityCache loads from ONE table, not all model tables
-- 2. Parent FK can reference any entity type (file in folder, link in folder)
-- 3. Path resolution is pure entities traversal, no model knowledge needed
--
-- WHY not seeded into models/fields:
-- This is infrastructure, not a user-visible entity type. Like models/fields
-- themselves, it exists outside the normal model system.

CREATE TABLE IF NOT EXISTS entities (
    -- -------------------------------------------------------------------------
    -- Identity (minimal for cache efficiency)
    -- -------------------------------------------------------------------------
    -- WHY only 4 columns: EntityCache loads all entities into memory.
    -- Every byte matters at scale. Timestamps live in detail tables.
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

    -- WHY model NOT NULL: Every entity belongs to exactly one model.
    -- This determines which detail table has additional fields.
    model       TEXT NOT NULL,

    -- -------------------------------------------------------------------------
    -- Hierarchy
    -- -------------------------------------------------------------------------
    -- WHY parent nullable: Root entity has no parent.
    -- WHY FK to entities: Cross-model parent relationships (file in folder).
    parent      TEXT REFERENCES entities(id),

    -- WHY name NOT NULL: Every entity needs a name for path resolution.
    -- Root is special case (name = '').
    name        TEXT NOT NULL
);

-- Index for path resolution: find child by parent + name
-- This is the critical index for O(1) path component lookup
-- Note: No partial index - entities table has no trashed_at column.
-- Uniqueness is enforced across all entities (trashed or not).
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_parent_name
    ON entities(parent, name);

-- Index for listing children of a parent (readdir)
CREATE INDEX IF NOT EXISTS idx_entities_parent
    ON entities(parent);

-- Index for finding all entities of a model type
CREATE INDEX IF NOT EXISTS idx_entities_model
    ON entities(model);

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
-- MODEL DETAIL TABLES
-- =============================================================================
-- These tables store model-specific fields. They do NOT store hierarchy
-- (id, parent, name) - that's in the entities table.
--
-- WHY FK with CASCADE: When entity is deleted, detail row is auto-deleted.
-- WHY separate tables: Enables SQL-level constraints and efficient queries.

-- =============================================================================
-- FILE TABLE (Detail)
-- =============================================================================
-- Regular file entities. Metadata here, blob content in HAL block storage.

CREATE TABLE IF NOT EXISTS file (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- File-specific fields
    owner       TEXT NOT NULL,
    size        INTEGER DEFAULT 0,
    mimetype    TEXT,
    checksum    TEXT
);

-- Index for listing files by owner
CREATE INDEX IF NOT EXISTS idx_file_owner
    ON file(owner);

-- =============================================================================
-- FOLDER TABLE (Detail)
-- =============================================================================
-- Directory entities. No blob data - children computed via entities.parent.

CREATE TABLE IF NOT EXISTS folder (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Folder-specific fields
    owner       TEXT NOT NULL
);

-- Index for listing folders by owner
CREATE INDEX IF NOT EXISTS idx_folder_owner
    ON folder(owner);

-- =============================================================================
-- DEVICE TABLE (Detail)
-- =============================================================================
-- Device node entities. Kernel-provided virtual files (/dev/console, etc.).

CREATE TABLE IF NOT EXISTS device (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Device-specific fields
    owner       TEXT NOT NULL,
    driver      TEXT NOT NULL
);

-- =============================================================================
-- PROC TABLE (Detail)
-- =============================================================================
-- Process/virtual file entities. Dynamic content generated by handler.

CREATE TABLE IF NOT EXISTS proc (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Proc-specific fields
    owner       TEXT NOT NULL,
    handler     TEXT NOT NULL
);

-- =============================================================================
-- LINK TABLE (Detail)
-- =============================================================================
-- Symbolic link entities. Redirect path resolution to another location.

CREATE TABLE IF NOT EXISTS link (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Link-specific fields
    owner       TEXT NOT NULL,
    target      TEXT NOT NULL
);

-- =============================================================================
-- TEMP TABLE (Detail)
-- =============================================================================
-- Temporary file entities for /tmp filesystem.

CREATE TABLE IF NOT EXISTS temp (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Temp-specific fields
    owner       TEXT NOT NULL,
    size        INTEGER DEFAULT 0,
    mimetype    TEXT
);

-- =============================================================================
-- SEED DATA: ROOT ENTITY
-- =============================================================================
-- The root entity is the namespace origin. All paths start here.
-- WHY well-known UUID: Simplifies bootstrap, no discovery needed.

INSERT OR IGNORE INTO entities (id, model, parent, name) VALUES
    ('00000000-0000-0000-0000-000000000000', 'folder', NULL, '');

INSERT OR IGNORE INTO folder (id, owner) VALUES
    ('00000000-0000-0000-0000-000000000000', 'system');

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
-- Core VFS entity types. Their detail is in per-model tables, blob data
-- (if any) is stored separately in HAL block storage.

INSERT OR IGNORE INTO models (model_name, status, description) VALUES
    ('file', 'system', 'Regular file entity - has associated blob data'),
    ('folder', 'system', 'Directory entity - contains child entries'),
    ('device', 'system', 'Device node entity - kernel device interface'),
    ('proc', 'system', 'Process/virtual file entity - dynamic content'),
    ('link', 'system', 'Symbolic link entity - path redirection'),
    ('temp', 'system', 'Temporary file entity - SQL metadata + HAL blob');

-- =============================================================================
-- SEED DATA: MODELS TABLE FIELDS (Meta-model)
-- =============================================================================

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
-- Note: parent and name are in entities table, not here

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('file', 'owner', 'uuid', 1, 'Owner user or process ID'),
    ('file', 'size', 'integer', 0, 'Blob size in bytes'),
    ('file', 'mimetype', 'text', 0, 'MIME type (e.g., application/pdf)'),
    ('file', 'checksum', 'text', 0, 'Content hash for integrity verification');

-- =============================================================================
-- SEED DATA: FOLDER MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('folder', 'owner', 'uuid', 1, 'Owner user or process ID');

-- =============================================================================
-- SEED DATA: DEVICE MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('device', 'owner', 'uuid', 1, 'Owner user or process ID'),
    ('device', 'driver', 'text', 1, 'Device driver identifier (e.g., hal:console)');

-- =============================================================================
-- SEED DATA: PROC MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('proc', 'owner', 'uuid', 1, 'Owner user or process ID'),
    ('proc', 'handler', 'text', 1, 'Handler function identifier');

-- =============================================================================
-- SEED DATA: LINK MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('link', 'owner', 'uuid', 1, 'Owner user or process ID'),
    ('link', 'target', 'text', 1, 'Target path (absolute or relative)');

-- =============================================================================
-- SEED DATA: TEMP MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('temp', 'owner', 'text', 1, 'Owner process or user ID'),
    ('temp', 'size', 'integer', 0, 'Blob size in bytes'),
    ('temp', 'mimetype', 'text', 0, 'MIME type (e.g., application/octet-stream)');
