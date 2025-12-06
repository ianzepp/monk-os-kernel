/**
 * Display Subsystem - Type Definitions
 *
 * TypeScript interfaces for display system entities.
 * These match the SQL schema in schema.sql.
 *
 * @module display/types
 */

// =============================================================================
// BASE TYPES
// =============================================================================

/**
 * Base entity fields (from EMS).
 */
interface EntityBase {
    id: string;
    created_at: string;
    updated_at: string;
    trashed_at: string | null;
    expired_at: string | null;
}

// =============================================================================
// DISPLAY
// =============================================================================

/**
 * Display - Browser session/connection.
 *
 * One display entity per connected browser tab. The display owns windows,
 * cursor, and receives events.
 */
export interface Display extends EntityBase {
    width: number;
    height: number;
    dpi: number;
    connected: boolean;
    session_id: string | null;
    user_agent: string | null;
    last_ping: string | null;
}

// =============================================================================
// WINDOW
// =============================================================================

/**
 * Window - Application window owned by a process.
 *
 * Windows belong to a display and contain elements. Each window has position,
 * size, focus state, and chrome controls (minimize, maximize, close).
 */
export interface Window extends EntityBase {
    display_id: string;
    title: string;
    x: number;
    y: number;
    width: number;
    height: number;
    min_width: number | null;
    min_height: number | null;
    max_width: number | null;
    max_height: number | null;
    z_index: number;
    focused: boolean;
    visible: boolean;
    minimized: boolean;
    maximized: boolean;
    resizable: boolean;
    movable: boolean;
    closable: boolean;
    owner_pid: string;
    background: string | null;
    opacity: number;
}

// =============================================================================
// ELEMENT
// =============================================================================

/**
 * Element - UI element within a window.
 *
 * Elements form a tree structure within a window. Each element has a tag,
 * properties (like React props), and optional text content.
 *
 * Uses passthrough mode for performance - high-frequency updates skip
 * most of the observer pipeline.
 */
export interface Element extends EntityBase {
    window_id: string;
    parent_id: string | null;
    tag: string;
    props: Record<string, unknown> | null;
    text: string | null;
    order: number;
    flex: string | null;
    width: string | null;
    height: string | null;
    disabled: boolean;
    hidden: boolean;
    value: string | null;
    placeholder: string | null;
    tabindex: number | null;
    autofocus: boolean;
}

// =============================================================================
// EVENT
// =============================================================================

/**
 * Event types - all supported browser events.
 */
export type EventType =
    // Mouse events
    | 'click'
    | 'dblclick'
    | 'mousedown'
    | 'mouseup'
    | 'mousemove'
    | 'mouseenter'
    | 'mouseleave'
    | 'contextmenu'
    | 'wheel'
    // Keyboard events
    | 'keydown'
    | 'keyup'
    | 'keypress'
    // Focus events
    | 'focus'
    | 'blur'
    | 'focusin'
    | 'focusout'
    // Form events
    | 'input'
    | 'change'
    | 'submit'
    // Touch events
    | 'touchstart'
    | 'touchend'
    | 'touchmove'
    | 'touchcancel'
    // Drag events
    | 'dragstart'
    | 'drag'
    | 'dragend'
    | 'dragenter'
    | 'dragleave'
    | 'dragover'
    | 'drop'
    // Window events
    | 'resize'
    | 'scroll'
    // Clipboard
    | 'copy'
    | 'cut'
    | 'paste'
    // Custom
    | 'custom';

/**
 * Event - Input event from browser.
 *
 * Events are created by the browser client and consumed by processes.
 * Uses passthrough mode for performance.
 */
export interface Event extends EntityBase {
    display_id: string;
    window_id: string | null;
    element_id: string | null;
    type: EventType;
    data: Record<string, unknown> | null;
    timestamp: number;
    target_tag: string | null;
    key: string | null;
    button: number | null;
    x: number | null;
    y: number | null;
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
    handled: boolean;
    prevented: boolean;
}

// =============================================================================
// CURSOR
// =============================================================================

/**
 * Cursor styles - CSS cursor values.
 */
export type CursorStyle =
    | 'default'
    | 'pointer'
    | 'text'
    | 'wait'
    | 'progress'
    | 'help'
    | 'crosshair'
    | 'move'
    | 'grab'
    | 'grabbing'
    | 'not-allowed'
    | 'no-drop'
    | 'col-resize'
    | 'row-resize'
    | 'n-resize'
    | 'e-resize'
    | 's-resize'
    | 'w-resize'
    | 'ne-resize'
    | 'nw-resize'
    | 'se-resize'
    | 'sw-resize'
    | 'ew-resize'
    | 'ns-resize'
    | 'nesw-resize'
    | 'nwse-resize'
    | 'zoom-in'
    | 'zoom-out'
    | 'none';

/**
 * Cursor - Mouse cursor state per display.
 *
 * One cursor per display. Tracks position, style, and hover target.
 * Uses passthrough mode for high-frequency position updates.
 */
export interface Cursor extends EntityBase {
    display_id: string;
    x: number;
    y: number;
    style: CursorStyle;
    visible: boolean;
    window_id: string | null;
    element_id: string | null;
}

// =============================================================================
// SELECTION
// =============================================================================

/**
 * Selection direction.
 */
export type SelectionDirection = 'forward' | 'backward' | 'none';

/**
 * Selection - Text selection state within a window.
 *
 * Tracks text selection for copy/paste and text editing operations.
 */
export interface Selection extends EntityBase {
    window_id: string;
    element_id: string | null;
    text: string | null;
    start_offset: number | null;
    end_offset: number | null;
    collapsed: boolean;
    direction: SelectionDirection;
    start_element_id: string | null;
    end_element_id: string | null;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Display subsystem configuration.
 */
export interface DisplayConfig {
    /** WebSocket port for browser connections (default: 8080) */
    port?: number;

    /** Host to bind to (default: '0.0.0.0') */
    host?: string;
}
