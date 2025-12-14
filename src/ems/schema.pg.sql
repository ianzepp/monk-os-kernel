-- =============================================================================
-- EMS CORE SCHEMA - PostgreSQL DIALECT
-- =============================================================================
--
-- Entity Management System meta-model tables for PostgreSQL.
-- This is the PostgreSQL dialect of src/ems/schema.sqlite.sql.
--
-- Key differences from SQLite:
-- - Native BOOLEAN type instead of INTEGER
-- - gen_random_uuid() for UUID generation
-- - TIMESTAMPTZ for timezone-aware timestamps
-- - CREATE TABLE IF NOT EXISTS supported
--
-- See src/ems/schema.sqlite.sql for architecture documentation.
--

-- =============================================================================
-- EXTENSIONS
-- =============================================================================
-- Enable UUID generation function
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- ENTITIES TABLE (Core Identity + Hierarchy)
-- =============================================================================

CREATE TABLE IF NOT EXISTS entities (
    -- Identity
    id          TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),

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

CREATE TABLE IF NOT EXISTS models (
    -- -------------------------------------------------------------------------
    -- System Fields
    -- -------------------------------------------------------------------------
    id          TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
    created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    trashed_at  TIMESTAMPTZ,
    expired_at  TIMESTAMPTZ,

    -- -------------------------------------------------------------------------
    -- Model Identity
    -- -------------------------------------------------------------------------
    model_name  TEXT NOT NULL UNIQUE,

    status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'system')),
    description TEXT,

    -- -------------------------------------------------------------------------
    -- Behavioral Flags
    -- -------------------------------------------------------------------------
    -- BOOLEAN types are native in PostgreSQL
    sudo        BOOLEAN DEFAULT FALSE,
    frozen      BOOLEAN DEFAULT FALSE,
    immutable   BOOLEAN DEFAULT FALSE,
    external    BOOLEAN DEFAULT FALSE,
    passthrough BOOLEAN DEFAULT FALSE,

    -- -------------------------------------------------------------------------
    -- VFS Integration
    -- -------------------------------------------------------------------------
    pathname    TEXT
);

-- Index active models by status for listing queries
CREATE INDEX IF NOT EXISTS idx_models_status
    ON models(status)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- FIELDS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS fields (
    -- -------------------------------------------------------------------------
    -- System Fields
    -- -------------------------------------------------------------------------
    id          TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
    created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    trashed_at  TIMESTAMPTZ,
    expired_at  TIMESTAMPTZ,

    -- -------------------------------------------------------------------------
    -- Field Identity
    -- -------------------------------------------------------------------------
    model_name  TEXT NOT NULL REFERENCES models(model_name) ON DELETE CASCADE,
    field_name  TEXT NOT NULL,

    -- -------------------------------------------------------------------------
    -- Type Information
    -- -------------------------------------------------------------------------
    type        TEXT NOT NULL DEFAULT 'text',
    is_array    BOOLEAN DEFAULT FALSE,

    -- -------------------------------------------------------------------------
    -- Constraints
    -- -------------------------------------------------------------------------
    required        BOOLEAN DEFAULT FALSE,
    default_value   TEXT,
    minimum         NUMERIC,
    maximum         NUMERIC,
    pattern         TEXT,
    enum_values     TEXT,

    -- -------------------------------------------------------------------------
    -- Relationships
    -- -------------------------------------------------------------------------
    relationship_type      TEXT CHECK (relationship_type IN ('owned', 'referenced')),
    related_model          TEXT,
    related_field          TEXT,
    relationship_name      TEXT,
    cascade_delete         BOOLEAN DEFAULT FALSE,
    required_relationship  BOOLEAN DEFAULT FALSE,

    -- -------------------------------------------------------------------------
    -- Behavioral Flags
    -- -------------------------------------------------------------------------
    immutable      BOOLEAN DEFAULT FALSE,
    sudo           BOOLEAN DEFAULT FALSE,
    indexed        TEXT CHECK (indexed IN ('simple', 'unique')),
    tracked        BOOLEAN DEFAULT FALSE,
    searchable     BOOLEAN DEFAULT FALSE,
    transform      TEXT,

    -- -------------------------------------------------------------------------
    -- Documentation
    -- -------------------------------------------------------------------------
    description TEXT,

    -- -------------------------------------------------------------------------
    -- Constraints
    -- -------------------------------------------------------------------------
    UNIQUE(model_name, field_name)
);

