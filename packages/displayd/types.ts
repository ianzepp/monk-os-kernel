/**
 * displayd - Type definitions
 *
 * TypeScript interfaces for display system entities.
 * These match the YAML model definitions in models/*.yaml
 *
 * @module @monk-api/displayd/types
 */

/**
 * Base entity fields (from EMS)
 */
interface EntityBase {
    id: string;
    created_at: string;
    updated_at: string;
    trashed_at: string | null;
    expired_at: string | null;
}

/**
 * Display - Browser session/connection
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

/**
 * Window - Application window
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

/**
 * Element - UI element within a window
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

/**
 * Event types
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
 * Event - Input event from browser
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

/**
 * Cursor styles
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
 * Cursor - Mouse cursor state
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

/**
 * Selection direction
 */
export type SelectionDirection = 'forward' | 'backward' | 'none';

/**
 * Selection - Text selection state
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
