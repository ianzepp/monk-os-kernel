/**
 * Network Device - Bun network implementation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module implements the NetworkDevice interface using Bun's networking APIs.
 * It provides three primary network primitives:
 *
 * 1. TCP Listeners - Server-side connection acceptance via Bun.listen()
 * 2. TCP Connections - Client-side outbound connections via Bun.connect()
 * 3. HTTP Servers - High-level HTTP serving via Bun.serve()
 *
 * The implementation bridges Bun's event-driven socket API with Monk OS's promise-based
 * read()/write() interface. Bun sockets emit 'data' events asynchronously, but our
 * Socket interface provides a synchronous-looking read() method. We achieve this by
 * buffering incoming data in a queue and returning Promises that resolve when data
 * becomes available.
 *
 * This design enables:
 * - Synchronous-looking code (await socket.read()) over async events
 * - Natural backpressure (read() blocks until data arrives)
 * - Timeout support (reject if no data within timeout)
 * - Clean shutdown (resolve with empty buffer on close)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: BunListener and BunSocket are always created with valid Bun primitives
 * INV-2: connect() with port=0 indicates Unix domain socket, port>0 indicates TCP
 * INV-3: All methods return fully initialized, ready-to-use handles
 * INV-4: Timeout rejection happens before any socket reference is established
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * connection attempts may be in progress simultaneously. Bun's event loop manages
 * the underlying socket I/O.
 *
 * Key concurrency points:
 * - Multiple calls to listen() create independent listeners on different ports
 * - Multiple calls to connect() create independent client connections
 * - Each socket has its own data queue and event handlers (no shared state)
 * - Bun.serve() creates a single HTTP server per port
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Connection timeout checked after async operations complete
 * RC-2: Socket reference captured before resolving Promise (prevents use-after-close)
 * RC-3: Each socket gets isolated event handlers (no handler confusion)
 * RC-4: Closed flag checked before data operations
 *
 * MEMORY MANAGEMENT
 * =================
 * - BunListener manages Bun.listen() server lifecycle
 * - BunSocket manages individual connection lifecycle
 * - HttpServer wraps Bun.serve() and manages shutdown
 * - All resources released via close() methods
 * - AsyncDisposable pattern supported for automatic cleanup
 *
 * TESTABILITY
 * ===========
 * - Each primitive (listen, connect, serve) returns interface types
 * - Mock implementations can be injected for testing
 * - Timeout behavior is deterministic and testable
 * - Error paths are explicit and testable
 *
 * @module hal/network/device
 */

import { ETIMEDOUT } from '../errors.js';
import type {
    ConnectOpts,
    HttpHandler,
    HttpServer,
    Listener,
    ListenOpts,
    NetworkDevice,
    ServeOpts,
    Socket,
    UpgradeServer,
    WebSocketServer,
    WebSocketServerOpts,
} from './types.js';
import { BunSocket } from './socket.js';
import { BunListener } from './listener.js';
import { BunWebSocketServer } from './websocket-server.js';
import { debug } from '../../debug.js';

const log = debug('hal:network');

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Bun network device implementation.
 *
 * Provides factory methods for creating network primitives. Each method returns
 * a fully initialized handle ready for I/O operations.
 *
 * WHY: Centralized factory simplifies dependency injection and testing. The kernel
 * can instantiate this once and pass it to components that need network access.
 */
export class BunNetworkDevice implements NetworkDevice {
    // =========================================================================
    // TCP SERVER
    // =========================================================================

    /**
     * Create a TCP listener on the specified port.
     *
     * ALGORITHM:
     * 1. Delegate to BunListener constructor
     * 2. BunListener internally calls Bun.listen()
     * 3. Return initialized listener ready to accept connections
     *
     * WHY: Delegation to BunListener isolates listener logic and enables
     * independent testing of connection acceptance behavior.
     *
     * @param port - Port number to listen on
     * @param opts - Optional listen configuration (hostname, TLS, backlog)
     * @returns Promise resolving to ready-to-use listener
     */
    async listen(port: number, opts?: ListenOpts): Promise<Listener> {
        log('listen port=%d hostname=%s', port, opts?.hostname ?? '0.0.0.0');

        return new BunListener(port, opts);
    }

    // =========================================================================
    // TCP CLIENT
    // =========================================================================

