-- =============================================================================
-- EMS CORE SCHEMA
-- =============================================================================
--
-- Entity Management System meta-model tables.
-- Defines the schema system itself: models, fields, and the core entities
-- table used for VFS path hierarchy.
--
-- ARCHITECTURE OVERVIEW
-- =====================
-- EMS provides the infrastructure for defining entity types:
--
--   entities    Core identity + hierarchy (id, model, parent, pathname)
--      |
--   models      Model definitions (what entity types exist)
--      |
--      +-- fields   Field definitions (what columns each model has)
--
-- WHY entities is here: The entities table is foundational infrastructure
-- that multiple subsystems depend on (Auth, LLM have FK constraints to it).
-- Even though it's conceptually a VFS concept, it must be created early
-- in the boot sequence before subsystems that reference it.
--
-- Per-model detail tables are created dynamically by DdlCreateModel observer.
--
-- NOTE: The `tracked` field flag exists in fields table, but the actual
-- audit infrastructure (tracked table + observer) is in src/audit/.
--
-- LOAD ORDER
-- ==========
-- 1. EMS schema (this file) - creates entities, models, fields
-- 2. VFS schema - seeds root entity, creates VFS model detail tables
-- 3. Auth schema - creates users/sessions with FK to entities
-- 4. Audit schema (optional) - creates tracked table for audit logging
-- 5. Other subsystems - register their models via EMS
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
-- This table is VFS infrastructure - not a user-visible model.
--
-- WHY in EMS schema: Auth and LLM schemas have FK constraints to entities.
-- They load before VFS.init(), so entities must exist early.
--
-- WHY separate from detail tables:
-- 1. PathCache loads from ONE table, not all model tables
-- 2. Parent FK can reference any entity type (file in folder, link in folder)
-- 3. Path resolution is pure entities traversal, no model knowledge needed

CREATE TABLE IF NOT EXISTS entities (
    -- Identity (minimal for cache efficiency)
    -- WHY only 4 columns: PathCache loads all entities into memory.
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

    -- Model name determines which detail table has additional fields
    model       TEXT NOT NULL,

    -- Hierarchy: parent is null for root entity
    parent      TEXT REFERENCES entities(id),

    -- Pathname component for this entity (empty string for root)
    pathname    TEXT NOT NULL
);

-- Index for path resolution: find child by parent + pathname
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_parent_pathname
    ON entities(parent, pathname);

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
    passthrough INTEGER DEFAULT 0,

    -- -------------------------------------------------------------------------
    -- VFS Integration
    -- -------------------------------------------------------------------------
    -- WHY pathname: Specifies which field becomes the VFS path component.
    -- NULL = model is not VFS-addressable (data-only, accessed via API/SQL)
    -- 'fieldname' = that field's value becomes entities.pathname
    -- Example: pathname = 'email' means users.email becomes the VFS path
    pathname    TEXT
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

    -- indexed: Create database index for faster queries
    -- NULL = no index, 'simple' = regular index, 'unique' = unique constraint index
    indexed     TEXT CHECK (indexed IN ('simple', 'unique')),

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
-- SEED DATA: SYSTEM META-MODELS
-- =============================================================================
-- These models define the schema system itself. They require sudo access
-- because modifying them affects the entire system.
--
-- WHY INSERT OR IGNORE: Idempotent - safe to run multiple times.

INSERT OR IGNORE INTO models (model_name, status, sudo, description) VALUES
    ('models', 'system', 1, 'Model definitions - schema for entity types'),
    ('fields', 'system', 1, 'Field definitions - columns for each model');

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
    ('models', 'passthrough', 'boolean', 0, 'Skip observer pipeline (dangerous)'),
    ('models', 'pathname', 'text', 0, 'Field that becomes VFS pathname (null = not VFS)');

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
    ('fields', 'indexed', 'text', 0, 'Index type: simple or unique'),
    ('fields', 'tracked', 'boolean', 0, 'Track changes in audit log'),
    ('fields', 'searchable', 'boolean', 0, 'Include in full-text search'),
    ('fields', 'transform', 'text', 0, 'Auto-transform: lowercase, trim, uppercase'),
    ('fields', 'description', 'text', 0, 'Field description');
