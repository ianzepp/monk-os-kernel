/**
 * SSE Server Channel - Server-Sent Events over raw socket
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The SSE (Server-Sent Events) channel provides server-to-client push messaging
 * over HTTP. Unlike WebSocket (bidirectional) or HTTP (request/response), SSE
 * is unidirectional - server pushes events to client over long-lived HTTP
 * connection.
 *
 * The channel wraps an already-accepted TCP socket and sends:
 * 1. HTTP response headers (200 OK, text/event-stream, keep-alive)
 * 2. SSE formatted events (event: type\ndata: json\n\n)
 *
 * Events are pushed via push() method, not handle(). This is server-side only -
 * client cannot send messages back (would require separate HTTP request).
 *
 * SSE is used for real-time updates, notifications, live logs, and streaming
 * data where bidirectional communication is not needed.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Socket is set at construction and never modified
 * INV-2: HTTP headers sent exactly once (before first event)
 * INV-3: Once closed=true, push() must throw error
 * INV-4: Events formatted per SSE spec (event:, data:, blank line)
 * INV-5: Socket is closed only once (on close())
 *
 * CONCURRENCY MODEL
 * =================
 * Multiple processes/handlers may call push() concurrently on the same channel.
 * Socket writes are NOT serialized by this class - caller must coordinate if
 * order matters. Typically, SSE channels are single-writer (one process owns
 * the channel).
 *
 * TCP socket handles backpressure - if client reads slowly, write() blocks
 * until buffer space available. This prevents server from overwhelming slow
 * clients.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: headersSent flag prevents duplicate header writes
 * RC-2: closed flag checked in push() before socket operations
 * RC-3: Socket.write() failures are allowed to throw (caller handles)
 * RC-4: close() closes socket which fails pending writes
 *
 * MEMORY MANAGEMENT
 * =================
 * - Channel owns socket (must close it)
 * - TextEncoder is reused for all events (no allocation per event)
 * - Events are encoded to UTF-8 bytes then written to socket
 * - close() closes socket which releases file descriptor
 *
 * @module hal/channel/sse
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Socket } from '../network/types.js';
import type { Channel, ChannelOpts } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * SSE server channel (server pushes to client).
 *
 * WHY: SSE provides real-time updates without WebSocket complexity. Works
 * through HTTP proxies and firewalls that block WebSocket upgrades.
 *
 * TESTABILITY: Can be mocked by providing test socket that captures writes.
 * Tests verify SSE format (event: lines, data: lines, blank separators).
 */
export class BunSSEServerChannel implements Channel {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique channel identifier.
     *
     * WHY: Enables kernel to track channels in handle tables and correlate
     * events in logs. Useful for debugging client disconnect issues.
     *
     * INVARIANT: Set once at construction, never changes.
     */
    readonly id = randomUUID();

    /**
     * Protocol type.
     *
     * WHY: Identifies this as an SSE channel for kernel dispatch and logging.
     *
     * INVARIANT: Always 'sse'.
     */
    readonly proto = 'sse';

    /**
     * Human-readable description.
     *
     * WHY: Shows 'sse:server' in logs to distinguish from potential client.
     * Currently no SSE client implementation (use HTTP channel instead).
     */
    readonly description = 'sse:server';

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Underlying TCP socket.
     *
     * WHY: Socket is already accepted by listener. We write HTTP headers
     * and SSE events directly to socket without HTTP framework overhead.
     *
     * INVARIANT: Non-null until close() is called, then unusable.
     */
    private socket: Socket;

    /**
     * Text encoder for UTF-8 conversion.
     *
     * WHY: Reused for all event encoding. Creating once saves allocations.
     * SSE spec requires UTF-8 encoding.
     */
    private encoder = new TextEncoder();

    /**
     * Whether channel is closed.
     *
     * WHY: Fast-path check to reject operations after close(). Prevents
     * push() on closed socket (would throw).
     *
     * INVARIANT: Once true, never becomes false.
     */
    private _closed = false;

    /**
     * Whether HTTP headers have been sent.
     *
     * WHY: Headers must be sent exactly once, before first event. This flag
     * prevents duplicate headers if push() is called multiple times.
     *
     * INVARIANT: Once true, never becomes false. Set by first push() call.
     */
    private headersSent = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create SSE server channel.
     *
     * WHY: Wraps already-accepted socket with SSE formatting. Socket is
     * owned by this channel and must be closed when done.
     *
     * @param socket - Already-accepted TCP socket from listener
     * @param _opts - Channel options (currently unused for SSE)
     */
    constructor(socket: Socket, _opts?: ChannelOpts) {
        this.socket = socket;
    }

    // =========================================================================
    // PROPERTIES
    // =========================================================================

