-- =============================================================================
-- DISPLAY SUBSYSTEM SCHEMA
-- =============================================================================
--
-- ARCHITECTURE OVERVIEW
-- =====================
-- This schema defines the display subsystem models for browser-based windowing.
-- It extends the core EMS schema with display-specific entity types:
--
-- - display: Browser session/connection
-- - window: Application window owned by a process
-- - element: UI element within a window (DOM-like)
-- - event: Input event from browser
-- - cursor: Mouse cursor state per display
-- - selection: Text selection state
--
-- PERFORMANCE
-- ===========
-- Models with passthrough=1 (element, event, cursor) skip observer rings 2-7
-- for high-frequency updates. Benchmarks show 60fps is achievable.
--
-- RELATIONSHIPS
-- =============
-- ```
--   display
--      ├── window (owned, cascade delete)
--      │      ├── element (owned, cascade delete)
--      │      └── selection (owned, cascade delete)
--      └── cursor (owned, cascade delete, 1:1)
--
--   event → display (reference)
--        → window (reference, optional)
--        → element (reference, optional)
-- ```

-- =============================================================================
-- DISPLAY TABLE (Detail)
-- =============================================================================
-- Browser session. One display per connected browser tab/window.

CREATE TABLE IF NOT EXISTS display (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Display-specific fields
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    dpi         REAL DEFAULT 1,
    connected   INTEGER DEFAULT 0,
    session_id  TEXT,
    user_agent  TEXT,
    last_ping   TEXT
);

-- Index for finding connected displays
CREATE INDEX IF NOT EXISTS idx_display_connected
    ON display(connected)
    WHERE trashed_at IS NULL;

-- Unique session ID
CREATE UNIQUE INDEX IF NOT EXISTS idx_display_session
    ON display(session_id)
    WHERE session_id IS NOT NULL AND trashed_at IS NULL;

-- =============================================================================
-- WINDOW TABLE (Detail)
-- =============================================================================
-- Application window. Owned by a process, displayed on a display.

CREATE TABLE IF NOT EXISTS window (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Window-specific fields
    display_id  TEXT NOT NULL,
    title       TEXT DEFAULT '',
    x           INTEGER DEFAULT 0,
    y           INTEGER DEFAULT 0,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    min_width   INTEGER,
    min_height  INTEGER,
    max_width   INTEGER,
    max_height  INTEGER,
    z_index     INTEGER DEFAULT 0,
    focused     INTEGER DEFAULT 0,
    visible     INTEGER DEFAULT 1,
    minimized   INTEGER DEFAULT 0,
    maximized   INTEGER DEFAULT 0,
    resizable   INTEGER DEFAULT 1,
    movable     INTEGER DEFAULT 1,
    closable    INTEGER DEFAULT 1,
    owner_pid   TEXT NOT NULL,
    background  TEXT,
    opacity     REAL DEFAULT 1.0
);

-- Index for finding windows by display
CREATE INDEX IF NOT EXISTS idx_window_display
    ON window(display_id)
    WHERE trashed_at IS NULL;

-- Index for finding windows by owner process
CREATE INDEX IF NOT EXISTS idx_window_owner
    ON window(owner_pid)
    WHERE trashed_at IS NULL;

-- Index for z-order queries
CREATE INDEX IF NOT EXISTS idx_window_z_index
    ON window(display_id, z_index)
    WHERE trashed_at IS NULL;

-- Index for focus queries
CREATE INDEX IF NOT EXISTS idx_window_focused
    ON window(focused)
    WHERE focused = 1 AND trashed_at IS NULL;

-- =============================================================================
-- ELEMENT TABLE (Detail)
-- =============================================================================
-- UI element within a window. Passthrough for performance.

CREATE TABLE IF NOT EXISTS element (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Element-specific fields
    window_id   TEXT NOT NULL,
    parent_id   TEXT,
    tag         TEXT NOT NULL DEFAULT 'div',
    props       TEXT,           -- JSON object
    text        TEXT,
    order_      INTEGER DEFAULT 0,
    flex        TEXT,
    width       TEXT,
    height      TEXT,
    disabled    INTEGER DEFAULT 0,
    hidden      INTEGER DEFAULT 0,
    value       TEXT,
    placeholder TEXT,
    tabindex    INTEGER,
    autofocus   INTEGER DEFAULT 0
);

-- Index for finding elements by window
CREATE INDEX IF NOT EXISTS idx_element_window
    ON element(window_id)
    WHERE trashed_at IS NULL;

