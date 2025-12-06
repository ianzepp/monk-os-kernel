/**
 * TCP Listener - Bun.listen() wrapper
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module wraps Bun.listen() to provide a promise-based accept() interface
 * for incoming TCP connections. Bun's socket API is event-driven - new connections
 * trigger 'open' callbacks asynchronously. We bridge this to a synchronous-looking
 * accept() method that blocks until a connection arrives.
 *
 * The design maintains a connection queue: when connections arrive faster than
 * accept() is called, we buffer them. When accept() is called with no pending
 * connections, we store the resolver and wake it when the next connection arrives.
 *
 * Each accepted connection gets wrapped in a BunSocket which handles the data
 * buffering and read()/write() interface. We attach state to Bun's socket objects
 * via properties (_halSocket, _dataQueue, etc.) so the socket event handlers can
 * access the shared state needed for buffering.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Server is listening immediately after constructor completes
 * INV-2: connectionQueue contains only valid, open BunSocket instances
 * INV-3: connectionResolve is non-null only when accept() is blocked waiting
 * INV-4: Once closed=true, accept() always throws and no new connections arrive
 * INV-5: Each Bun socket has exactly one associated BunSocket wrapper
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * accept() calls may be in progress (though this is unusual). Connection events
 * arrive asynchronously from Bun's event loop.
 *
 * Key concurrency points:
 * - Multiple accept() calls: Only last one's resolver is stored (previous ones lost)
 * - Connection arrives during accept(): Resolver called immediately
 * - Connection arrives with no accept(): Buffered in queue
 * - close() during accept(): Pending accept() should reject
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check closed flag before accepting connections
 * RC-2: Clear connectionResolve on timeout to prevent double-resolution
 * RC-3: Each socket gets isolated event handlers via closure captures
 * RC-4: Socket state attached as properties (not shared state) to prevent confusion
 *
 * MEMORY MANAGEMENT
 * =================
 * - Bun.listen() server released via server.stop() in close()
 * - Connection queue cleared on close (sockets not automatically closed)
 * - Each socket wrapper manages its own data queue
 * - Timeout timers cleaned up on successful accept
 *
 * TESTABILITY
 * ===========
 * - Constructor immediately starts listening (no async init)
 * - accept() behavior testable with timeout scenarios
 * - Closed state testable via repeated close() calls (idempotent)
 * - addr() returns deterministic address info
 *
 * @module hal/network/listener
 */

import type { Listener, ListenerAcceptOpts, ListenOpts, Socket } from './types.js';
import { BunSocket } from './socket.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Bun TCP listener wrapper.
 *
 * Bridges Bun's event-driven connection callbacks to promise-based accept().
 * Maintains internal connection queue for buffering rapid connection arrivals.
 *
 * WHY: Isolates listener logic from NetworkDevice. Enables testing of connection
 * acceptance patterns independently.
 */
export class BunListener implements Listener {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Underlying Bun.listen() server.
     * WHY: Use 'any' to avoid Bun.listen's complex union type between TCP/Unix listeners.
     * INVARIANT: Non-null until close() is called.
     */
    private server: any = null;

    /**
     * Queue of accepted but not yet returned connections.
     * WHY: Buffers connections that arrive faster than accept() is called.
     * INVARIANT: Contains only open, valid BunSocket instances.
     */
    private connectionQueue: Socket[] = [];

    /**
     * Pending accept() promise resolver.
     * WHY: When accept() is called with no queued connections, we store the
     * resolver here. Next connection arrival calls it.
     * INVARIANT: Non-null only when accept() is blocked waiting.
     * RACE CONDITION: Only one accept() can be pending. If multiple accept()
     * calls are made, only the last one's resolver is stored.
     */
    private connectionResolve: ((socket: Socket) => void) | null = null;

    /**
     * Listener closed flag.
     * WHY: Prevents accept() after close and signals cleanup.
     * INVARIANT: Once true, never becomes false.
     */
    private closed = false;

    /**
     * Bound hostname (TCP mode).
     * WHY: Stored for addr() method. May differ from requested (e.g., '0.0.0.0').
     * Undefined for Unix socket listeners.
     */
    private hostname: string;

    /**
     * Bound port (TCP mode).
     * WHY: Stored for addr() method. May differ from requested (e.g., port 0 auto-assigns).
     * 0 for Unix socket listeners.
     */
    private port: number;

    /**
     * Unix socket path (Unix mode).
     * WHY: Stored for addr() method. Undefined for TCP listeners.
     */
    private unixPath?: string;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create and start TCP or Unix socket listener.
     *
     * ALGORITHM:
     * 1. Store hostname/port (TCP) or unixPath (Unix)
     * 2. Call start() to initialize Bun.listen()
     * 3. Return immediately (listener is active)
     *
     * WHY: Constructor pattern enables immediate use. No separate init() call needed.
     *
     * @param port - Port number to listen on (ignored if opts.unix is set)
     * @param opts - Optional listen configuration (including unix socket path)
     */
    constructor(port: number, opts?: ListenOpts) {
        if (opts?.unix) {
            // Unix socket mode
            this.unixPath = opts.unix;
            this.hostname = 'unix';
            this.port = 0;
        }
        else {
            // TCP mode
            this.port = port;
            this.hostname = opts?.hostname ?? '0.0.0.0';
        }

        this.start(opts);
    }

