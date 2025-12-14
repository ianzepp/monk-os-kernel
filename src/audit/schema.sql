-- =============================================================================
-- AUDIT SCHEMA
-- =============================================================================
--
-- Change tracking infrastructure for fields marked with tracked=1.
-- This is an optional subsystem - load via Audit.init() if needed.
--
-- DEPENDENCIES
-- ============
-- Requires EMS core schema (models, fields tables must exist).
--
-- USAGE
-- =====
-- Fields with tracked=1 in the fields table will have their changes
-- recorded in this table when the Tracked observer is registered.

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
-- SEED DATA: TRACKED MODEL
-- =============================================================================

INSERT OR IGNORE INTO models (model_name, status, sudo, description) VALUES
    ('tracked', 'system', 1, 'Change tracking history - audit log');

-- =============================================================================
-- SEED DATA: TRACKED MODEL FIELDS
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
