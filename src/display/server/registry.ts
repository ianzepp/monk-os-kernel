/**
 * Display Server - Connection Registry
 *
 * Manages mapping between displayId and WebSocket connections.
 * Enables routing messages from internal Unix socket to browser WebSockets.
 *
 * @module display/server/registry
 */

import type { ServerWebSocket } from '@src/hal/network.js';
import type { SessionData, ServerMessage } from './session.js';
import { sendMessage } from './session.js';

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * WebSocket connections indexed by displayId.
 *
 * WHY Map: O(1) lookup by displayId for message routing.
 * WHY WeakRef: Not used - we need strong references. Manual cleanup on close.
 */
const connections = new Map<string, ServerWebSocket<SessionData>>();

/**
 * Register a WebSocket connection for a display.
 *
 * @param displayId - The display entity ID
 * @param ws - The WebSocket connection
 */
export function registerConnection(displayId: string, ws: ServerWebSocket<SessionData>): void {
    connections.set(displayId, ws);
    console.log(`[display] Registered connection for display: ${displayId}`);
}

/**
 * Unregister a WebSocket connection.
 *
 * @param displayId - The display entity ID
 */
export function unregisterConnection(displayId: string): void {
    connections.delete(displayId);
    console.log(`[display] Unregistered connection for display: ${displayId}`);
}

/**
 * Get a WebSocket connection by displayId.
 *
 * @param displayId - The display entity ID
 * @returns The WebSocket connection or undefined
 */
export function getConnection(displayId: string): ServerWebSocket<SessionData> | undefined {
    return connections.get(displayId);
}

/**
 * Send a message to a specific display.
 *
 * @param displayId - Target display entity ID
 * @param message - Message to send
 * @returns true if sent, false if display not connected
 */
export function sendToDisplay(displayId: string, message: ServerMessage): boolean {
    const ws = connections.get(displayId);

    if (!ws) {
        console.warn(`[display] No connection for display: ${displayId}`);
        return false;
    }

    sendMessage(ws, message);
    return true;
}

/**
 * Broadcast a message to all connected displays.
 *
 * @param message - Message to broadcast
 * @returns Number of displays sent to
 */
export function broadcast(message: ServerMessage): number {
    let count = 0;

    for (const ws of connections.values()) {
        sendMessage(ws, message);
        count++;
    }

    return count;
}

/**
 * Get count of connected displays.
 */
export function connectionCount(): number {
    return connections.size;
}
