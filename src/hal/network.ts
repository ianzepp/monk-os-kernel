/**
 * Network Device - TCP/UDP sockets and HTTP servers
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module provides the network HAL (Hardware Abstraction Layer) for Monk OS.
 * It abstracts Bun's networking APIs to provide a consistent interface for:
 *
 * - TCP client connections (Bun.connect)
 * - TCP/UDP server listeners (Bun.listen)
 * - HTTP servers (Bun.serve)
 * - TLS/SSL support (via key/cert configuration)
 *
 * This is a barrel file that re-exports types and implementations from the
 * network/ subdirectory. The actual implementation logic lives in:
 * - network/types.ts - Interface definitions
 * - network/device.ts - Main network device implementation
 * - network/listener.ts - Server socket listener
 * - network/socket.ts - Client/server socket implementation
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All exports are re-exports from network/ subdirectory
 * INV-2: No implementation logic in this file
 * INV-3: Type exports must precede implementation exports for clarity
 *
 * BUN TOUCHPOINTS
 * ===============
 * - Bun.listen() - TCP/UDP server creation
 * - Bun.connect() - TCP client connections
 * - Bun.serve() - HTTP server creation
 * - TLS configuration via key/cert paths or strings
 *
 * CAVEATS
 * =======
 * - Bun.listen() is event-driven, not read()-based. The HAL wraps it to provide
 *   a read() interface via buffering.
 * - UDP is supported via Bun.listen({ type: 'udp' }) but not exposed yet.
 * - TLS requires key/cert paths or strings, not CryptoKey objects.
 * - Unix domain sockets supported via unix:// URLs.
 *
 * @module hal/network
 */

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type {
    TlsOpts,
    ListenOpts,
    ConnectOpts,
    SocketStat,
    SocketReadOpts,
    Socket,
    ListenerAcceptOpts,
    Listener,
    ServerWebSocket,
    WebSocketHandler,
    UpgradeServer,
    HttpHandler,
    ServeOpts,
    HttpServer,
    NetworkDevice,
    WebSocketServerOpts,
    WebSocketConnection,
    WebSocketServer,
} from './network/types.js';

// =============================================================================
// IMPLEMENTATION EXPORTS
// =============================================================================

export { BunNetworkDevice } from './network/device.js';
export { BunListener } from './network/listener.js';
export { BunSocket } from './network/socket.js';
export { BunWebSocketServer, BunWebSocketConnection } from './network/websocket-server.js';
