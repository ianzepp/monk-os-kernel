/**
 * Display Server - HTTP and WebSocket Handlers
 *
 * Factory functions that create handlers for the display server. Handlers
 * close over EMS and HAL dependencies to access entity operations and file
 * serving.
 *
 * HTTP ROUTING
 * ============
 * - GET /ws → WebSocket upgrade
 * - GET /* → Static file serving from client/ directory
 *
 * WEBSOCKET PROTOCOL
 * ==================
 * Browser → Server:
 * - { op: 'connect', data: { width, height, dpi, userAgent } }
 * - { op: 'event', data: { type, windowId, elementId, ... } }
 * - { op: 'ping' }
 * - { op: 'disconnect' }
 *
 * Server → Browser:
 * - { op: 'connected', data: { displayId } }
 * - { op: 'sync', data: { windows: [...], elements: [...] } }
 * - { op: 'update', data: { model, id, changes } }
 * - { op: 'delete', data: { model, id } }
 * - { op: 'error', data: { message } }
 * - { op: 'pong' }
 *
 * @module display/server/handlers
 */

import type { HAL } from '@src/hal/index.js';
import type { EMS } from '@src/ems/ems.js';
import type { HttpHandler, WebSocketHandler, UpgradeServer, ServerWebSocket } from '@src/hal/network.js';
import { collect } from '@src/ems/entity-ops.js';
import {
    type SessionData,
    type ConnectData,
    type EventData,
    createSessionData,
    parseClientMessage,
    sendMessage,
} from './session.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * WebSocket upgrade path.
 */
const WS_PATH = '/ws';

/**
 * Content types for static file serving.
 */
const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
};

// =============================================================================
// HTTP HANDLER
// =============================================================================

/**
 * Create the HTTP request handler.
 *
 * Handles:
 * - WebSocket upgrades at /ws
 * - Static file serving from clientPath
 *
 * @param hal - HAL instance for file reading
 * @param clientPath - Path to client files directory
 */
export function createHttpHandler(
    hal: HAL,
    clientPath: string,
): HttpHandler<SessionData> {
    // WHY: Return type explicitly matches HttpHandler union
    // TypeScript struggles with async functions returning Response | undefined
    const handler = async (
        req: Request,
        server?: UpgradeServer<SessionData>,
    ): Promise<Response | undefined> => {
        const url = new URL(req.url);

        // -------------------------------------------------------------------------
        // WebSocket upgrade
        // -------------------------------------------------------------------------

        if (url.pathname === WS_PATH) {
            if (!server) {
                return new Response('WebSocket not configured', { status: 500 });
            }

            // Get remote address from request headers (X-Forwarded-For) or connection
            const remoteAddress = req.headers.get('x-forwarded-for')
                ?? req.headers.get('x-real-ip')
                ?? 'unknown';

            const sessionData = createSessionData(remoteAddress);
            const upgraded = server.upgrade(req, sessionData);

            if (!upgraded) {
                return new Response('WebSocket upgrade failed', { status: 400 });
            }

            // Return undefined to indicate upgrade handled
            return undefined;
        }

        // -------------------------------------------------------------------------
        // Static file serving
        // -------------------------------------------------------------------------

        // Map URL path to file path
        let filePath = url.pathname;

        // Default to index.html for root
        if (filePath === '/') {
            filePath = '/index.html';
        }

        // Security: prevent path traversal
        if (filePath.includes('..')) {
            return new Response('Forbidden', { status: 403 });
        }

        // Build full file path
        const fullPath = `${clientPath}${filePath}`;

        // Try to read the file
        try {
            const content = await hal.file.read(fullPath);

            // Determine content type from extension
            const ext = filePath.substring(filePath.lastIndexOf('.'));
            const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

            // WHY: Cast to ArrayBuffer for TypeScript compatibility
            // TS doesn't recognize that Uint8Array.buffer.slice always returns ArrayBuffer (not SharedArrayBuffer)
            const body = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;

            return new Response(body, {
                headers: {
                    'Content-Type': contentType,
                    'Cache-Control': 'no-cache',
                },
            });
        }
        catch {
            // File not found - try index.html for SPA routing
            if (!filePath.includes('.')) {
                try {
                    const content = await hal.file.read(`${clientPath}/index.html`);

                    const body = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;

                    return new Response(body, {
                        headers: {
                            'Content-Type': 'text/html; charset=utf-8',
                            'Cache-Control': 'no-cache',
                        },
                    });
                }
                catch {
                    // Fall through to 404
                }
            }

            return new Response('Not Found', { status: 404 });
        }
    };

    // WHY: Cast needed because TypeScript doesn't unify Promise<A|B> with Promise<A>|Promise<B>
    return handler as HttpHandler<SessionData>;
}

// =============================================================================
// WEBSOCKET HANDLERS
// =============================================================================

/**
 * Create WebSocket event handlers.
 *
 * Manages session lifecycle and message routing:
 * - open: Log connection
 * - message: Parse and dispatch to appropriate handler
 * - close: Clean up display entity
 *
 * @param ems - EMS instance for entity operations
 */
