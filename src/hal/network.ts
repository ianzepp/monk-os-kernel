/**
 * Network Device
 *
 * TCP/UDP sockets and HTTP server.
 * Processes access the network through this interface.
 *
 * Bun touchpoints:
 * - Bun.listen() for TCP/UDP servers
 * - Bun.connect() for TCP clients
 * - Bun.serve() for HTTP servers
 *
 * Caveats:
 * - Bun.listen() socket API is event-driven, not read()-based
 *   This HAL wraps it to provide a read() interface via buffering
 * - UDP is supported via Bun.listen with type: 'udp' but not exposed here yet
 * - TLS requires key/cert paths or strings, not CryptoKey objects
 */

// Re-export types
export type {
    TlsOpts,
    ListenOpts,
    ConnectOpts,
    SocketStat,
    SocketReadOpts,
    Socket,
    ListenerAcceptOpts,
    Listener,
    HttpHandler,
    HttpServer,
    NetworkDevice,
} from './network/types.js';

// Re-export implementations
export { BunNetworkDevice } from './network/device.js';
export { BunListener } from './network/listener.js';
export { BunSocket } from './network/socket.js';