-- Index for finding children of an element
CREATE INDEX IF NOT EXISTS idx_element_parent
    ON element(parent_id)
    WHERE trashed_at IS NULL;

-- Index for hidden elements
CREATE INDEX IF NOT EXISTS idx_element_hidden
    ON element(hidden)
    WHERE hidden = 0 AND trashed_at IS NULL;

-- =============================================================================
-- EVENT TABLE (Detail)
-- =============================================================================
-- Input event from browser. Passthrough for performance.

CREATE TABLE IF NOT EXISTS event (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Event-specific fields
    display_id  TEXT NOT NULL,
    window_id   TEXT,
    element_id  TEXT,
    type        TEXT NOT NULL,
    data        TEXT,           -- JSON object
    timestamp   INTEGER NOT NULL,
    target_tag  TEXT,
    key         TEXT,
    button      INTEGER,
    x           INTEGER,
    y           INTEGER,
    shift       INTEGER DEFAULT 0,
    ctrl        INTEGER DEFAULT 0,
    alt         INTEGER DEFAULT 0,
    meta        INTEGER DEFAULT 0,
    handled     INTEGER DEFAULT 0,
    prevented   INTEGER DEFAULT 0
);

-- Index for finding events by display
CREATE INDEX IF NOT EXISTS idx_event_display
    ON event(display_id)
    WHERE trashed_at IS NULL;

-- Index for finding events by window
CREATE INDEX IF NOT EXISTS idx_event_window
    ON event(window_id)
    WHERE window_id IS NOT NULL AND trashed_at IS NULL;

-- Index for finding events by type
CREATE INDEX IF NOT EXISTS idx_event_type
    ON event(type)
    WHERE trashed_at IS NULL;

-- Index for unhandled events
CREATE INDEX IF NOT EXISTS idx_event_handled
    ON event(handled)
    WHERE handled = 0 AND trashed_at IS NULL;

-- Index for keyboard events by key
CREATE INDEX IF NOT EXISTS idx_event_key
    ON event(key)
    WHERE key IS NOT NULL AND trashed_at IS NULL;

-- Index for events by timestamp (for TTL cleanup)
CREATE INDEX IF NOT EXISTS idx_event_timestamp
    ON event(timestamp);

-- =============================================================================
-- CURSOR TABLE (Detail)
-- =============================================================================
-- Mouse cursor state. One per display. Passthrough for performance.

CREATE TABLE IF NOT EXISTS cursor (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Cursor-specific fields
    display_id  TEXT NOT NULL,
    x           INTEGER NOT NULL DEFAULT 0,
    y           INTEGER NOT NULL DEFAULT 0,
    style       TEXT DEFAULT 'default',
    visible     INTEGER DEFAULT 1,
    window_id   TEXT,
    element_id  TEXT
);

-- Unique cursor per display
CREATE UNIQUE INDEX IF NOT EXISTS idx_cursor_display
    ON cursor(display_id)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- SELECTION TABLE (Detail)
-- =============================================================================
-- Text selection state within a window.

CREATE TABLE IF NOT EXISTS selection (
    -- Identity: FK to entities table
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    -- Selection-specific fields
    window_id       TEXT NOT NULL,
    element_id      TEXT,
    text            TEXT,
    start_offset    INTEGER,
    end_offset      INTEGER,
    collapsed       INTEGER DEFAULT 1,
    direction       TEXT DEFAULT 'forward',
    start_element_id TEXT,
    end_element_id  TEXT
);

-- Index for finding selection by window
CREATE INDEX IF NOT EXISTS idx_selection_window
    ON selection(window_id)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- SEED DATA: DISPLAY MODELS
-- =============================================================================
-- Register display subsystem models in EMS.

INSERT OR IGNORE INTO models (model_name, status, description, pathname, passthrough) VALUES
    ('display', 'system', 'Browser display session', 'id', 0),
    ('window', 'system', 'Application window', NULL, 0),
    ('element', 'system', 'UI element within a window', NULL, 1),
    ('event', 'system', 'Input event from browser', NULL, 1),
    ('cursor', 'system', 'Mouse cursor state', NULL, 1),
    ('selection', 'system', 'Text selection state', NULL, 0);

