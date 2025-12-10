-- =============================================================================
-- EMS CORE SCHEMA (PostgreSQL)
-- =============================================================================
--
-- Entity Management System core tables and meta-model seeds.
-- This is the PostgreSQL version of schema.sql.

-- =============================================================================
-- ENTITIES TABLE (Core Identity + Hierarchy)
-- =============================================================================

CREATE TABLE IF NOT EXISTS entities (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    model       TEXT NOT NULL,
    parent      TEXT REFERENCES entities(id),
    pathname    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_parent_pathname
    ON entities(parent, pathname);

CREATE INDEX IF NOT EXISTS idx_entities_parent
    ON entities(parent);

CREATE INDEX IF NOT EXISTS idx_entities_model
    ON entities(model);

-- =============================================================================
-- MODELS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS models (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now(),
    trashed_at  TIMESTAMPTZ,
    expired_at  TIMESTAMPTZ,

    model_name  TEXT NOT NULL UNIQUE,
    status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'system')),
    description TEXT,

    sudo        BOOLEAN DEFAULT false,
    frozen      BOOLEAN DEFAULT false,
    immutable   BOOLEAN DEFAULT false,
    external    BOOLEAN DEFAULT false,
    passthrough BOOLEAN DEFAULT false,

    pathname    TEXT
);

CREATE INDEX IF NOT EXISTS idx_models_status
    ON models(status)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- FIELDS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS fields (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now(),
    trashed_at  TIMESTAMPTZ,
    expired_at  TIMESTAMPTZ,

    model_name  TEXT NOT NULL REFERENCES models(model_name) ON DELETE CASCADE,
    field_name  TEXT NOT NULL,

    type        TEXT NOT NULL DEFAULT 'text',
    is_array    BOOLEAN DEFAULT false,

    required        BOOLEAN DEFAULT false,
    default_value   TEXT,
    minimum         NUMERIC,
    maximum         NUMERIC,
    pattern         TEXT,
    enum_values     TEXT,

    relationship_type   TEXT CHECK (relationship_type IN ('owned', 'referenced')),
    related_model       TEXT,
    related_field       TEXT,
    relationship_name   TEXT,
    cascade_delete      BOOLEAN DEFAULT false,
    required_relationship BOOLEAN DEFAULT false,

    immutable   BOOLEAN DEFAULT false,
    sudo        BOOLEAN DEFAULT false,
    indexed     TEXT CHECK (indexed IN ('simple', 'unique')),
    tracked     BOOLEAN DEFAULT false,
    searchable  BOOLEAN DEFAULT false,
    transform   TEXT,

    description TEXT,

    UNIQUE(model_name, field_name)
);

CREATE INDEX IF NOT EXISTS idx_fields_model
    ON fields(model_name)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- TRACKED TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS tracked (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now(),
    trashed_at  TIMESTAMPTZ,
    expired_at  TIMESTAMPTZ,

    change_id   INTEGER,
    model_name  TEXT NOT NULL,
    record_id   TEXT NOT NULL,

    operation   TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    changes     TEXT NOT NULL,
    created_by  TEXT,
    request_id  TEXT,
    metadata    TEXT
);

CREATE INDEX IF NOT EXISTS idx_tracked_record
    ON tracked(model_name, record_id, change_id DESC);

-- =============================================================================
-- SEED DATA: SYSTEM META-MODELS
-- =============================================================================

INSERT INTO models (model_name, status, sudo, description) VALUES
    ('models', 'system', true, 'Model definitions - schema for entity types'),
    ('fields', 'system', true, 'Field definitions - columns for each model'),
    ('tracked', 'system', true, 'Change tracking history - audit log')
ON CONFLICT (model_name) DO NOTHING;

-- =============================================================================
-- SEED DATA: MODELS TABLE FIELDS
-- =============================================================================