export function createWebSocketHandler(ems: EMS): WebSocketHandler<SessionData> {
    return {
        /**
         * New WebSocket connection established.
         *
         * At this point we just log the connection. The display entity is
         * created when the browser sends the 'connect' message with dimensions.
         */
        open(ws) {
            const { sessionId, remoteAddress } = ws.data;

            console.log(`[display] WebSocket connected: ${sessionId} from ${remoteAddress}`);
        },

        /**
         * Message received from browser.
         */
        async message(ws, raw) {
            const msg = parseClientMessage(raw);

            if (!msg) {
                sendMessage(ws, { op: 'error', data: { message: 'Invalid message format' } });
                return;
            }

            const { sessionId } = ws.data;

            switch (msg.op) {
                case 'connect':
                    await handleConnect(ws, msg.data as ConnectData, ems);
                    break;

                case 'event':
                    await handleEvent(ws, msg.data as EventData, ems);
                    break;

                case 'ping':
                    ws.data.lastPing = Date.now();
                    sendMessage(ws, { op: 'pong' });
                    break;

                case 'disconnect':
                    console.log(`[display] Client requested disconnect: ${sessionId}`);
                    ws.close(1000, 'Client disconnect');
                    break;

                default:
                    sendMessage(ws, { op: 'error', data: { message: `Unknown op: ${msg.op}` } });
            }
        },

        /**
         * WebSocket connection closed.
         *
         * Clean up the display entity if one was created.
         */
        async close(ws, code, reason) {
            const { sessionId, displayId } = ws.data;

            console.log(`[display] WebSocket closed: ${sessionId} (code=${code}, reason=${reason})`);

            // Delete display entity if it exists
            if (displayId) {
                try {
                    // WHY: deleteIds is a generator, must consume to execute
                    await collect(ems.ops.deleteIds('display', [displayId]));
                    console.log(`[display] Deleted display entity: ${displayId}`);
                }
                catch (err) {
                    console.error(`[display] Failed to delete display ${displayId}:`, err);
                }
            }
        },
    };
}

// =============================================================================
// MESSAGE HANDLERS
// =============================================================================

/**
 * Handle 'connect' message from browser.
 *
 * Creates the display entity in EMS and sends 'connected' response.
 */
async function handleConnect(
    ws: { data: SessionData; send(data: string): void },
    data: ConnectData,
    ems: EMS,
): Promise<void> {
    const { sessionId } = ws.data;

    // Validate required fields
    if (!data || typeof data.width !== 'number' || typeof data.height !== 'number') {
        sendMessage(ws as any, {
            op: 'error',
            data: { message: 'Connect message requires width and height' },
        });
        return;
    }

    // Create display entity
    try {
        // WHY: createAll is a generator, collect to get created records
        const results = await collect(ems.ops.createAll('display', [{
            width: data.width,
            height: data.height,
            dpi: data.dpi ?? 1,
            connected: true,
            session_id: sessionId,
            user_agent: data.userAgent ?? null,
            last_ping: new Date().toISOString(),
        }]));

        const display = results[0];

        if (!display) {
            throw new Error('No display created');
        }

        // Store display ID in session
        ws.data.displayId = display.id;

        console.log(`[display] Created display: ${display.id} (${data.width}x${data.height})`);

        // Send connected response
        sendMessage(ws as any, {
            op: 'connected',
            data: { displayId: display.id },
        });

        // TODO: Send initial sync with existing windows/elements for this display
        // This would be relevant if windows persist across reconnects
    }
    catch (err) {
        console.error(`[display] Failed to create display:`, err);
        sendMessage(ws as any, {
            op: 'error',
            data: { message: 'Failed to create display' },
        });
    }
}

/**
 * Handle 'event' message from browser.
 *
 * Creates an event entity in EMS for the owning process to consume.
 */
async function handleEvent(
    ws: { data: SessionData },
    data: EventData,
    ems: EMS,
): Promise<void> {
    const { displayId } = ws.data;

    if (!displayId) {
        console.warn('[display] Event received before connect');
        return;
    }

    // Validate required fields
    if (!data || typeof data.type !== 'string') {
        console.warn('[display] Event missing type');
        return;
    }

    // Create event entity
    try {
        // WHY: createAll is a generator, collect to execute
        await collect(ems.ops.createAll('event', [{
            display_id: displayId,
            window_id: data.windowId ?? null,
            element_id: data.elementId ?? null,
            type: data.type,
            timestamp: data.timestamp ?? Date.now(),
            x: data.x ?? null,
            y: data.y ?? null,
            button: data.button ?? null,
            key: data.key ?? null,
            shift: data.shift ?? false,
            ctrl: data.ctrl ?? false,
            alt: data.alt ?? false,
            meta: data.meta ?? false,
            data: data.data ?? null,
            handled: false,
            prevented: false,
        }]));
    }
    catch (err) {
        console.error(`[display] Failed to create event:`, err);
    }
}
