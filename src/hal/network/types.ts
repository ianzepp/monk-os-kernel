/**
 * Network Types - Shared network interfaces
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines the core networking types for Monk OS's Hardware Abstraction
 * Layer (HAL). All network operations flow through these interfaces, providing a
 * clean separation between the kernel and Bun's networking primitives.
 *
 * The design follows a layered approach:
 *
 * 1. NetworkDevice - Top-level factory for creating network resources
 *    Creates listeners, initiates connections, starts HTTP servers
 *
 * 2. Listener - Server-side connection acceptance
 *    Blocks on accept() until client connects, manages connection queue
 *
 * 3. Socket - Bidirectional byte stream
 *    read()/write() operations with timeout support, metadata access
 *
 * 4. HttpServer - High-level HTTP serving
 *    Request/response handling via fetch-style handlers
 *
 * This layering enables:
 * - Clean separation of concerns (factory vs resources)
 * - Type-safe network operations throughout the kernel
 * - Easy mocking for tests (implement interfaces with mock behavior)
 * - Platform independence (swap Bun for Node.js or Deno by reimplementing)
 *
 * All resources implement AsyncDisposable for automatic cleanup via `await using`.
 * This ensures resources are released even if exceptions occur, preventing leaks.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All async operations support Promise-based error handling
 * INV-2: Closed resources throw or return EOF on subsequent operations
 * INV-3: Timeout values are in milliseconds (not seconds)
 * INV-4: TLS configuration uses PEM-encoded strings or file paths
 * INV-5: Port 0 in connect() indicates Unix domain socket
 *
 * CONCURRENCY MODEL
 * =================
 * All operations are async and may be called concurrently. Implementations must
 * handle concurrent access safely:
 *
 * - Multiple accept() calls: Only one should succeed per connection
 * - Multiple read() calls on same socket: Implementation-defined (usually one wins)
 * - Concurrent read() and write(): Both safe, independent operations
 * - Concurrent close() and operations: Operations should fail gracefully
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Timeout implementations must clear state before rejecting
 * RC-2: close() must be idempotent (safe to call multiple times)
 * RC-3: Operations after close() must fail deterministically
 * RC-4: AsyncDisposable ensures cleanup even if exceptions thrown
 *
 * MEMORY MANAGEMENT
 * =================
 * - Listeners own server resources (released on close)
 * - Sockets own connection resources (released on close)
 * - HttpServers own server resources (released on close)
 * - Timeout timers cleaned up on operation completion
 * - All resources support AsyncDisposable for automatic cleanup
 *
 * TESTABILITY
 * ===========
 * - All types are interfaces (easy to mock)
 * - Timeout behavior is deterministic and testable
 * - addr() methods return inspectable metadata
 * - stat() methods return inspectable connection info
 * - Error conditions are well-defined and testable
 *
 * @module hal/network/types
 */

// =============================================================================
// TYPES
// =============================================================================

// -------------------------------------------------------------------------
// TLS Configuration
// -------------------------------------------------------------------------

/**
 * TLS configuration for secure connections.
 *
 * WHY: TLS is essential for production deployments. Configuration is complex
 * enough to warrant a dedicated type rather than inline parameters.
 *
 * FORMATS:
 * - key/cert: PEM-encoded strings or file paths (implementation-defined)
 * - ca: Optional CA bundle for client verification
 *
 * TESTABILITY: Mock implementations can ignore TLS or use self-signed certs.
 */
export interface TlsOpts {
    /**
     * Private key (PEM string or file path).
     * WHY: Required for TLS server operation. Format flexibility enables both
     * embedded keys (strings) and external keys (file paths).
     */
    key: string;

    /**
     * Certificate (PEM string or file path).
     * WHY: Required for TLS server operation. Must match private key.
     */
    cert: string;

    /**
     * CA certificates for client verification (optional).
     * WHY: Enables mutual TLS (mTLS) where server verifies client certificates.
     * Optional because most deployments only verify server identity.
     */
    ca?: string;
}

// -------------------------------------------------------------------------
// Listen Configuration
// -------------------------------------------------------------------------

/**
 * Options for creating a TCP or Unix socket listener.
 *
 * WHY: Listen operations have multiple optional parameters. Grouping them in
 * an options object prevents parameter explosion and enables incremental feature
 * addition without breaking changes.
 */
export interface ListenOpts {
    /**
     * Hostname to bind to (default: 0.0.0.0).
     * WHY: Enables binding to specific interfaces (e.g., localhost only for
     * development, specific IP for multi-homed servers).
     * IGNORED if `unix` is specified.
     */
    hostname?: string;