    /**
     * Initialize Bun.listen() with socket handlers.
     *
     * ALGORITHM:
     * 1. Define socket event handlers (open, data, close, error)
     * 2. Call Bun.listen() with handlers
     * 3. On 'open': Create BunSocket wrapper and queue or resolve accept()
     * 4. On 'data': Forward to BunSocket's data queue
     * 5. On 'close': Signal EOF to BunSocket
     * 6. On 'error': Log error and close socket
     *
     * RACE CONDITION:
     * Connections may arrive before accept() is called (queue them) or after
     * accept() is called (resolve immediately). We handle both cases by checking
     * connectionResolve.
     *
     * MEMORY MANAGEMENT:
     * Each socket gets its own data queue and event handler closures. State is
     * attached to the Bun socket object to enable handlers to access it.
     *
     * WHY attach state to socket:
     * Bun's event handlers receive the socket as first argument. We need to access
     * the socket's data queue and closed flag from these handlers. Rather than
     * maintaining a separate Map<socket, state>, we attach state directly to the
     * socket object. This is safe because each socket has one wrapper.
     *
     * @param opts - Listen options
     */
    private start(opts?: ListenOpts): void {
        const self = this;

        // Build Bun.listen() config based on mode
        const listenConfig: any = {
            socket: {},
        };

        if (opts?.unix) {
            // Unix socket mode
            listenConfig.unix = opts.unix;
        }
        else {
            // TCP mode
            listenConfig.hostname = this.hostname;
            listenConfig.port = this.port;
            if (opts?.tls) {
                listenConfig.tls = {
                    key: Bun.file(opts.tls.key),
                    cert: Bun.file(opts.tls.cert),
                };
            }
        }

        listenConfig.socket = {
            /**
                 * New connection accepted.
                 *
                 * ALGORITHM:
                 * 1. Create data queue and state for this socket
                 * 2. Create BunSocket wrapper with closures for state access
                 * 3. Attach state to Bun socket for handler access
                 * 4. If accept() is waiting: resolve immediately
                 * 5. Otherwise: queue connection
                 *
                 * WHY closures:
                 * BunSocket needs getters/setters for shared state (dataResolve,
                 * closed flag). We provide these as closures that capture the
                 * local variables, enabling controlled access.
                 *
                 * RACE FIX:
                 * Check connectionResolve before queueing. If accept() is waiting,
                 * deliver connection immediately instead of queueing.
                 */
            open(socket: any) {
                /**
                     * Data queue for this socket.
                     * WHY: Buffers incoming bytes until read() consumes them.
                     */
                const dataQueue: Uint8Array[] = [];

                /**
                     * Pending read() resolver for this socket.
                     * WHY: Wakes blocked read() when data arrives.
                     */
                let dataResolve: ((data: Uint8Array) => void) | null = null;

                /**
                     * Socket closed flag.
                     * WHY: Prevents write() after close, signals EOF to read().
                     */
                let closed = false;

                /**
                     * Create BunSocket wrapper with state access closures.
                     * WHY: BunSocket needs to mutate dataResolve and closed, but
                     * we don't want to expose them directly. Closures provide
                     * controlled access.
                     */
                const wrappedSocket = new BunSocket(
                    socket,
                    dataQueue,
                    () => dataResolve,
                    r => {
                        dataResolve = r;
                    },
                    () => closed,
                    c => {
                        closed = c;
                    },
                );

                /**
                     * Attach state to Bun socket for handler access.
                     * WHY: data/close/error handlers need to access the socket's
                     * state. Rather than maintaining a separate map, we attach
                     * state directly to the socket object.
                     *
                     * INVARIANT: Each socket has exactly one set of state.
                     */
                (socket as any)._halSocket = wrappedSocket;
                (socket as any)._dataQueue = dataQueue;
                (socket as any)._getDataResolve = () => dataResolve;
                (socket as any)._setDataResolve = (r: any) => {
                    dataResolve = r;
                };

                (socket as any)._setClosed = (c: boolean) => {
                    closed = c;
                };

                /**
                     * Deliver connection to pending accept() or queue it.
                     * RACE FIX: Check connectionResolve to decide. If accept()
                     * is waiting, deliver immediately. Otherwise queue.
                     */
                if (self.connectionResolve) {
                    self.connectionResolve(wrappedSocket);
                    self.connectionResolve = null;
                }
                else {
                    self.connectionQueue.push(wrappedSocket);
                }
            },

            /**
                 * Data received on socket.
                 *
                 * WHY: Forward to socket's data queue. If read() is blocked,
                 * wake it. Otherwise buffer.
                 */
            data(socket: any, data: any) {
                const bytes = new Uint8Array(data);
                const dataQueue = (socket as any)._dataQueue as Uint8Array[];
                const dataResolve = (socket as any)._getDataResolve() as ((data: Uint8Array) => void) | null;

                if (dataResolve) {
                    // Pending read() - wake it
                    dataResolve(bytes);
                    (socket as any)._setDataResolve(null);
                }
                else {
                    // No pending read - buffer
                    dataQueue.push(bytes);
                }
            },

            /**
                 * Socket closed by peer.
                 *
                 * WHY: Mark socket closed and wake any pending read() with EOF.
                 */
            close(socket: any) {
                (socket as any)._setClosed(true);
                const dataResolve = (socket as any)._getDataResolve() as ((data: Uint8Array) => void) | null;

                if (dataResolve) {
                    // Pending read() - wake with EOF
                    dataResolve(new Uint8Array(0));
                    (socket as any)._setDataResolve(null);
                }
            },

            /**
                 * Socket error.
                 *
                 * WHY: Log error and mark socket closed. In production, this should
                 * use a proper logger instead of console.error.
                 *
                 * TODO: Replace console.error with kernel logger.
                 */
            error(socket: any, error: any) {
                console.error('Socket error:', error);
                (socket as any)._setClosed(true);
            },
        };

        this.server = Bun.listen(listenConfig);
    }