    /**
     * Check if channel is closed.
     *
     * WHY: Exposed as property for fast kernel checks without method call overhead.
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // MESSAGE HANDLING (NOT USED FOR SSE)
    // =========================================================================

    /**
     * Handle incoming message (not supported for SSE).
     *
     * WHY: SSE is server-to-client push only. Client cannot send messages
     * back through SSE connection. Use push() instead.
     *
     * ERROR HANDLING: Always yields error - this method should never be called
     * for SSE channels. Kernel should use push() instead.
     *
     * @param _msg - Ignored (SSE doesn't handle incoming messages)
     * @returns Error response
     */
    async *handle(_msg: Message): AsyncIterable<Response> {
        // WHY: SSE server channels are write-only. Client reads events but
        // cannot send messages back. Bidirectional communication requires WebSocket.
        yield respond.error('EINVAL', 'Use push() for SSE server channels');
    }

    // =========================================================================
    // EVENT PUSHING
    // =========================================================================

    /**
     * Push event to client.
     *
     * WHY: SSE channels are write-only (server pushes to client). This method
     * formats Response as SSE event and writes to socket.
     *
     * ALGORITHM:
     * 1. Check closed state
     * 2. Send HTTP headers on first push
     * 3. Format response as SSE event
     * 4. Encode to UTF-8 bytes
     * 5. Write to socket
     *
     * SSE FORMAT:
     * - event: type\n (if response.op is 'event')
     * - data: json\n
     * - \n (blank line ends event)
     *
     * RACE CONDITION:
     * headersSent check and write are not atomic. If two push() calls happen
     * simultaneously, both might send headers. Socket.write() serializes writes
     * so data won't interleave, but duplicate headers would break protocol.
     * Caller must serialize push() calls if this is a concern.
     *
     * ERROR HANDLING:
     * - Closed channel: throws Error
     * - Socket write failure: throws (propagates to caller)
     *
     * @param response - Response to push as SSE event
     * @throws Error if channel is closed or socket write fails
     */
    async push(response: Response): Promise<void> {
        // RACE FIX: Check closed before any socket operations
        if (this._closed) {
            throw new Error('Channel closed');
        }

        // WHY: HTTP headers must be sent once, before first event. Headers
        // establish HTTP 200 status and text/event-stream content type.
        if (!this.headersSent) {
            const headers = [
                'HTTP/1.1 200 OK',
                'Content-Type: text/event-stream', // SSE content type
                'Cache-Control: no-cache',         // Prevent proxy caching
                'Connection: keep-alive',          // Keep connection open
                '',                                // Blank line ends headers
                '',                                // Start of body
            ].join('\r\n');
            await this.socket.write(this.encoder.encode(headers));
            this.headersSent = true;
        }

        // WHY: Format response as SSE event. If response.op is 'event', use
        // event.type from data. Otherwise, use default 'message' type.
        let eventData: string;
        if (response.op === 'event') {
            const eventPayload = response.data as { type: string; [key: string]: unknown };
            // WHY: SSE format requires 'event:' line for custom types. Data is
            // always JSON-serialized (could be raw string but JSON is safer).
            eventData = `event: ${eventPayload.type}\ndata: ${JSON.stringify(response.data)}\n\n`;
        } else {
            // WHY: Default event type (no 'event:' line). Data is JSON-serialized.
            eventData = `data: ${JSON.stringify(response.data)}\n\n`;
        }

        // WHY: Encode to UTF-8 and write to socket. await ensures write completes
        // before returning. If socket is full, this blocks (backpressure).
        await this.socket.write(this.encoder.encode(eventData));
    }

    // =========================================================================
    // UNSUPPORTED OPERATIONS
    // =========================================================================

    /**
     * Receive not supported (SSE is server-to-client push only).
     *
     * WHY: SSE is unidirectional. Client receives events but cannot send
     * messages back through SSE connection.
     */
    async recv(): Promise<Message> {
        throw new Error('SSE server channels do not support recv');
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close channel and underlying socket.
     *
     * WHY: Releases socket file descriptor and terminates client connection.
     * Client will receive connection close event.
     *
     * ALGORITHM:
     * 1. Set closed flag (rejects new push() calls)
     * 2. Close socket (sends TCP FIN)
     * 3. Return (socket cleaned up)
     *
     * INVARIANT: Idempotent - safe to call multiple times (socket handles this).
     *
     * RACE CONDITION:
     * If push() is in flight, socket.close() may interrupt write. Socket
     * layer handles this gracefully (write fails, close succeeds).
     */
    async close(): Promise<void> {
        this._closed = true;
        // WHY: Socket close sends TCP FIN to client and releases file descriptor.
        // Client EventSource will fire 'error' event and can reconnect if needed.
        await this.socket.close();
    }
}