    /**
     * Unix socket path for IPC.
     * WHY: Enables local process communication without TCP overhead.
     * Essential for gatewayd which bridges external apps to kernel syscalls.
     * When set, `port` and `hostname` are ignored.
     */
    unix?: string;

    /**
     * Enable TLS for secure connections.
     * WHY: Essential for production HTTPS. Optional because many internal
     * services use plain TCP.
     */
    tls?: TlsOpts;

    /**
     * Connection backlog (default: OS default, typically 128).
     * WHY: Controls how many pending connections can queue before accept().
     * Relevant for high-traffic servers that may not accept() fast enough.
     */
    backlog?: number;
}

// -------------------------------------------------------------------------
// Connect Configuration
// -------------------------------------------------------------------------

/**
 * Options for establishing a TCP connection.
 *
 * WHY: Connect operations support timeouts and TLS. Options object enables
 * clean API without parameter explosion.
 */
export interface ConnectOpts {
    /**
     * Connection timeout in milliseconds.
     * WHY: Prevents hanging on unreachable hosts. Essential for robust client
     * behavior. If not specified, may block indefinitely (OS-dependent).
     */
    timeout?: number;

    /**
     * Enable TLS for secure connections.
     * WHY: Essential for HTTPS clients and secure service-to-service communication.
     * Boolean here (not TlsOpts) because clients don't need key/cert (only servers do).
     */
    tls?: boolean;

    /**
     * Server name for SNI (defaults to host).
     * WHY: SNI (Server Name Indication) enables TLS on virtual hosts. Server needs
     * to know which certificate to present. Defaults to host parameter, but can
     * be overridden for advanced scenarios (e.g., connecting to IP but verifying
     * against hostname).
     */
    servername?: string;
}

// -------------------------------------------------------------------------
// Socket Metadata
// -------------------------------------------------------------------------

/**
 * Socket metadata (addresses and ports).
 *
 * WHY: Essential for logging, access control, and debugging. Answers "who am I
 * talking to?" and "what interface am I using?".
 *
 * TESTABILITY: Deterministic values enable assertions in tests.
 */
export interface SocketStat {
    /**
     * Remote peer address.
     * WHY: Identifies the connected peer. Essential for access control and logging.
     */
    remoteAddr: string;

    /**
     * Remote peer port.
     * WHY: Identifies the peer's source port. Useful for correlating connections.
     */
    remotePort: number;

    /**
     * Local address.
     * WHY: Identifies which local interface accepted the connection. Relevant for
     * multi-homed servers.
     */
    localAddr: string;

    /**
     * Local port.
     * WHY: Identifies which local port is being used. Especially relevant when
     * port 0 was specified (OS auto-assigned a port).
     */
    localPort: number;
}

// -------------------------------------------------------------------------
// Socket Read Configuration
// -------------------------------------------------------------------------

/**
 * Options for socket read operations.
 *
 * WHY: Read operations may block indefinitely if peer stalls. Timeout is
 * essential for implementing protocol timeouts and preventing hangs.
 */
export interface SocketReadOpts {
    /**
     * Read timeout in milliseconds. If exceeded, throws ETIMEDOUT.
     * WHY: Prevents read() from blocking indefinitely if peer stops sending.
     * Essential for implementing protocol timeouts (e.g., HTTP read timeout).
     */
    timeout?: number;
}

// -------------------------------------------------------------------------
// Socket Interface
// -------------------------------------------------------------------------

/**
 * Socket interface for connected TCP connections.
 *
 * Provides a read()-based interface over Bun's event-driven sockets. Supports
 * timeouts, graceful shutdown, and metadata inspection.
 *
 * DESIGN RATIONALE:
 * - read() blocks until data/EOF/timeout: Natural async/await code
 * - write() queues data: Fire-and-forget, backpressure handled internally
 * - close() is graceful: Allows buffered data to drain
 * - stat() provides metadata: Essential for logging and access control
 * - AsyncDisposable: Automatic cleanup via `await using`
 *
 * INVARIANTS:
 * - read() returns empty Uint8Array on EOF
 * - write() throws EBADF after close
 * - close() is idempotent
 * - stat() returns deterministic metadata
 *
 * Implements AsyncDisposable for use with `await using`:
 * ```typescript
 * await using socket = await network.connect('localhost', 8080);
 * await socket.write(data);
 * // auto-closed on scope exit
 * ```
 */
