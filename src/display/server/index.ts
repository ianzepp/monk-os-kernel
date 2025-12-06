/**
 * Display Server - Main Entry Point
 *
 * Creates an HTTP/WebSocket server for browser-based display connections.
 * The server:
 * - Serves static files from the client/ directory
 * - Accepts WebSocket connections at /ws
 * - Manages display sessions and entities via EMS
 *
 * USAGE
 * =====
 * ```typescript
 * import { createDisplayServer } from '@src/display/server/index.js';
 *
 * const server = await createDisplayServer(hal, ems, {
 *     port: 8080,
 *     host: '0.0.0.0',
 *     clientPath: '/path/to/client/dist',
 * });
 *
 * // Later...
 * await server.close();
 * ```
 *
 * @module display/server
 */

import type { HAL } from '@src/hal/index.js';
import type { EMS } from '@src/ems/ems.js';
import type { HttpServer } from '@src/hal/network.js';
import { createHttpHandler, createWebSocketHandler } from './handlers.js';
import type { SessionData } from './session.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Display server configuration.
 */
export interface DisplayServerConfig {
    /**
     * Port to listen on.
     * @default 8080
     */
    port?: number;

    /**
     * Host to bind to.
     * @default '0.0.0.0'
     */
    host?: string;

    /**
     * Path to client files directory.
     * @default Relative to this module
     */
    clientPath?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default port for the display server.
 */
const DEFAULT_PORT = 8080;

/**
 * Default host to bind to.
 */
const DEFAULT_HOST = '0.0.0.0';

/**
 * Default client path.
 * WHY: Client is a separate package in packages/display-client
 * Path: src/display/server/index.ts → ../../../ → repo root → packages/...
 */
const DEFAULT_CLIENT_PATH = new URL('../../../packages/display-client/dist', import.meta.url).pathname;

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a display server.
 *
 * Starts an HTTP server that:
 * - Serves static files from clientPath
 * - Upgrades WebSocket connections at /ws
 * - Manages display entities via EMS
 *
 * ALGORITHM:
 * 1. Create HTTP handler for static files and WebSocket upgrade
 * 2. Create WebSocket handlers for session management
 * 3. Call HAL network.serve() with handlers
 * 4. Return HttpServer handle
 *
 * @param hal - HAL instance for network and file access
 * @param ems - EMS instance for entity operations
 * @param config - Server configuration
 * @returns HTTP server handle with close() method
 */
export async function createDisplayServer(
    hal: HAL,
    ems: EMS,
    config: DisplayServerConfig = {},
): Promise<HttpServer> {
    const port = config.port ?? DEFAULT_PORT;
    const host = config.host ?? DEFAULT_HOST;
    const clientPath = config.clientPath ?? DEFAULT_CLIENT_PATH;

    // Create handlers
    const httpHandler = createHttpHandler(hal, clientPath);
    const wsHandler = createWebSocketHandler(ems);

    // Start server
    const server = await hal.network.serve<SessionData>(port, httpHandler, {
        hostname: host,
        websocket: wsHandler,
    });

    const addr = server.addr();

    console.log(`[display] Server listening on http://${addr.hostname}:${addr.port}`);
    console.log(`[display] WebSocket endpoint: ws://${addr.hostname}:${addr.port}/ws`);
    console.log(`[display] Serving client from: ${clientPath}`);

    return server;
}

// =============================================================================
// RE-EXPORTS
// =============================================================================

export type {
    SessionData,
    ClientMessage,
    ClientMessageOp,
    ServerMessage,
    ServerMessageOp,
    ConnectData,
    EventData,
} from './session.js';