-- =============================================================================
-- SEED DATA: DISPLAY MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, default_value, description) VALUES
    ('display', 'width', 'integer', 1, NULL, 'Screen width in pixels'),
    ('display', 'height', 'integer', 1, NULL, 'Screen height in pixels'),
    ('display', 'dpi', 'numeric', 0, '1', 'Device pixel ratio'),
    ('display', 'connected', 'boolean', 0, '0', 'Browser currently connected'),
    ('display', 'session_id', 'text', 0, NULL, 'Browser session identifier'),
    ('display', 'user_agent', 'text', 0, NULL, 'Browser user agent string'),
    ('display', 'last_ping', 'timestamp', 0, NULL, 'Last heartbeat from browser');

-- =============================================================================
-- SEED DATA: WINDOW MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, default_value, index_, relationship_type, related_model, cascade_delete, description) VALUES
    ('window', 'display_id', 'uuid', 1, NULL, 1, 'owned', 'display', 1, 'Parent display'),
    ('window', 'title', 'text', 0, '', 0, NULL, NULL, 0, 'Window title bar text'),
    ('window', 'x', 'integer', 0, '0', 0, NULL, NULL, 0, 'X position in pixels'),
    ('window', 'y', 'integer', 0, '0', 0, NULL, NULL, 0, 'Y position in pixels'),
    ('window', 'width', 'integer', 1, NULL, 0, NULL, NULL, 0, 'Window width in pixels'),
    ('window', 'height', 'integer', 1, NULL, 0, NULL, NULL, 0, 'Window height in pixels'),
    ('window', 'min_width', 'integer', 0, NULL, 0, NULL, NULL, 0, 'Minimum window width'),
    ('window', 'min_height', 'integer', 0, NULL, 0, NULL, NULL, 0, 'Minimum window height'),
    ('window', 'max_width', 'integer', 0, NULL, 0, NULL, NULL, 0, 'Maximum window width'),
    ('window', 'max_height', 'integer', 0, NULL, 0, NULL, NULL, 0, 'Maximum window height'),
    ('window', 'z_index', 'integer', 0, '0', 1, NULL, NULL, 0, 'Stacking order'),
    ('window', 'focused', 'boolean', 0, '0', 1, NULL, NULL, 0, 'Has keyboard focus'),
    ('window', 'visible', 'boolean', 0, '1', 1, NULL, NULL, 0, 'Is visible on screen'),
    ('window', 'minimized', 'boolean', 0, '0', 0, NULL, NULL, 0, 'Window is minimized'),
    ('window', 'maximized', 'boolean', 0, '0', 0, NULL, NULL, 0, 'Window is maximized'),
    ('window', 'resizable', 'boolean', 0, '1', 0, NULL, NULL, 0, 'Window can be resized'),
    ('window', 'movable', 'boolean', 0, '1', 0, NULL, NULL, 0, 'Window can be moved'),
    ('window', 'closable', 'boolean', 0, '1', 0, NULL, NULL, 0, 'Window can be closed'),
    ('window', 'owner_pid', 'text', 1, NULL, 1, NULL, NULL, 0, 'Owning process UUID'),
    ('window', 'background', 'text', 0, NULL, 0, NULL, NULL, 0, 'Background color or CSS value'),
    ('window', 'opacity', 'numeric', 0, '1.0', 0, NULL, NULL, 0, 'Window opacity (0-1)');

-- =============================================================================
-- SEED DATA: ELEMENT MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, default_value, index_, relationship_type, related_model, cascade_delete, description) VALUES
    ('element', 'window_id', 'uuid', 1, NULL, 1, 'owned', 'window', 1, 'Parent window'),
    ('element', 'parent_id', 'uuid', 0, NULL, 1, NULL, NULL, 0, 'Parent element (null = window root)'),
    ('element', 'tag', 'text', 1, 'div', 0, NULL, NULL, 0, 'HTML tag name'),
    ('element', 'props', 'jsonb', 0, NULL, 0, NULL, NULL, 0, 'Element properties'),
    ('element', 'text', 'text', 0, NULL, 0, NULL, NULL, 0, 'Text content'),
    ('element', 'order', 'integer', 0, '0', 0, NULL, NULL, 0, 'Sibling order'),
    ('element', 'flex', 'text', 0, NULL, 0, NULL, NULL, 0, 'Flex shorthand'),
    ('element', 'width', 'text', 0, NULL, 0, NULL, NULL, 0, 'CSS width value'),
    ('element', 'height', 'text', 0, NULL, 0, NULL, NULL, 0, 'CSS height value'),
    ('element', 'disabled', 'boolean', 0, '0', 0, NULL, NULL, 0, 'Element is disabled'),
    ('element', 'hidden', 'boolean', 0, '0', 1, NULL, NULL, 0, 'Element is hidden'),
    ('element', 'value', 'text', 0, NULL, 0, NULL, NULL, 0, 'Current input value'),
    ('element', 'placeholder', 'text', 0, NULL, 0, NULL, NULL, 0, 'Placeholder text'),
    ('element', 'tabindex', 'integer', 0, NULL, 0, NULL, NULL, 0, 'Tab order'),
    ('element', 'autofocus', 'boolean', 0, '0', 0, NULL, NULL, 0, 'Auto-focus on mount');