export interface Socket extends AsyncDisposable {
    /**
     * Read available data.
     *
     * Blocks until data arrives, connection closes, or timeout exceeded.
     *
     * ALGORITHM:
     * 1. If data buffered: Return immediately
     * 2. If connection closed: Return EOF (empty Uint8Array)
     * 3. Otherwise: Wait for data or close event
     * 4. If timeout specified: Throw ETIMEDOUT if exceeded
     *
     * RACE CONDITION:
     * Data may arrive during the check. Implementation must handle this by
     * checking buffer again after creating the wait Promise.
     *
     * Bun implementation: Data is buffered from socket 'data' events. We maintain
     * an internal queue and resolve Promises when data becomes available.
     *
     * @param opts - Read options (timeout)
     * @returns Data bytes, or empty array if connection closed
     * @throws ETIMEDOUT if timeout exceeded
     */
    read(opts?: SocketReadOpts): Promise<Uint8Array>;

    /**
     * Write data to socket.
     *
     * Queues data for transmission. May buffer internally if kernel buffer full.
     * Does not wait for data to be sent (fire-and-forget).
     *
     * ALGORITHM:
     * 1. Check if socket closed (throw EBADF if so)
     * 2. Queue data for transmission
     * 3. Return immediately (don't wait for send)
     *
     * RACE CONDITION:
     * Socket may close between our check and write. Implementation must handle
     * this safely (either throw or ignore, but no corruption).
     *
     * Bun implementation: socket.write() queues data. Returns number of bytes
     * written. If less than data.length, remainder is buffered internally. Bun
     * handles the buffering and drain events.
     *
     * Caveat: Bun's socket.write() returns number of bytes written. If less than
     * data.length, the rest is buffered. This method blocks until all data is
     * written or queued (in practice, it never blocks because Bun buffers).
     *
     * @param data - Bytes to write
     * @returns Promise resolving when write queued
     * @throws EBADF if socket closed
     */
    write(data: Uint8Array): Promise<void>;

    /**
     * Close socket gracefully.
     *
     * Allows buffered data to drain before closing. Idempotent (safe to call
     * multiple times).
     *
     * ALGORITHM:
     * 1. Mark socket as closed (prevents new writes)
     * 2. Initiate graceful shutdown (drain buffered data)
     * 3. Release resources
     *
     * RACE CONDITION:
     * Operations may be in progress when close() is called. Implementation should:
     * - Set closed flag first (prevents new operations)
     * - Allow in-flight reads to complete with data or EOF
     * - Allow in-flight writes to queue (then drain)
     * - Release resources last
     *
     * Bun implementation: socket.end() for graceful close. Allows buffered writes
     * to complete before closing.
     *
     * @returns Promise resolving when socket closed
     */
    close(): Promise<void>;

    /**
     * Get socket metadata.
     *
     * Returns peer and local address information. Useful for logging, debugging,
     * and access control.
     *
     * WHY: Essential for answering "who am I talking to?" and "what interface
     * am I using?". Needed for access control, logging, and debugging.
     *
     * @returns Socket metadata (addresses and ports)
     */
    stat(): SocketStat;
}

// -------------------------------------------------------------------------
// Listener Accept Configuration
// -------------------------------------------------------------------------

/**
 * Options for accepting connections.
 *
 * WHY: Accept operations may block indefinitely if no clients connect. Timeout
 * is essential for implementing graceful shutdown (accept with timeout, then
 * close if no connection within N seconds).
 */
export interface ListenerAcceptOpts {
    /**
     * Accept timeout in milliseconds. If exceeded, throws ETIMEDOUT.
     * WHY: Prevents accept() from blocking indefinitely if no clients connect.
     * Essential for graceful shutdown scenarios and periodic health checks.
     */
    timeout?: number;
}

// -------------------------------------------------------------------------
// Listener Interface
// -------------------------------------------------------------------------

/**
 * Listener interface for TCP servers.
 *
 * Blocks on accept() until client connects. Manages connection queue internally.
 * Supports timeout and graceful shutdown.
 *
 * DESIGN RATIONALE:
 * - accept() blocks until connection: Natural async/await code
 * - Timeout support: Essential for graceful shutdown
 * - addr() returns bound address: Useful when port 0 specified (auto-assign)
 * - AsyncDisposable: Automatic cleanup via `await using`
 *
 * INVARIANTS:
 * - accept() throws after close()
 * - close() is idempotent
 * - addr() returns deterministic address
 *
 * Implements AsyncDisposable for use with `await using`:
 * ```typescript
 * await using listener = await network.listen(8080);
 * const socket = await listener.accept();
 * // listener auto-closed on scope exit
 * ```
 */
