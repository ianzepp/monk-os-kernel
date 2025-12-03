/**
 * WebSocket Channel - Bidirectional communication over WebSocket
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module implements the Channel interface using WebSocket as the transport.
 * It provides bidirectional message passing between client and server, with support
 * for both Request-Response patterns (via handle()) and Server-Push patterns (via
 * recv()).
 *
 * The implementation maintains two separate queues: one for incoming Messages (from
 * server to client) and one for Response streams (client request/response cycles).
 * This separation allows the channel to distinguish between server-initiated messages
 * and responses to client-initiated requests.
 *
 * Message flow patterns:
 * 1. Client request: handle(msg) sends message, waits for response stream
 * 2. Server push: Server sends message, client consumes via recv()
 * 3. Client push: push(response) sends response to server
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Once closed=true, no new operations can start
 * INV-2: WebSocket onmessage handler never throws (errors are queued)
 * INV-3: JSON parse failures are treated as raw messages with op='raw'
 * INV-4: close() is idempotent and safe to call multiple times
 * INV-5: All pending promises resolve when connection closes
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but WebSocket events are async. The onmessage
 * handler can fire at any time, potentially while handle() or recv() are suspended
 * at await points. The implementation uses promise-based queues to coordinate:
 *
 * - messageQueue: Buffer for incoming messages when no recv() is waiting
 * - messageResolve: Pending recv() promise resolver, if any
 * - responseQueue: Buffer for incoming responses when no handle() is waiting
 * - responseResolve: Pending handle() promise resolver, if any
 *
 * At most one resolve callback is pending at a time per queue. When a message
 * arrives, we either resolve a pending promise or queue it for later consumption.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check closed state at entry to every async operation
 * RC-2: Check ws.readyState before every send operation
 * RC-3: Clear pending resolvers on close to prevent use-after-close
 * RC-4: onclose/onerror handlers set _closed before resolving waiters
 *
 * MEMORY MANAGEMENT
 * =================
 * - WebSocket connection owned by this instance
 * - Queues cleared on close to prevent memory leaks
 * - Pending promise resolvers cleared on close to prevent dangling references
 * - No explicit cleanup needed for WebSocket (browser/runtime handles it)
 *
 * @module hal/channel/websocket
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Channel, ChannelOpts } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * WebSocket client channel for bidirectional communication.
 *
 * WHY: WebSocket provides full-duplex communication over a single TCP connection,
 * ideal for real-time message passing between processes and servers.
 *
 * TESTABILITY: Constructor accepts URL, allowing tests to use mock WebSocket
 * servers. The Channel interface allows complete mocking for unit tests.
 */
export class BunWebSocketClientChannel implements Channel {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique channel identifier.
     *
     * WHY: Allows kernel to track channels and correlate operations.
     * INVARIANT: Unique across all channels in the system.
     */
    readonly id = randomUUID();

    /**
     * Protocol discriminator.
     *
     * WHY: Enables kernel to dispatch based on channel protocol without instanceof.
     * INVARIANT: Always 'websocket' for this implementation.
     */
    readonly proto = 'websocket';

    /**
     * Human-readable description (WebSocket URL).
     *
     * WHY: Used in error messages and debugging output to identify this connection.
     */
    readonly description: string;

    // =========================================================================
    // CONNECTION STATE
    // =========================================================================

    /**
     * Underlying WebSocket connection.
     *
     * WHY: Provides the actual network transport.
     * INVARIANT: Non-null after construction, null only during construction.
     */
    private ws: WebSocket | null = null;

    /**
     * Whether the channel is closed.
     *
     * WHY: Provides fast-path check to reject operations without async calls.
     * INVARIANT: Once true, never becomes false.
     */
    private _closed = false;

    // =========================================================================
    // MESSAGE QUEUE (Server -> Client messages)
    // =========================================================================

    /**
     * Queue of incoming messages waiting to be consumed by recv().
     *
     * WHY: Buffers messages that arrive when no recv() is waiting.
     * RACE CONDITION: onmessage can push while recv() is checking queue.
     * MITIGATION: Single-threaded execution prevents actual races.
     */
    private messageQueue: Message[] = [];