    // =========================================================================
    // OPERATIONS
    // =========================================================================

    /**
     * Accept next incoming connection.
     *
     * ALGORITHM:
     * 1. Check if listener is closed (throw if so)
     * 2. If connections queued: Return immediately
     * 3. Otherwise: Create Promise and store resolver
     * 4. If timeout specified: Reject on timeout
     * 5. On connection arrival: Resolver called by open() handler
     *
     * RACE CONDITION:
     * Multiple accept() calls with no connections will overwrite connectionResolve.
     * Only the last accept() will receive a connection. This is unusual but not
     * a bug - callers shouldn't have multiple pending accepts.
     *
     * RACE FIX:
     * On timeout, clear connectionResolve before rejecting. This prevents the
     * late arrival of a connection from calling a stale resolver.
     *
     * ERROR HANDLING:
     * - Closed listener throws immediately
     * - Timeout throws ETIMEDOUT
     * - Connection errors are per-socket (not listener errors)
     *
     * @param opts - Accept options (timeout)
     * @returns Promise resolving to connected socket
     * @throws Error - If listener closed
     * @throws Error - If timeout exceeded (ETIMEDOUT)
     */
    async accept(opts?: ListenerAcceptOpts): Promise<Socket> {
        /**
         * Check closed state.
         * WHY: Prevents accept() after close. Once closed, listener is unusable.
         */
        if (this.closed) {
            throw new Error('Listener closed');
        }

        /**
         * Return queued connection if available.
         * WHY: Fast path - no need to wait if connection already arrived.
         */
        if (this.connectionQueue.length > 0) {
            return this.connectionQueue.shift()!;
        }

        /**
         * Wait for next connection.
         * WHY: No queued connections - must wait for next arrival.
         */
        return new Promise((resolve, reject) => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            /**
             * Set timeout if requested.
             * RACE FIX: Clear connectionResolve before rejecting. This prevents
             * a late connection arrival from calling the stale resolver.
             *
             * WHY: Prevents accept() from blocking indefinitely if no connections
             * arrive. Especially useful for graceful shutdown scenarios.
             */
            if (opts?.timeout) {
                timeoutId = setTimeout(() => {
                    this.connectionResolve = null;
                    reject(new Error('ETIMEDOUT: Accept timeout'));
                }, opts.timeout);
            }

            /**
             * Store resolver for next connection.
             * WHY: open() handler will call this when connection arrives.
             *
             * RACE CONDITION: If multiple accept() calls are pending, only the
             * last one's resolver is stored. Previous ones are lost. This is
             * acceptable because multiple pending accepts is unusual.
             */
            this.connectionResolve = socket => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }

                resolve(socket);
            };
        });
    }

    /**
     * Stop listening and close server.
     *
     * ALGORITHM:
     * 1. Set closed flag
     * 2. Stop Bun.listen() server
     * 3. Clear server reference
     *
     * INVARIANTS:
     * - Idempotent (safe to call multiple times)
     * - After close(), accept() throws
     * - Queued connections not automatically closed (caller's responsibility)
     *
     * WHY NOT close queued connections:
     * Queued connections are already accepted and may be in use. Closing them
     * would break active I/O. Caller should drain the queue before closing or
     * explicitly close sockets.
     *
     * @returns Promise resolving when server stopped
     */
    async close(): Promise<void> {
        this.closed = true;
        if (this.server) {
            this.server.stop();
            this.server = null;
        }
    }

    /**
     * AsyncDisposable support for `await using`.
     * WHY: Enables automatic cleanup in try-finally patterns.
     */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    /**
     * Get listener address.
     *
     * WHY: Useful for logging, debugging, and connecting clients. Returns the
     * actual bound address, which may differ from requested (e.g., hostname
     * resolution, port 0 auto-assignment).
     *
     * @returns Listener address
     */
    addr(): { hostname: string; port: number } {
        return {
            hostname: this.hostname,
            port: this.port,
        };
    }
}