export interface Listener extends AsyncDisposable {
    /**
     * Accept next incoming connection.
     *
     * Blocks until a connection arrives or timeout exceeded. Returns connected
     * socket ready for I/O.
     *
     * ALGORITHM:
     * 1. If connection queued: Return immediately
     * 2. Otherwise: Wait for connection event
     * 3. If timeout specified: Throw ETIMEDOUT if exceeded
     *
     * RACE CONDITION:
     * Connection may arrive during the check. Implementation must handle this
     * by checking queue again after creating the wait Promise.
     *
     * Bun implementation: Connections buffered from 'open' events. We maintain
     * an internal queue and resolve Promises when connections become available.
     *
     * @param opts - Accept options (timeout)
     * @returns Promise resolving to connected socket
     * @throws ETIMEDOUT if timeout exceeded
     * @throws Error if listener closed
     */
    accept(opts?: ListenerAcceptOpts): Promise<Socket>;

    /**
     * Stop listening and close server.
     *
     * Stops accepting new connections. Does not automatically close accepted
     * connections (caller's responsibility).
     *
     * ALGORITHM:
     * 1. Mark listener as closed (prevents new accepts)
     * 2. Stop server (release port)
     * 3. Wake any pending accept() with error
     *
     * INVARIANTS:
     * - Idempotent (safe to call multiple times)
     * - After close(), accept() throws
     * - Queued connections not automatically closed
     *
     * WHY not close queued connections:
     * Queued connections are already accepted and may be in use. Closing them
     * would break active I/O. Caller should drain the queue before closing or
     * explicitly close sockets.
     *
     * Bun implementation: server.stop() releases port and stops accepting.
     *
     * @returns Promise resolving when server stopped
     */
    close(): Promise<void>;

    /**
     * Get listener address.
     *
     * Returns hostname and port the listener is bound to. May differ from
     * requested (e.g., port 0 auto-assigns a port).
     *
     * WHY: Essential for logging, debugging, and connecting clients. When port 0
     * is specified (auto-assign), this is the only way to discover the actual port.
     *
     * @returns Listener address
     */
    addr(): { hostname: string; port: number };
}

// -------------------------------------------------------------------------
// WebSocket Server
// -------------------------------------------------------------------------

/**
 * Server-side WebSocket connection.
 *
 * WHY: Abstracts Bun's ServerWebSocket for platform independence.
 * Provides bidirectional message exchange with connected clients.
 *
 * DESIGN: Matches Bun's ServerWebSocket interface closely to minimize
 * abstraction overhead while enabling future platform portability.
 */
export interface ServerWebSocket<T = unknown> {
    /**
     * Custom data attached to this connection.
     *
     * WHY: Enables associating application state (session ID, user info)
     * with each connection without external maps.
     */
    readonly data: T;

    /**
     * Remote IP address.
     */
    readonly remoteAddress: string;

    /**
     * Send data to the client.
     *
     * @param data - String or binary data to send
     * @param compress - Whether to compress (default: false)
     * @returns Bytes sent, or -1 if dropped due to backpressure
     */
    send(data: string | Uint8Array, compress?: boolean): number;

    /**
     * Close the connection.
     *
     * @param code - Close code (default: 1000)
     * @param reason - Close reason
     */
    close(code?: number, reason?: string): void;

    /**
     * Subscribe to a topic for pub/sub messaging.
     *
     * @param topic - Topic name
     */
    subscribe(topic: string): void;

    /**
     * Unsubscribe from a topic.
     *
     * @param topic - Topic name
     */
    unsubscribe(topic: string): void;

    /**
     * Publish message to all subscribers of a topic.
     *
     * @param topic - Topic name
     * @param data - Data to publish
     * @param compress - Whether to compress
     */
    publish(topic: string, data: string | Uint8Array, compress?: boolean): void;

    /**
     * Check if subscribed to a topic.
     *
     * @param topic - Topic name
     */
    isSubscribed(topic: string): boolean;
}

/**
 * WebSocket event handlers for server-side connections.
 *
 * WHY: Callback-based API matches Bun's model. Each handler is optional
 * to allow handling only events of interest.
 *
 * @template T - Type of custom data attached to each connection
 */