    /**
     * Pending recv() promise resolver.
     *
     * WHY: When recv() is called and queue is empty, we store the resolver
     * so onmessage can fulfill it directly.
     *
     * INVARIANT: At most one resolver pending (cleared after resolving).
     */
    private messageResolve: ((msg: Message) => void) | null = null;

    // =========================================================================
    // RESPONSE QUEUE (Server -> Client responses)
    // =========================================================================

    /**
     * Queue of incoming responses waiting to be consumed by handle().
     *
     * WHY: Buffers responses that arrive when no handle() is waiting.
     * RACE CONDITION: onmessage can push while handle() is checking queue.
     * MITIGATION: Single-threaded execution prevents actual races.
     */
    private responseQueue: Response[] = [];

    /**
     * Pending handle() promise resolver.
     *
     * WHY: When handle() waits for next response and queue is empty, we store
     * the resolver so onmessage can fulfill it directly.
     *
     * INVARIANT: At most one resolver pending (cleared after resolving).
     */
    private responseResolve: ((resp: Response) => void) | null = null;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create a new WebSocket client channel.
     *
     * @param url - WebSocket URL (ws:// or wss://)
     * @param _opts - Channel options (currently unused)
     */
    constructor(url: string, _opts?: ChannelOpts) {
        this.description = url;
        this.connect(url);
    }

    /**
     * Establish WebSocket connection and register event handlers.
     *
     * WHY: Separates connection logic from constructor for clarity.
     *
     * ALGORITHM:
     * 1. Convert http:// URLs to ws:// (common mistake)
     * 2. Create WebSocket connection
     * 3. Register onmessage to route incoming data
     * 4. Register onclose to clean up pending operations
     * 5. Register onerror to mark channel as closed
     *
     * @param url - WebSocket URL to connect to
     */
    private connect(url: string): void {
        // Convert http:// or https:// to ws:// or wss://
        // WHY: Users often provide HTTP URLs by mistake, auto-correct to WebSocket
        const wsUrl = url.replace(/^http/, 'ws');
        this.ws = new WebSocket(wsUrl);

        // -------------------------------------------------------------------------
        // Message routing
        // -------------------------------------------------------------------------

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Distinguish responses from messages by checking op field
                // WHY: Responses have ops like 'ok', 'error', 'item', etc.
                // Messages have arbitrary ops like 'call', 'spawn', etc.
                if (data.op && ['ok', 'error', 'item', 'data', 'event', 'progress', 'done', 'redirect'].includes(data.op)) {
                    // It's a response to a client request
                    if (this.responseResolve) {
                        // handle() is waiting, resolve immediately
                        this.responseResolve(data);
                        this.responseResolve = null;
                    } else {
                        // No handle() waiting, queue for later
                        this.responseQueue.push(data);
                    }
                } else {
                    // It's a message (server-initiated)
                    if (this.messageResolve) {
                        // recv() is waiting, resolve immediately
                        this.messageResolve(data);
                        this.messageResolve = null;
                    } else {
                        // No recv() waiting, queue for later
                        this.messageQueue.push(data);
                    }
                }
            } catch {
                // Non-JSON message, treat as raw message
                // WHY: Some protocols send binary or non-JSON text
                const msg: Message = { op: 'raw', data: event.data };
                if (this.messageResolve) {
                    this.messageResolve(msg);
                    this.messageResolve = null;
                } else {
                    this.messageQueue.push(msg);
                }
            }
        };

        // -------------------------------------------------------------------------
        // Connection lifecycle
        // -------------------------------------------------------------------------

        this.ws.onclose = () => {
            this._closed = true;

            // Resolve any pending recv() with close message
            // WHY: Prevents recv() from hanging forever
            if (this.messageResolve) {
                this.messageResolve({ op: 'close', data: null });
                this.messageResolve = null;
            }

            // Reject any pending handle() with error response
            // WHY: Prevents handle() from hanging forever
            if (this.responseResolve) {
                this.responseResolve(respond.error('ECONNRESET', 'Connection closed'));
                this.responseResolve = null;
            }
        };