    /**
     * Connect to a TCP server or Unix domain socket.
     *
     * ALGORITHM:
     * 1. Create Promise for async connection result
     * 2. Set up data queue and event handlers
     * 3. Initiate Bun.connect() with handlers
     * 4. On 'open': Resolve with BunSocket wrapping connection
     * 5. On 'error': Reject with error
     * 6. If timeout specified: Reject if connection not established in time
     *
     * RACE CONDITION:
     * Connection timeout may fire before or after connection succeeds. We check
     * if socketRef is set before rejecting - if connection already succeeded,
     * timeout is a no-op.
     *
     * WHY port=0 convention:
     * Port 0 is not a valid TCP port, so we repurpose it to indicate Unix socket.
     * This avoids needing separate connect() and connectUnix() methods.
     *
     * MEMORY MANAGEMENT:
     * Data queue and handlers are scoped to this Promise. Once resolved/rejected,
     * they become part of the BunSocket which manages them through its lifecycle.
     *
     * @param host - Hostname/IP for TCP, or socket path for Unix (port=0)
     * @param port - Port number for TCP, or 0 for Unix sockets
     * @param opts - Optional connection options (timeout, TLS)
     * @returns Promise resolving to connected socket
     * @throws ETIMEDOUT - If connection not established within opts.timeout
     * @throws Error - On connection failure
     */
    async connect(host: string, port: number, opts?: ConnectOpts): Promise<Socket> {
        log('connect host=%s port=%d', host, port);

        return new Promise((resolve, reject) => {
            /**
             * Data queue for incoming bytes.
             * WHY: Bun emits data events asynchronously. We buffer them here so
             * read() can return them synchronously when called.
             */
            const dataQueue: Uint8Array[] = [];

            /**
             * Pending read promise resolver.
             * WHY: When read() is called with no buffered data, we store the
             * resolver here. Next 'data' event will call it.
             */
            let dataResolve: ((data: Uint8Array) => void) | null = null;

            /**
             * Socket closed flag.
             * WHY: Prevents write() operations after close. Also signals read()
             * to return EOF (empty buffer).
             */
            let closed = false;

            /**
             * Reference to underlying Bun socket.
             * WHY: Needed to check if connection succeeded before timeout fires.
             */
            let socketRef: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never;

            /**
             * Socket event handlers.
             * WHY: Bun.connect() requires these callbacks. Each handler manages
             * a different aspect of connection lifecycle.
             */
            const socketHandlers = {
                /**
                 * Connection established.
                 * RACE FIX: Set socketRef first, then resolve Promise. This ensures
                 * timeout handler can detect successful connection.
                 */
                open(socket: any) {
                    log('connected to %s:%d', host, port);
                    socketRef = socket;
                    resolve(new BunSocket(socket, dataQueue, () => dataResolve, r => {
                        dataResolve = r;
                    }, () => closed, c => {
                        closed = c;
                    }));
                },

                /**
                 * Data received from peer.
                 * WHY: Buffer data for read() consumption. If read() is blocked
                 * waiting, wake it up immediately.
                 */
                data(_socket: any, data: any) {
                    const bytes = new Uint8Array(data);

                    if (dataResolve) {
                        // Pending read() call - wake it up
                        dataResolve(bytes);
                        dataResolve = null;
                    }
                    else {
                        // No pending read - buffer it
                        dataQueue.push(bytes);
                    }
                },

                /**
                 * Connection closed by peer.
                 * WHY: Signal EOF to any pending read(). Future read() calls
                 * will return empty buffer immediately.
                 */
                close() {
                    closed = true;
                    if (dataResolve) {
                        // Pending read() - wake with EOF
                        dataResolve(new Uint8Array(0));
                        dataResolve = null;
                    }
                },

                /**
                 * Socket error after connection established.
                 * WHY: Close socket and wake any pending read() with EOF.
                 */
                error(_socket: any, error: Error) {
                    closed = true;
                    reject(error);
                },

                /**
                 * Connection failed (before 'open').
                 * WHY: Reject connect() Promise immediately.
                 */
                connectError(_socket: any, error: Error) {
                    log('connect failed %s:%d - %s', host, port, error.message);
                    reject(error);
                },
            };

            // -------------------------------------------------------------------------
            // Initiate connection
            // -------------------------------------------------------------------------

            /**
             * Unix socket if port is 0, TCP otherwise.
             * WHY: Port 0 is invalid for TCP, so we repurpose it as a Unix socket
             * indicator. This keeps the API simple (one connect() method instead of two).
             */
            if (port === 0) {
                Bun.connect({
                    unix: host,
                    socket: socketHandlers,
                });
            }
            else {
                Bun.connect({
                    hostname: host,
                    port,
                    tls: opts?.tls,
                    socket: socketHandlers,
                });
            }

            // -------------------------------------------------------------------------
            // Set timeout if requested
            // -------------------------------------------------------------------------

            /**
             * Reject connection if timeout exceeded.
             * RACE FIX: Check if socketRef is set before rejecting. If connection
             * already succeeded, timeout is a no-op.
             *
             * WHY: Prevents connections from hanging indefinitely. Especially important
             * for connections to unreachable hosts or firewalled ports.
             */
            if (opts?.timeout) {
                setTimeout(() => {
                    if (!socketRef) {
                        reject(new ETIMEDOUT('Connection timeout'));
                    }
                }, opts.timeout);
            }
        });
    }

