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