-- =============================================================================
-- SEED DATA: EVENT MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, default_value, index_, description) VALUES
    ('event', 'display_id', 'uuid', 1, NULL, 1, 'Source display'),
    ('event', 'window_id', 'uuid', 0, NULL, 1, 'Target window'),
    ('event', 'element_id', 'uuid', 0, NULL, 1, 'Target element'),
    ('event', 'type', 'text', 1, NULL, 1, 'Event type'),
    ('event', 'data', 'jsonb', 0, NULL, 0, 'Event-specific data'),
    ('event', 'timestamp', 'integer', 1, NULL, 1, 'Event timestamp (Unix ms)'),
    ('event', 'target_tag', 'text', 0, NULL, 0, 'Target element tag name'),
    ('event', 'key', 'text', 0, NULL, 1, 'Key pressed'),
    ('event', 'button', 'integer', 0, NULL, 0, 'Mouse button'),
    ('event', 'x', 'integer', 0, NULL, 0, 'X coordinate'),
    ('event', 'y', 'integer', 0, NULL, 0, 'Y coordinate'),
    ('event', 'shift', 'boolean', 0, '0', 0, 'Shift key held'),
    ('event', 'ctrl', 'boolean', 0, '0', 0, 'Control key held'),
    ('event', 'alt', 'boolean', 0, '0', 0, 'Alt key held'),
    ('event', 'meta', 'boolean', 0, '0', 0, 'Meta/Command key held'),
    ('event', 'handled', 'boolean', 0, '0', 1, 'Event has been processed'),
    ('event', 'prevented', 'boolean', 0, '0', 0, 'Default action prevented');

-- =============================================================================
-- SEED DATA: CURSOR MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, default_value, unique_, relationship_type, related_model, cascade_delete, description) VALUES
    ('cursor', 'display_id', 'uuid', 1, NULL, 1, 'owned', 'display', 1, 'Parent display (one cursor per display)'),
    ('cursor', 'x', 'integer', 1, '0', 0, NULL, NULL, 0, 'X coordinate on screen'),
    ('cursor', 'y', 'integer', 1, '0', 0, NULL, NULL, 0, 'Y coordinate on screen'),
    ('cursor', 'style', 'text', 0, 'default', 0, NULL, NULL, 0, 'CSS cursor style'),
    ('cursor', 'visible', 'boolean', 0, '1', 0, NULL, NULL, 0, 'Cursor is visible'),
    ('cursor', 'window_id', 'uuid', 0, NULL, 0, NULL, NULL, 0, 'Window cursor is over'),
    ('cursor', 'element_id', 'uuid', 0, NULL, 0, NULL, NULL, 0, 'Element cursor is over');

-- =============================================================================
-- SEED DATA: SELECTION MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, default_value, index_, relationship_type, related_model, cascade_delete, description) VALUES
    ('selection', 'window_id', 'uuid', 1, NULL, 1, 'owned', 'window', 1, 'Window containing selection'),
    ('selection', 'element_id', 'uuid', 0, NULL, 1, NULL, NULL, 0, 'Element containing selection'),
    ('selection', 'text', 'text', 0, NULL, 0, NULL, NULL, 0, 'Selected text content'),
    ('selection', 'start_offset', 'integer', 0, NULL, 0, NULL, NULL, 0, 'Selection start offset'),
    ('selection', 'end_offset', 'integer', 0, NULL, 0, NULL, NULL, 0, 'Selection end offset'),
    ('selection', 'collapsed', 'boolean', 0, '1', 0, NULL, NULL, 0, 'Selection is collapsed'),
    ('selection', 'direction', 'text', 0, 'forward', 0, NULL, NULL, 0, 'Selection direction'),
    ('selection', 'start_element_id', 'uuid', 0, NULL, 0, NULL, NULL, 0, 'Element where selection starts'),
    ('selection', 'end_element_id', 'uuid', 0, NULL, 0, NULL, NULL, 0, 'Element where selection ends');