INSERT INTO fields (model_name, field_name, type, required, description) VALUES
    ('models', 'model_name', 'text', true, 'Unique identifier for the model'),
    ('models', 'status', 'text', false, 'Model status: active, disabled, or system'),
    ('models', 'description', 'text', false, 'Human-readable description'),
    ('models', 'sudo', 'boolean', false, 'Requires sudo for entity modifications'),
    ('models', 'frozen', 'boolean', false, 'All entity changes prevented'),
    ('models', 'immutable', 'boolean', false, 'Entities are write-once (no updates)'),
    ('models', 'external', 'boolean', false, 'Managed by external system'),
    ('models', 'passthrough', 'boolean', false, 'Skip observer pipeline (dangerous)'),
    ('models', 'pathname', 'text', false, 'Field that becomes VFS pathname (null = not VFS)')
ON CONFLICT (model_name, field_name) DO NOTHING;

-- =============================================================================
-- SEED DATA: FIELDS TABLE FIELDS
-- =============================================================================

INSERT INTO fields (model_name, field_name, type, required, description) VALUES
    ('fields', 'model_name', 'text', true, 'Parent model this field belongs to'),
    ('fields', 'field_name', 'text', true, 'Name of the field'),
    ('fields', 'type', 'text', true, 'Data type: text, integer, numeric, boolean, uuid, timestamp, date, jsonb'),
    ('fields', 'is_array', 'boolean', false, 'Whether field holds an array'),
    ('fields', 'required', 'boolean', false, 'Field is required on create'),
    ('fields', 'default_value', 'text', false, 'Default value if not provided'),
    ('fields', 'minimum', 'numeric', false, 'Minimum value for numeric types'),
    ('fields', 'maximum', 'numeric', false, 'Maximum value for numeric types'),
    ('fields', 'pattern', 'text', false, 'Regex pattern for text validation'),
    ('fields', 'enum_values', 'text', false, 'Allowed values as JSON array'),
    ('fields', 'relationship_type', 'text', false, 'Relationship type: owned or referenced'),
    ('fields', 'related_model', 'text', false, 'Target model for relationship'),
    ('fields', 'related_field', 'text', false, 'Target field for relationship'),
    ('fields', 'relationship_name', 'text', false, 'Human-readable relationship name'),
    ('fields', 'cascade_delete', 'boolean', false, 'Cascade delete to related records'),
    ('fields', 'required_relationship', 'boolean', false, 'Related record must exist'),
    ('fields', 'immutable', 'boolean', false, 'Cannot change after creation'),
    ('fields', 'sudo', 'boolean', false, 'Requires sudo to modify'),
    ('fields', 'indexed', 'text', false, 'Index type: simple or unique'),
    ('fields', 'tracked', 'boolean', false, 'Track changes in audit log'),
    ('fields', 'searchable', 'boolean', false, 'Include in full-text search'),
    ('fields', 'transform', 'text', false, 'Auto-transform: lowercase, trim, uppercase'),
    ('fields', 'description', 'text', false, 'Field description')
ON CONFLICT (model_name, field_name) DO NOTHING;

-- =============================================================================
-- SEED DATA: TRACKED TABLE FIELDS
-- =============================================================================

INSERT INTO fields (model_name, field_name, type, required, description) VALUES
    ('tracked', 'change_id', 'integer', true, 'Sequence number within record'),
    ('tracked', 'model_name', 'text', true, 'Model where change occurred'),
    ('tracked', 'record_id', 'text', true, 'Entity that was changed'),
    ('tracked', 'operation', 'text', true, 'Operation: create, update, or delete'),
    ('tracked', 'changes', 'text', true, 'Field changes as JSON object'),
    ('tracked', 'created_by', 'text', false, 'User or process that made change'),
    ('tracked', 'request_id', 'text', false, 'Request correlation ID'),
    ('tracked', 'metadata', 'text', false, 'Additional context as JSON')
ON CONFLICT (model_name, field_name) DO NOTHING;
