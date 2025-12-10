/**
 * WebSocket Server - Accept-pattern WebSocket server implementation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module provides a WebSocket server that follows the accept() pattern used
 * by TCP listeners. Instead of callback-based WebSocket handlers, connections are
 * queued and returned via accept(), enabling the same code pattern for both TCP
 * and WebSocket in the Gateway:
 *
 *   TCP: socket = await listener.accept(); handleClient(socket);
 *   WS:  ws = await wsServer.accept(); handleWebSocketClient(ws);
 *
 * The implementation bridges Bun's callback-based WebSocket API with our
 * Promise-based accept pattern using queues and waiters.
 *
 * WIRE PROTOCOL
 * =============
 * This server is protocol-agnostic. It accepts all WebSocket connections and
 * provides raw binary message iteration. The Gateway layer handles msgpack
 * encoding/decoding.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Each accepted connection is delivered to exactly one accept() caller
 *        VIOLATED BY: Multiple waiters getting same connection (prevented by shift())
 * INV-2: Messages are delivered in order per connection
 *        VIOLATED BY: Concurrent message handlers (prevented by queue + shift pattern)
 * INV-3: Connection close ends message iteration
 *        ENFORCED BY: pushClose() resolving pending waiter with null
 * INV-4: Server close wakes all pending accept() with error
 *        ENFORCED BY: close() rejecting all waiters
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations interleave:
 *
 * - Bun's WebSocket callbacks fire on event loop (not concurrent with our code)
 * - accept() may be called while connection is arriving (queue handles this)
 * - Multiple accept() calls queue up and get connections in order
 * - Message iteration and sendBinary() are independent (both safe)
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Connection arrives during accept() - waiter queue handles this
 * RC-2: Message arrives during iteration - message queue handles this
 * RC-3: close() during accept() - closed flag checked, waiters rejected
 * RC-4: close() during iteration - pushClose() ends iteration gracefully
 *
 * MEMORY MANAGEMENT
 * =================
 * - BunWebSocketServer owns the Bun.serve() server instance
 * - Connection queue holds pending connections until accept()
 * - Waiter queue holds pending accept() Promises until connections arrive
 * - BunWebSocketConnection owns message queue for its lifetime
 * - All queues cleared on close()
 *
 * @module hal/network/websocket-server
 */

import type {
    WebSocketConnection,
    WebSocketServer,
    WebSocketServerOpts,
} from './types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default maximum payload size (1MB).
 * WHY: Matches TCP's MAX_READ_BUFFER_SIZE for consistency across transports.
 * Prevents memory exhaustion from oversized messages.
 */
const DEFAULT_MAX_PAYLOAD_LENGTH = 1024 * 1024;

// =============================================================================
// WEBSOCKET CONNECTION
// =============================================================================

/**
 * WebSocket connection wrapper with async message iteration.
 *
 * Wraps Bun's ServerWebSocket to provide:
 * - Async iteration over incoming messages
 * - Binary-only message delivery (text messages ignored)
 * - Graceful close handling
 *
 * WHY: Gateway needs to iterate messages like TCP reads. This wrapper converts
 * Bun's callback-based message delivery to an async iterator pattern.
 */
export class BunWebSocketConnection implements WebSocketConnection {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Queue of received messages waiting for iteration.
     * WHY: Messages may arrive faster than iteration consumes them.
     */
    private messageQueue: Uint8Array[] = [];

    /**
     * Pending message waiter (set when iteration is blocked waiting for message).
     * WHY: When no messages are queued, iteration blocks here until message arrives.
     */
    private messageWaiter: ((msg: Uint8Array | null) => void) | null = null;

    /**
     * Connection closed flag.
     * WHY: Signals iteration to end gracefully.
     */
    private closed = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new WebSocket connection wrapper.
     *
     * @param ws - Underlying Bun ServerWebSocket
     */
    constructor(private readonly ws: { send: (data: string | Uint8Array, compress?: boolean) => number; close: (code?: number, reason?: string) => void; remoteAddress: string }) {}

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    /**
     * Remote IP address of the client.
     */
    get remoteAddress(): string {
        return this.ws.remoteAddress;
    }

