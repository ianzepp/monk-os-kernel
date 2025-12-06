/**
 * Display Server - IPC Socket Handler
 *
 * Unix socket listener for internal OS communication.
 * Receives messages from EMS observers and routes them to browser WebSockets.
 *
 * MESSAGE FORMAT
 * ==============
 * Messages are newline-delimited JSON using standard OS Message format:
 *
 * { op: 'display:update', data: { displayId, model, id, changes } }
 * { op: 'display:delete', data: { displayId, model, id } }
 * { op: 'display:sync', data: { displayId, windows, elements } }
 *
 * SOCKET PATH
 * ===========
 * /run/monk/display.sock
 *
 * @module display/server/ipc
 */

import { sendToDisplay, broadcast } from './registry.js';
import type { Message } from '@src/message.js';
import type { ServerMessage } from './session.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Unix socket path for IPC.
 */
export const SOCKET_PATH = '/run/monk/display.sock';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Display update message data.
 */
interface DisplayUpdateData {
    displayId: string;
    model: string;
    id: string;
    changes: Record<string, unknown>;
}

/**
 * Display delete message data.
 */
interface DisplayDeleteData {
    displayId: string;
    model: string;
    id: string;
}

/**
 * Display sync message data.
 */
interface DisplaySyncData {
    displayId: string;
    windows: unknown[];
    elements: unknown[];
}

// =============================================================================
// IPC SERVER
// =============================================================================

/**
 * Unix socket server handle.
 */
let server: ReturnType<typeof Bun.listen> | null = null;

/**
 * Start the IPC Unix socket server.
 *
 * Listens for JSON-line messages and routes them to WebSocket connections.
 *
 * @returns Promise that resolves when server is listening
 */
export async function startIpcServer(): Promise<void> {
    // Ensure /run/monk directory exists
    const dir = SOCKET_PATH.substring(0, SOCKET_PATH.lastIndexOf('/'));

    try {
        await Bun.write(Bun.file(`${dir}/.keep`), '');
    }
    catch {
        // Directory creation may fail if it exists, that's ok
    }

    // Remove stale socket file if it exists
    try {
        await Bun.file(SOCKET_PATH).exists() && await Bun.write(SOCKET_PATH, '');
        const file = Bun.file(SOCKET_PATH);

        if (await file.exists()) {
            // Can't delete directly, but starting server will replace it
        }
    }
    catch {
        // Ignore
    }

    server = Bun.listen({
        unix: SOCKET_PATH,

        socket: {
            open(socket) {
                console.log('[display] IPC client connected');
            },

            data(socket, data) {
                handleIpcData(data);
            },

            close(socket) {
                console.log('[display] IPC client disconnected');
            },

            error(socket, error) {
                console.error('[display] IPC socket error:', error);
            },
        },
    });

    console.log(`[display] IPC server listening on ${SOCKET_PATH}`);
}

/**
 * Stop the IPC server.
 */
export async function stopIpcServer(): Promise<void> {
    if (server) {
        server.stop();
        server = null;
        console.log('[display] IPC server stopped');
    }
}

// =============================================================================
// MESSAGE HANDLING
// =============================================================================

/**
 * Handle incoming IPC data.
 *
 * Messages are newline-delimited JSON. We buffer partial messages
 * and process complete lines.
 */
let buffer = '';

function handleIpcData(data: Buffer | Uint8Array): void {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    buffer += text;

    // Process complete lines
    let newlineIndex: number;

    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);

        if (line.trim()) {
            processMessage(line);
        }
    }
}

/**
 * Process a single JSON message.
 */
function processMessage(json: string): void {
    let msg: Message;

    try {
        msg = JSON.parse(json);
    }
    catch (err) {
        console.error('[display] Invalid IPC message:', json);
        return;
    }

    if (!msg.op || typeof msg.op !== 'string') {
        console.error('[display] IPC message missing op:', json);
        return;
    }

    switch (msg.op) {
        case 'display:update':
            handleUpdate(msg.data as DisplayUpdateData);
            break;

        case 'display:delete':
            handleDelete(msg.data as DisplayDeleteData);
            break;

        case 'display:sync':
            handleSync(msg.data as DisplaySyncData);
            break;

        default:
            console.warn(`[display] Unknown IPC op: ${msg.op}`);
    }
}

/**
 * Handle display:update message.
 *
 * Routes to specific display or broadcasts if displayId is '*'.
 */
function handleUpdate(data: DisplayUpdateData): void {
    if (!data.displayId || !data.model || !data.id) {
        console.error('[display] Invalid update data:', data);
        return;
    }

    const message: ServerMessage = {
        op: 'update',
        data: {
            model: data.model,
            id: data.id,
            changes: data.changes,
        },
    };

    if (data.displayId === '*') {
        broadcast(message);
    }
    else {
        sendToDisplay(data.displayId, message);
    }
}

/**
 * Handle display:delete message.
 */
function handleDelete(data: DisplayDeleteData): void {
    if (!data.displayId || !data.model || !data.id) {
        console.error('[display] Invalid delete data:', data);
        return;
    }

    const message: ServerMessage = {
        op: 'delete',
        data: {
            model: data.model,
            id: data.id,
        },
    };

    if (data.displayId === '*') {
        broadcast(message);
    }
    else {
        sendToDisplay(data.displayId, message);
    }
}

/**
 * Handle display:sync message.
 */
function handleSync(data: DisplaySyncData): void {
    if (!data.displayId) {
        console.error('[display] Invalid sync data:', data);
        return;
    }

    const message: ServerMessage = {
        op: 'sync',
        data: {
            windows: data.windows,
            elements: data.elements,
        },
    };

    if (data.displayId === '*') {
        broadcast(message);
    }
    else {
        sendToDisplay(data.displayId, message);
    }
}