-- Index fields by model for listing queries
CREATE INDEX IF NOT EXISTS idx_fields_model
    ON fields(model_name)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- SEED DATA: SYSTEM META-MODELS
-- =============================================================================

INSERT INTO models (model_name, status, sudo, description)
VALUES
    ('models', 'system', TRUE, 'Model definitions - schema for entity types'),
    ('fields', 'system', TRUE, 'Field definitions - columns for each model')
ON CONFLICT (model_name) DO NOTHING;

-- =============================================================================
-- SEED DATA: MODELS TABLE FIELDS (Meta-model)
-- =============================================================================

INSERT INTO fields (model_name, field_name, type, required, description)
VALUES
    ('models', 'model_name', 'text', TRUE, 'Unique identifier for the model'),
    ('models', 'status', 'text', FALSE, 'Model status: active, disabled, or system'),
    ('models', 'description', 'text', FALSE, 'Human-readable description'),
    ('models', 'sudo', 'boolean', FALSE, 'Requires sudo for entity modifications'),
    ('models', 'frozen', 'boolean', FALSE, 'All entity changes prevented'),
    ('models', 'immutable', 'boolean', FALSE, 'Entities are write-once (no updates)'),
    ('models', 'external', 'boolean', FALSE, 'Managed by external system'),
    ('models', 'passthrough', 'boolean', FALSE, 'Skip observer pipeline (dangerous)'),
    ('models', 'pathname', 'text', FALSE, 'Field that becomes VFS pathname (null = not VFS)')
ON CONFLICT (model_name, field_name) DO NOTHING;

-- =============================================================================
-- SEED DATA: FIELDS TABLE FIELDS (Meta-model)
-- =============================================================================

INSERT INTO fields (model_name, field_name, type, required, description)
VALUES
    ('fields', 'model_name', 'text', TRUE, 'Parent model this field belongs to'),
    ('fields', 'field_name', 'text', TRUE, 'Name of the field'),
    ('fields', 'type', 'text', TRUE, 'Data type: text, integer, numeric, boolean, uuid, timestamp, date, jsonb'),
    ('fields', 'is_array', 'boolean', FALSE, 'Whether field holds an array'),
    ('fields', 'required', 'boolean', FALSE, 'Field is required on create'),
    ('fields', 'default_value', 'text', FALSE, 'Default value if not provided'),
    ('fields', 'minimum', 'numeric', FALSE, 'Minimum value for numeric types'),
    ('fields', 'maximum', 'numeric', FALSE, 'Maximum value for numeric types'),
    ('fields', 'pattern', 'text', FALSE, 'Regex pattern for text validation'),
    ('fields', 'enum_values', 'text', FALSE, 'Allowed values as JSON array'),
    ('fields', 'relationship_type', 'text', FALSE, 'Relationship type: owned or referenced'),
    ('fields', 'related_model', 'text', FALSE, 'Target model for relationship'),
    ('fields', 'related_field', 'text', FALSE, 'Target field for relationship'),
    ('fields', 'relationship_name', 'text', FALSE, 'Human-readable relationship name'),
    ('fields', 'cascade_delete', 'boolean', FALSE, 'Cascade delete to related records'),
    ('fields', 'required_relationship', 'boolean', FALSE, 'Related record must exist'),
    ('fields', 'immutable', 'boolean', FALSE, 'Cannot change after creation'),
    ('fields', 'sudo', 'boolean', FALSE, 'Requires sudo to modify'),
    ('fields', 'indexed', 'text', FALSE, 'Index type: simple or unique'),
    ('fields', 'tracked', 'boolean', FALSE, 'Track changes in audit log'),
    ('fields', 'searchable', 'boolean', FALSE, 'Include in full-text search'),
    ('fields', 'transform', 'text', FALSE, 'Auto-transform: lowercase, trim, uppercase'),
    ('fields', 'description', 'text', FALSE, 'Field description')
ON CONFLICT (model_name, field_name) DO NOTHING;