export interface WebSocketHandler<T = unknown> {
    /**
     * Called when a new WebSocket connection is established.
     *
     * WHY: Initialize per-connection state, add to tracking structures.
     *
     * @param ws - The connected WebSocket
     */
    open?(ws: ServerWebSocket<T>): void;

    /**
     * Called when a message is received from the client.
     *
     * WHY: Handle incoming data (commands, events, queries).
     *
     * @param ws - The WebSocket that sent the message
     * @param message - The message data (string or binary)
     */
    message?(ws: ServerWebSocket<T>, message: string | Uint8Array): void;

    /**
     * Called when the connection is closed.
     *
     * WHY: Clean up per-connection state, remove from tracking structures.
     *
     * @param ws - The WebSocket that closed
     * @param code - Close code
     * @param reason - Close reason
     */
    close?(ws: ServerWebSocket<T>, code: number, reason: string): void;

    /**
     * Called when a ping is received.
     *
     * @param ws - The WebSocket
     * @param data - Ping data
     */
    ping?(ws: ServerWebSocket<T>, data: Uint8Array): void;

    /**
     * Called when a pong is received.
     *
     * @param ws - The WebSocket
     * @param data - Pong data
     */
    pong?(ws: ServerWebSocket<T>, data: Uint8Array): void;

    /**
     * Called when backpressure is relieved (drain event).
     *
     * WHY: Resume sending after send() returned -1.
     *
     * @param ws - The WebSocket
     */
    drain?(ws: ServerWebSocket<T>): void;
}

/**
 * Server interface for WebSocket upgrades.
 *
 * WHY: Enables HTTP handlers to upgrade connections to WebSocket.
 * Passed to HttpHandler so it can trigger upgrades.
 */
export interface UpgradeServer<T = unknown> {
    /**
     * Upgrade an HTTP request to a WebSocket connection.
     *
     * @param req - The HTTP request to upgrade
     * @param data - Custom data to attach to the WebSocket
     * @returns true if upgrade succeeded, false otherwise
     */
    upgrade(req: Request, data?: T): boolean;
}

// -------------------------------------------------------------------------
// HTTP Server
// -------------------------------------------------------------------------

/**
 * HTTP handler function.
 *
 * WHY: Matches Web Standards fetch() API. Enables using standard Request/Response
 * types without Monk-specific wrappers.
 *
 * When WebSocket is configured, the handler receives an UpgradeServer that can
 * be used to upgrade connections. Return undefined after calling upgrade().
 *
 * TESTABILITY: Easy to test with mock Request objects.
 *
 * @template T - Type of custom data for WebSocket connections
 */
export type HttpHandler<T = unknown> = (
    req: Request,
    server?: UpgradeServer<T>,
) => Response | Promise<Response> | undefined | Promise<undefined>;

/**
 * Options for HTTP server creation.
 *
 * WHY: Enables optional WebSocket support without changing serve() signature.
 *
 * @template T - Type of custom data for WebSocket connections
 */
export interface ServeOpts<T = unknown> {
    /**
     * Hostname to bind to (default: '0.0.0.0').
     */
    hostname?: string;

    /**
     * WebSocket handlers for upgraded connections.
     *
     * WHY: When present, enables HTTP → WebSocket upgrades.
     * The HTTP handler receives an UpgradeServer to trigger upgrades.
     */
    websocket?: WebSocketHandler<T>;
}

/**
 * HTTP server interface.
 *
 * High-level HTTP serving via fetch-style handlers. Handles HTTP protocol details
 * (parsing, routing, response encoding) internally.
 *
 * DESIGN RATIONALE:
 * - fetch() API: Standard Web API, familiar to developers
 * - addr() returns bound address: Useful when port 0 specified
 * - AsyncDisposable: Automatic cleanup via `await using`
 *
 * INVARIANTS:
 * - close() stops server immediately (no graceful drain)
 * - close() is idempotent
 * - addr() returns deterministic address
 *
 * Implements AsyncDisposable for use with `await using`:
 * ```typescript
 * await using server = await network.serve(8080, handler);
 * // server auto-closed on scope exit
 * ```
 */
export interface HttpServer extends AsyncDisposable {
    /**
     * Stop HTTP server.
     *
     * Stops accepting new requests. In-flight requests may complete or abort
     * (implementation-defined).
     *
     * ALGORITHM:
     * 1. Stop accepting new connections
     * 2. Release resources
     *
     * INVARIANTS:
     * - Idempotent (safe to call multiple times)
     * - In-flight requests behavior is implementation-defined
     *
     * Bun implementation: server.stop() stops immediately. In-flight requests
     * may be aborted.
     *
     * @returns Promise resolving when server stopped
     */
    close(): Promise<void>;

