-- =============================================================================
-- AUTH SCHEMA
-- =============================================================================
--
-- Authentication subsystem tables and seed data.
-- Applied by Auth.init() after EMS core schema is loaded.
--
-- DEPENDENCIES
-- ============
-- Requires EMS core schema (entities, models, fields tables must exist).

-- =============================================================================
-- SEED DATA: AUTH SYSTEM MODELS
-- =============================================================================

INSERT OR IGNORE INTO models (model_name, status, description, pathname) VALUES
    ('auth_user', 'system', 'User account entity', 'username'),
    ('auth_session', 'system', 'User session entity', NULL);

-- =============================================================================
-- AUTH_USER TABLE
-- =============================================================================
-- User accounts for password authentication.

CREATE TABLE IF NOT EXISTS auth_user (
    -- Identity: FK to entities table
    id              TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    trashed_at      TEXT,
    expired_at      TEXT,

    -- User-specific fields
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    disabled        INTEGER DEFAULT 0
);

-- Index for username lookup
CREATE INDEX IF NOT EXISTS idx_auth_user_username
    ON auth_user(username);

-- =============================================================================
-- AUTH_SESSION TABLE
-- =============================================================================
-- Active sessions for authenticated users.

CREATE TABLE IF NOT EXISTS auth_session (
    -- Identity: FK to entities table
    id              TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    trashed_at      TEXT,
    expired_at      TEXT,

    -- Session-specific fields
    -- WHY no FK: auth:grant can mint tokens for service principals (e.g., 'svc:httpd')
    -- that don't exist in auth_user. The principal is just an identity string.
    user_id         TEXT NOT NULL,
    expires         INTEGER NOT NULL,
    ip              TEXT,
    user_agent      TEXT
);

-- Index for user_id lookup (list sessions for user)
CREATE INDEX IF NOT EXISTS idx_auth_session_user_id
    ON auth_session(user_id);

-- Index for expiry cleanup
CREATE INDEX IF NOT EXISTS idx_auth_session_expires
    ON auth_session(expires);

-- =============================================================================
-- SEED DATA: AUTH_USER MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('auth_user', 'username', 'text', 1, 'Unique username for login'),
    ('auth_user', 'password_hash', 'text', 1, 'Argon2id password hash'),
    ('auth_user', 'disabled', 'integer', 0, 'Account disabled flag (0 or 1)');

-- =============================================================================
-- SEED DATA: AUTH_SESSION MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('auth_session', 'user_id', 'uuid', 1, 'Reference to auth_user.id'),
    ('auth_session', 'expires', 'integer', 1, 'Session expiry timestamp (ms since epoch)'),
    ('auth_session', 'ip', 'text', 0, 'Client IP address'),
    ('auth_session', 'user_agent', 'text', 0, 'Client user agent');

-- =============================================================================
-- SEED DATA: ROOT USER
-- =============================================================================
-- The root user is seeded by Auth.init() because password hashing requires
-- runtime crypto (argon2id with random salt). The well-known UUID ensures
-- consistent identity across restarts.
--
-- Root user UUID: 00000000-0000-0000-0000-000000000001
-- Default password: 'root' (change in production!)
