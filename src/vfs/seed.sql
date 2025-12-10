-- =============================================================================
-- VFS SEED DATA
-- =============================================================================
--
-- Seed data for VFS initialization. Applied after models are imported via JSON.
-- Model and field definitions are now in src/vfs/models/*.json.
--
-- DEPENDENCIES
-- ============
-- Requires EMS core schema and VFS models to be loaded first.

-- =============================================================================
-- ROOT ENTITY
-- =============================================================================
-- The root entity is the namespace origin. All paths start here.
-- WHY well-known UUID: Simplifies bootstrap, no discovery needed.

INSERT OR IGNORE INTO entities (id, model, parent, pathname) VALUES
    ('00000000-0000-0000-0000-000000000000', 'folder', NULL, '');

-- =============================================================================
-- ROOT FOLDER DETAIL
-- =============================================================================

INSERT OR IGNORE INTO folder (id, owner) VALUES
    ('00000000-0000-0000-0000-000000000000', 'system');