    // =========================================================================
    // MESSAGE DELIVERY (called by server's message handler)
    // =========================================================================

    /**
     * Push a received message to the queue or waiting iterator.
     *
     * Called by the WebSocket server's message handler when a binary message
     * arrives from the client.
     *
     * ALGORITHM:
     * 1. If waiter exists: Deliver directly (wake iterator)
     * 2. Otherwise: Queue for later iteration
     *
     * @param msg - Binary message received from client
     */
    pushMessage(msg: Uint8Array): void {
        if (this.messageWaiter) {
            // Deliver directly to waiting iterator
            this.messageWaiter(msg);
            this.messageWaiter = null;
        }
        else {
            // Queue for later iteration
            this.messageQueue.push(msg);
        }
    }

    /**
     * Signal connection close to the iterator.
     *
     * Called by the WebSocket server's close handler when the connection ends.
     * Wakes any pending iteration with null to signal EOF.
     */
    pushClose(): void {
        this.closed = true;
        if (this.messageWaiter) {
            this.messageWaiter(null);
            this.messageWaiter = null;
        }
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Send binary data to the client.
     *
     * @param data - Binary data to send
     * @returns true if queued successfully, false if failed
     */
    sendBinary(data: Uint8Array): boolean {
        if (this.closed) {
            return false;
        }

        try {
            const result = this.ws.send(data);

            // Bun returns bytes sent, or -1 if dropped due to backpressure
            return result >= 0;
        }
        catch {
            return false;
        }
    }

    /**
     * Close the WebSocket connection.
     *
     * @param code - Close code (default: 1000)
     * @param reason - Close reason
     */
    close(code?: number, reason?: string): void {
        if (!this.closed) {
            this.closed = true;
            try {
                this.ws.close(code ?? 1000, reason);
            }
            catch {
                // May already be closed
            }
        }
    }

    // =========================================================================
    // ASYNC ITERATOR
    // =========================================================================

    /**
     * Async iterator for incoming binary messages.
     *
     * ALGORITHM per next():
     * 1. If messages queued: Return next message immediately
     * 2. If closed: Return done
     * 3. Otherwise: Wait for message or close
     *
     * RACE CONDITION:
     * Message may arrive between queue check and wait setup. The pushMessage()
     * method checks for waiter first, so message goes to queue if no waiter yet.
     */
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        while (!this.closed) {
            // Check queue first
            const queued = this.messageQueue.shift();

            if (queued !== undefined) {
                yield queued;
                continue;
            }

            // Wait for message or close
            const msg = await new Promise<Uint8Array | null>(resolve => {
                this.messageWaiter = resolve;
            });

            // null signals close
            if (msg === null) {
                break;
            }

            yield msg;
        }
    }

    // =========================================================================
    // TEST HELPERS
    // =========================================================================

    /**
     * Get number of queued messages.
     * TESTING: Allows tests to verify message buffering.
     */
    getQueuedMessageCount(): number {
        return this.messageQueue.length;
    }

    /**
     * Check if connection is closed.
     * TESTING: Allows tests to verify close state.
     */
    isClosed(): boolean {
        return this.closed;
    }
}

// =============================================================================
// WEBSOCKET SERVER
// =============================================================================

/**
 * WebSocket server with accept pattern.
 *
 * Wraps Bun.serve() with WebSocket handlers to provide an accept() interface
 * matching TCP listeners.
 */
export class BunWebSocketServer implements WebSocketServer {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Underlying Bun HTTP server.
     */
    private server: ReturnType<typeof Bun.serve>;

    /**
     * Queue of connections waiting for accept().
     * WHY: Connections may arrive before accept() is called.
     */
    private pendingConnections: BunWebSocketConnection[] = [];

    /**
     * Queue of accept() waiters (Promises waiting for connections).
     * WHY: accept() may be called before connections arrive.
     */
    private acceptWaiters: Array<{
        resolve: (conn: WebSocketConnection) => void;
        reject: (err: Error) => void;
    }> = [];