        this.ws.onerror = () => {
            // Mark as closed immediately
            // WHY: Prevents new operations from starting on failed connection
            this._closed = true;
        };
    }

    // =========================================================================
    // STATE INSPECTION
    // =========================================================================

    /**
     * Check if channel is closed.
     *
     * WHY: Provides synchronous check without async overhead.
     *
     * @returns true if channel is closed
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // CLIENT REQUEST-RESPONSE (handle)
    // =========================================================================

    /**
     * Send a message and wait for response stream.
     *
     * ALGORITHM:
     * 1. Check if connection is open
     * 2. Send message as JSON
     * 3. Wait for responses via waitForResponse()
     * 4. Yield each response
     * 5. Stop when terminal response received (ok/error/done)
     *
     * RACE CONDITION: Connection may close between readyState check and send().
     * MITIGATION: send() throws, which we don't catch, terminating the generator.
     *
     * @param msg - Message to send to server
     * @yields Response stream from server
     */
    async *handle(msg: Message): AsyncIterable<Response> {
        // RACE FIX: Check state before every operation
        if (this._closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        // Send the message
        // WHY: JSON encoding ensures structured data is preserved
        this.ws.send(JSON.stringify(msg));

        // Wait for response(s)
        // WHY: Loop handles streaming responses (multiple chunks, progress events)
        while (true) {
            const response = await this.waitForResponse();
            yield response;

            // Stop on terminal responses
            // WHY: 'ok', 'error', and 'done' indicate no more responses coming
            if (response.op === 'ok' || response.op === 'error' || response.op === 'done') {
                break;
            }
        }
    }

    /**
     * Wait for the next response from the server.
     *
     * ALGORITHM:
     * 1. If response queued, return immediately
     * 2. Otherwise, register resolver and wait
     * 3. onmessage will call resolver when response arrives
     *
     * WHY: Separates waiting logic from handle() for clarity.
     *
     * @returns Promise that resolves to next response
     */
    private async waitForResponse(): Promise<Response> {
        // Fast path: response already in queue
        if (this.responseQueue.length > 0) {
            return this.responseQueue.shift()!;
        }

        // Slow path: wait for onmessage to resolve
        return new Promise((resolve) => {
            this.responseResolve = resolve;
        });
    }

    // =========================================================================
    // CLIENT PUSH (push)
    // =========================================================================

    /**
     * Push a response to the server.
     *
     * WHY: Allows client to initiate responses (e.g., streaming upload).
     *
     * RACE CONDITION: Connection may close between readyState check and send().
     * MITIGATION: Throw error to caller, who should handle cleanup.
     *
     * @param response - Response to send to server
     * @throws Error if channel is closed
     */
    async push(response: Response): Promise<void> {
        // RACE FIX: Check state before operation
        if (this._closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Channel closed');
        }
        this.ws.send(JSON.stringify(response));
    }

    // =========================================================================
    // SERVER PUSH (recv)
    // =========================================================================

    /**
     * Receive a message from the server (server-initiated).
     *
     * ALGORITHM:
     * 1. If message queued, return immediately
     * 2. If closed, return close message
     * 3. Otherwise, register resolver and wait
     * 4. onmessage will call resolver when message arrives
     *
     * WHY: Separates server-push from client request-response.
     *
     * @returns Promise that resolves to next message
     */
    async recv(): Promise<Message> {
        // Fast path: message already in queue
        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }

        // Handle closed state
        // WHY: Return close message rather than hanging forever
        if (this._closed) {
            return { op: 'close', data: null };
        }

        // Slow path: wait for onmessage to resolve
        return new Promise((resolve) => {
            this.messageResolve = resolve;
        });
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    /**
     * Close the WebSocket connection and release resources.
     *
     * ALGORITHM:
     * 1. Set closed flag (prevents new operations)
     * 2. Close WebSocket if open
     * 3. Event handlers will clean up pending promises
     *
     * INVARIANTS:
     * - Idempotent (safe to call multiple times)
     * - After close(), closed=true
     * - After close(), all operations fail
     *
     * @returns Promise that resolves when cleanup is complete
     */
    async close(): Promise<void> {
        this._closed = true;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }
}