    // =========================================================================
    // HTTP SERVER
    // =========================================================================

    /**
     * Create an HTTP server with optional WebSocket support.
     *
     * ALGORITHM:
     * 1. Call Bun.serve() with port, handler, and optional websocket config
     * 2. Wrap in HttpServer interface with close() method
     * 3. Return immediately (server is listening)
     *
     * WHY: Bun.serve() returns immediately with a started server. We wrap it
     * to provide a consistent interface with close() and addr() methods.
     *
     * WEBSOCKET SUPPORT:
     * When opts.websocket is provided, the HTTP handler receives an UpgradeServer
     * that can upgrade connections to WebSocket. Bun handles the protocol upgrade
     * internally - we just pass through the configuration.
     *
     * MEMORY MANAGEMENT:
     * Server maintains internal state until stop() is called. close() delegates
     * to server.stop() to release resources.
     *
     * @param port - Port number to listen on
     * @param handler - Request handler function
     * @param opts - Optional server options (hostname, websocket handlers)
     * @returns Promise resolving to HTTP server handle
     */
    async serve<T = unknown>(
        port: number,
        handler: HttpHandler<T>,
        opts?: ServeOpts<T>,
    ): Promise<HttpServer> {
        log('serve http port=%d hostname=%s ws=%s', port, opts?.hostname ?? '0.0.0.0', !!opts?.websocket);
        // Build Bun.serve() config
        // WHY type assertion: Bun's types are complex, our abstraction is simpler
        const config: Parameters<typeof Bun.serve>[0] = {
            port,
            hostname: opts?.hostname,

            // Wrap handler to pass server for WebSocket upgrades
            // WHY: Our HttpHandler expects UpgradeServer, Bun provides Server
            fetch(req, server) {
                // WHY: Bun's upgrade(req, { data }) differs from our upgrade(req, data)
                // Wrap to adapt the signature so handlers use our simpler interface
                const upgradeServer: UpgradeServer<T> = {
                    upgrade(req: Request, data?: T) {
                        return server.upgrade(req, { data });
                    },
                };

                return handler(req, upgradeServer) as Response | Promise<Response>;
            },
        };

        // Add WebSocket handlers if configured
        // WHY: Only add websocket config when handlers provided, keeps HTTP-only
        // servers simple and avoids Bun allocating WebSocket infrastructure
        if (opts?.websocket) {
            // WHY type assertion: Our types match Bun's but TypeScript can't verify
            config.websocket = opts.websocket as any;
        }

        const server = Bun.serve(config);

        return {
            /**
             * Stop the HTTP server.
             * WHY: Releases port and stops accepting connections.
             */
            async close() {
                server.stop();
            },

            /**
             * AsyncDisposable support for `await using`.
             * WHY: Enables automatic cleanup in try-finally patterns.
             */
            async [Symbol.asyncDispose]() {
                server.stop();
            },

            /**
             * Get server address.
             * WHY: Useful for logging and debugging. Returns actual bound address,
             * which may differ from requested (e.g., port 0 auto-assigns).
             */
            addr() {
                return {
                    hostname: server.hostname ?? '0.0.0.0',
                    port: server.port ?? 0,
                };
            },
        };
    }

    // =========================================================================
    // WEBSOCKET SERVER (Accept Pattern)
    // =========================================================================

    /**
     * Create a WebSocket server with accept pattern.
     *
     * ALGORITHM:
     * 1. Delegate to BunWebSocketServer constructor
     * 2. BunWebSocketServer internally calls Bun.serve() with WebSocket handlers
     * 3. Return initialized server ready to accept connections
     *
     * WHY: Enables Gateway to use same accept-loop pattern for WebSocket as TCP.
     * This keeps Gateway code parallel and reduces complexity.
     *
     * @param port - Port number to listen on
     * @param opts - Optional server configuration
     * @returns Promise resolving to ready-to-use WebSocket server
     */
    async listenWebSocket(port: number, opts?: WebSocketServerOpts): Promise<WebSocketServer> {
        log('listenWebSocket port=%d', port);

        return new BunWebSocketServer(port, opts);
    }
}
