/**
 * Display Client - Protocol Types
 *
 * Message types for browser ↔ server communication.
 * Must stay in sync with src/display/server/session.ts
 *
 * @module display-client/types
 */

// =============================================================================
// CLIENT → SERVER
// =============================================================================

export type ClientMessageOp = 'connect' | 'event' | 'ping' | 'disconnect';

export interface ClientMessage {
    op: ClientMessageOp;
    data?: unknown;
}

export interface ConnectData {
    width: number;
    height: number;
    dpi?: number;
    userAgent?: string;
}

export interface EventData {
    type: string;
    windowId?: string;
    elementId?: string;
    timestamp: number;
    x?: number;
    y?: number;
    button?: number;
    key?: string;
    shift?: boolean;
    ctrl?: boolean;
    alt?: boolean;
    meta?: boolean;
    data?: Record<string, unknown>;
}

// =============================================================================
// SERVER → CLIENT
// =============================================================================

export type ServerMessageOp = 'connected' | 'sync' | 'update' | 'delete' | 'error' | 'pong';

export interface ServerMessage {
    op: ServerMessageOp;
    data?: unknown;
}

export interface ConnectedData {
    displayId: string;
}

export interface ErrorData {
    message: string;
}

// =============================================================================
// ENTITY TYPES
// =============================================================================

/**
 * Window entity from server.
 * Represents a window on the display.
 */
export interface Window {
    id: string;
    display_id: string;
    owner_pid: string;
    title: string;
    x: number;
    y: number;
    width: number;
    height: number;
    min_width?: number;
    min_height?: number;
    max_width?: number;
    max_height?: number;
    z_index: number;
    focused: boolean;
    visible: boolean;
    minimized: boolean;
    maximized: boolean;
    resizable: boolean;
    movable: boolean;
    closable: boolean;
    background?: string;
    opacity?: number;
}

/**
 * Element entity from server.
 * Represents a UI element within a window.
 */
export interface Element {
    id: string;
    window_id: string;
    parent_id?: string;
    tag: string;
    props?: Record<string, unknown>;
    text?: string;
    order_: number;
    flex?: string;
    width?: string;
    height?: string;
    disabled: boolean;
    hidden: boolean;
    value?: string;
}

/**
 * Sync message data from server.
 */
export interface SyncData {
    windows: Window[];
    elements: Element[];
}

/**
 * Update message data from server.
 */
export interface UpdateData {
    model: 'window' | 'element';
    id: string;
    changes: Partial<Window> | Partial<Element>;
}

/**
 * Delete message data from server.
 */
export interface DeleteData {
    model: 'window' | 'element';
    id: string;
}