    /**
     * Server closed flag.
     * WHY: Prevents accept() after close, rejects pending waiters.
     */
    private closed = false;

    /**
     * Map of Bun WebSocket to our wrapper.
     * WHY: Need to route message/close events to correct wrapper instance.
     * Uses WeakMap to avoid memory leaks.
     */
    private connectionMap = new WeakMap<object, BunWebSocketConnection>();

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new WebSocket server.
     *
     * @param portNumber - Port to listen on
     * @param opts - Server options
     */
    constructor(portNumber: number, opts?: WebSocketServerOpts) {
        const maxPayloadLength = opts?.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH;

        this.server = Bun.serve({
            port: portNumber,
            hostname: opts?.hostname,

            // HTTP handler - upgrade all requests to WebSocket
            fetch(req, server) {
                // Upgrade to WebSocket (all requests on this port are WS)
                // WHY: Pass data property - Bun requires it for typing
                const upgraded = server.upgrade(req, { data: undefined });

                if (upgraded) {
                    return undefined;
                }

                // Not a WebSocket request - reject
                return new Response('WebSocket expected', { status: 400 });
            },

            websocket: {
                maxPayloadLength,

                // Connection opened - queue for accept()
                open: ws => {
                    // Create wrapper and store mapping
                    const conn = new BunWebSocketConnection(ws);

                    this.connectionMap.set(ws, conn);

                    // Deliver to waiting accept() or queue
                    const waiter = this.acceptWaiters.shift();

                    if (waiter) {
                        waiter.resolve(conn);
                    }
                    else {
                        this.pendingConnections.push(conn);
                    }
                },

                // Message received - route to connection wrapper
                message: (ws, message) => {
                    const conn = this.connectionMap.get(ws);

                    if (conn && message instanceof Uint8Array) {
                        conn.pushMessage(message);
                    }
                    else if (conn && typeof message === 'string') {
                        // Convert string to Uint8Array for consistent handling
                        conn.pushMessage(new TextEncoder().encode(message));
                    }
                },

                // Connection closed - notify wrapper
                close: ws => {
                    const conn = this.connectionMap.get(ws);

                    if (conn) {
                        conn.pushClose();
                        this.connectionMap.delete(ws);
                    }
                },
            },
        });
    }

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    /**
     * Port the server is listening on.
     */
    get port(): number {
        // WHY: Bun.serve() always assigns a port, but TypeScript types it as optional
        return this.server.port ?? 0;
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Accept the next WebSocket connection.
     *
     * Blocks until a client connects or server is closed.
     *
     * @returns Promise resolving to connected WebSocket
     * @throws Error if server is closed
     */
    accept(): Promise<WebSocketConnection> {
        // Check if closed
        if (this.closed) {
            return Promise.reject(new Error('WebSocket server is closed'));
        }

        // Check for pending connection
        const pending = this.pendingConnections.shift();

        if (pending) {
            return Promise.resolve(pending);
        }

        // Wait for connection
        return new Promise((resolve, reject) => {
            this.acceptWaiters.push({ resolve, reject });
        });
    }

    /**
     * Stop the WebSocket server.
     *
     * Stops accepting new connections and rejects pending accept() calls.
     */
    async close(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;

        // Reject all pending accept() waiters
        const error = new Error('WebSocket server is closed');

        for (const waiter of this.acceptWaiters) {
            waiter.reject(error);
        }

        this.acceptWaiters = [];

        // Clear pending connections
        this.pendingConnections = [];

        // Stop the server
        this.server.stop();
    }

    // =========================================================================
    // TEST HELPERS
    // =========================================================================

    /**
     * Get number of pending connections.
     * TESTING: Allows tests to verify connection queuing.
     */
    getPendingConnectionCount(): number {
        return this.pendingConnections.length;
    }

    /**
     * Get number of pending accept() waiters.
     * TESTING: Allows tests to verify waiter queuing.
     */
    getPendingAcceptCount(): number {
        return this.acceptWaiters.length;
    }

    /**
     * Check if server is closed.
     * TESTING: Allows tests to verify close state.
     */
    isClosed(): boolean {
        return this.closed;
    }
}