    /**
     * Get server address.
     *
     * Returns hostname and port the server is listening on. May differ from
     * requested (e.g., port 0 auto-assigns a port).
     *
     * WHY: Essential for logging, debugging, and connecting clients. When port 0
     * is specified (auto-assign), this is the only way to discover the actual port.
     *
     * @returns Server address
     */
    addr(): { hostname: string; port: number };
}

// -------------------------------------------------------------------------
// Network Device Interface
// -------------------------------------------------------------------------

/**
 * Network device interface.
 *
 * Top-level factory for creating network resources. All network operations in
 * Monk OS flow through this interface.
 *
 * DESIGN RATIONALE:
 * - Factory pattern: Centralized resource creation
 * - Platform independence: Swap Bun for Node.js by reimplementing this interface
 * - Dependency injection: Kernel receives this as a dependency (testable)
 *
 * INVARIANTS:
 * - All methods return initialized, ready-to-use resources
 * - Port 0 in connect() indicates Unix domain socket
 * - listen() and serve() return immediately (server is listening)
 */
export interface NetworkDevice {
    /**
     * Create a TCP listener.
     *
     * Returns immediately with a listening server. Connections are queued until
     * accept() is called.
     *
     * ALGORITHM:
     * 1. Bind to hostname:port
     * 2. Start listening with backlog
     * 3. Return listener handle
     *
     * Bun implementation: Bun.listen() with socket handlers for connection events.
     *
     * @param port - Port to listen on
     * @param opts - Listen options (hostname, TLS, backlog)
     * @returns Promise resolving to ready-to-use listener
     */
    listen(port: number, opts?: ListenOpts): Promise<Listener>;

    /**
     * Connect to a TCP server or Unix socket.
     *
     * Initiates connection asynchronously. Returns when connection established
     * or error occurs.
     *
     * ALGORITHM:
     * 1. If port=0: Connect to Unix socket at host path
     * 2. Otherwise: Connect to TCP at host:port
     * 3. If timeout specified: Abort if not connected within timeout
     * 4. Return connected socket
     *
     * RACE CONDITION:
     * Timeout may fire before or after connection succeeds. Implementation must
     * check if connection succeeded before rejecting.
     *
     * WHY port=0 for Unix sockets:
     * Port 0 is invalid for TCP, so we repurpose it to indicate Unix socket.
     * This keeps the API simple (one connect() method instead of two).
     *
     * Bun implementation: Bun.connect({ hostname, port }) or Bun.connect({ unix: path })
     *
     * @param host - Hostname/IP for TCP, or socket path for Unix
     * @param port - Port number for TCP, or 0 for Unix sockets
     * @param opts - Connection options (timeout, TLS)
     * @returns Promise resolving to connected socket
     * @throws ETIMEDOUT if connection timeout exceeded
     */
    connect(host: string, port: number, opts?: ConnectOpts): Promise<Socket>;

    /**
     * Create an HTTP server with optional WebSocket support.
     *
     * Returns immediately with a listening server. Requests are handled by the
     * provided handler function. If WebSocket handlers are provided, the HTTP
     * handler can upgrade connections to WebSocket.
     *
     * ALGORITHM:
     * 1. Bind to port
     * 2. Start HTTP server with handler
     * 3. If websocket configured, enable upgrade support
     * 4. Return server handle
     *
     * Bun implementation: Bun.serve() with fetch-style handler and optional
     * websocket config.
     *
     * @param port - Port to listen on
     * @param handler - Request handler function
     * @param opts - Optional server options (hostname, websocket handlers)
     * @returns Promise resolving to HTTP server handle
     *
     * @example
     * ```typescript
     * // HTTP only
     * const server = await network.serve(8080, (req) => new Response('Hello'));
     *
     * // HTTP + WebSocket
     * const server = await network.serve(8080, (req, server) => {
     *     if (req.url.endsWith('/ws')) {
     *         server.upgrade(req, { userId: '123' });
     *         return;
     *     }
     *     return new Response('Hello');
     * }, {
     *     websocket: {
     *         open(ws) { console.log('connected', ws.data.userId); },
     *         message(ws, msg) { ws.send(`echo: ${msg}`); },
     *         close(ws) { console.log('disconnected'); },
     *     },
     * });
     * ```
     */
    serve<T = unknown>(port: number, handler: HttpHandler<T>, opts?: ServeOpts<T>): Promise<HttpServer>;
}
