/**
 * Display Server - Session Management
 *
 * Manages browser sessions connected via WebSocket. Each session corresponds
 * to one display entity in EMS.
 *
 * SESSION LIFECYCLE
 * =================
 * 1. Browser connects via WebSocket
 * 2. Session created with unique ID
 * 3. Display entity created in EMS
 * 4. Session tracks: displayId, lastPing, connection state
 * 5. Browser disconnects → display entity deleted
 *
 * @module display/server/session
 */

import type { ServerWebSocket } from '@src/hal/network.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Data attached to each WebSocket connection.
 *
 * WHY: Bun's ServerWebSocket supports a generic `data` property that persists
 * for the lifetime of the connection. We use it to track session state.
 */
export interface SessionData {
    /**
     * Unique session identifier (generated on connect).
     */
    sessionId: string;

    /**
     * EMS display entity ID (created on connect message).
     * Null until browser sends connect message with display dimensions.
     */
    displayId: string | null;

    /**
     * Timestamp of last ping from browser.
     * Used for dead connection detection.
     */
    lastPing: number;

    /**
     * Remote address for logging.
     */
    remoteAddress: string;
}

/**
 * Browser → Server message types.
 */
export type ClientMessageOp = 'connect' | 'event' | 'ping' | 'disconnect';

/**
 * Browser → Server message format.
 */
export interface ClientMessage {
    op: ClientMessageOp;
    data?: unknown;
}

/**
 * Connect message data from browser.
 */
export interface ConnectData {
    width: number;
    height: number;
    dpi?: number;
    userAgent?: string;
}

/**
 * Event message data from browser.
 */
export interface EventData {
    type: string;
    windowId?: string;
    elementId?: string;
    timestamp: number;
    // Mouse data
    x?: number;
    y?: number;
    button?: number;
    // Keyboard data
    key?: string;
    // Modifier keys
    shift?: boolean;
    ctrl?: boolean;
    alt?: boolean;
    meta?: boolean;
    // Extra data
    data?: Record<string, unknown>;
}

/**
 * Server → Browser message types.
 */
export type ServerMessageOp = 'connected' | 'sync' | 'update' | 'delete' | 'error' | 'pong';

/**
 * Server → Browser message format.
 */
export interface ServerMessage {
    op: ServerMessageOp;
    data?: unknown;
}

// =============================================================================
// SESSION HELPERS
// =============================================================================

/**
 * Generate a unique session ID.
 *
 * WHY: Uses crypto.randomUUID() for uniqueness. Prefixed with 'sess_' for
 * easy identification in logs.
 */
export function generateSessionId(): string {
    return `sess_${crypto.randomUUID()}`;
}

/**
 * Create initial session data for a new WebSocket connection.
 *
 * @param remoteAddress - Client's IP address
 */
export function createSessionData(remoteAddress: string): SessionData {
    return {
        sessionId: generateSessionId(),
        displayId: null,
        lastPing: Date.now(),
        remoteAddress,
    };
}

/**
 * Send a message to a WebSocket client.
 *
 * @param ws - WebSocket connection
 * @param message - Message to send
 */
export function sendMessage(ws: ServerWebSocket<SessionData>, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
}

/**
 * Parse a client message.
 *
 * @param raw - Raw message data (string or binary)
 * @returns Parsed message or null if invalid
 */
export function parseClientMessage(raw: string | Uint8Array): ClientMessage | null {
    try {
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        const parsed = JSON.parse(text);

        // Validate required fields
        if (typeof parsed !== 'object' || parsed === null) {
            return null;
        }

        if (typeof parsed.op !== 'string') {
            return null;
        }

        return parsed as ClientMessage;
    }
    catch {
        return null;
    }
}
