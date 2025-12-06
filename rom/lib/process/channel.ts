/**
 * Channel Library - Protocol-aware bidirectional message exchange
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Channels provide a unified interface for protocol-aware communication with
 * external services. Unlike raw sockets, channels understand the underlying
 * protocol (HTTP, WebSocket, PostgreSQL, SQLite) and handle framing, encoding,
 * and connection lifecycle automatically.
 *
 * The channel abstraction is inspired by Go's channels but adapted for
 * message-based communication with external services:
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │                         Process (Userland)                          │
 *   │                                                                     │
 *   │  const ch = await channel.open('http', 'https://api.example.com'); │
 *   │  const resp = await channel.call(ch, { op: 'request', ... });      │
 *   │  await channel.close(ch);                                           │
 *   │                                                                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *                                    │
 *                                    ▼ (syscalls)
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │                            Kernel                                   │
 *   │                                                                     │
 *   │  - Manages channel lifecycle                                        │
 *   │  - Routes messages to protocol handlers                             │
 *   │  - Handles connection pooling                                       │
 *   │                                                                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *                                    │
 *                                    ▼ (HAL)
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │                     Protocol Handlers                               │
 *   │                                                                     │
 *   │  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐             │
 *   │  │  HTTP   │  │ WebSocket │  │ Postgres │  │ SQLite │             │
 *   │  └─────────┘  └───────────┘  └──────────┘  └────────┘             │
 *   │                                                                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * COMMUNICATION PATTERNS
 * ======================
 * 1. Request/Response (call): Send message, receive single response
 *    - HTTP requests
 *    - Database queries (non-streaming)
 *
 * 2. Streaming (stream): Send message, receive multiple responses
 *    - Database cursors
 *    - SSE subscriptions
 *    - Paginated results
 *
 * 3. Bidirectional (push/recv): Both sides can send at any time
 *    - WebSocket communication
 *    - Server-side event sources
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Channel IDs are valid only within the creating process
 * INV-2: Closed channels reject all operations with EBADF
 * INV-3: Streaming terminates on 'done', 'ok', or 'error' response
 *
 * CONCURRENCY MODEL
 * =================
 * Channels are process-local resources. Multiple concurrent operations on
 * the same channel are serialized by the kernel. Different channels can
 * operate in parallel.
 *
 * MEMORY MANAGEMENT
 * =================
 * - Channel state is held by kernel (process has just the ID)
 * - Streaming responses are yielded lazily (no buffering in process)
 * - Close releases kernel-side resources
 *
 * @module process/channel
 */

import { syscall } from './syscall.js';
import { fromCode } from '../errors.js';
import type { Message, Response } from './types.js';

// =============================================================================
// SYSCALL RESPONSE HELPERS
// =============================================================================

/**
 * Consume a syscall stream expecting a single value response.
 */
async function unwrap<T>(stream: AsyncIterable<Response>): Promise<T> {
    for await (const r of stream) {
        if (r.op === 'ok') {
            return r.data as T;
        }

        if (r.op === 'error') {
            const err = r.data as { code: string; message: string };

            throw fromCode(err.code, err.message);
        }

        throw new Error(`Unexpected response op '${r.op}' for single-value syscall`);
    }

    throw new Error('Unexpected end of syscall stream');
}

/**
 * Consume a syscall stream expecting a void response.
 */
async function unwrapVoid(stream: AsyncIterable<Response>): Promise<void> {
    for await (const r of stream) {
        if (r.op === 'ok') {
            return;
        }

        if (r.op === 'error') {
            const err = r.data as { code: string; message: string };

            throw fromCode(err.code, err.message);
        }

        throw new Error(`Unexpected response op '${r.op}' for void syscall`);
    }

    throw new Error('Unexpected end of syscall stream');
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Channel configuration options.
 *
 * Options vary by protocol type. Unknown options are ignored.
 */
export interface ChannelOpts {
    // -------------------------------------------------------------------------
    // HTTP Options
    // -------------------------------------------------------------------------

    /**
     * Default headers for all requests.
     *
     * WHY: Common headers like Authorization can be set once at channel open.
     */
    headers?: Record<string, string>;

    /**
     * Keep underlying connection alive between requests.
     *
     * WHY: HTTP/1.1 keep-alive reduces connection overhead.
     */
    keepAlive?: boolean;

    /**
     * Request timeout in milliseconds.
     *
     * WHY: Prevents hanging on unresponsive servers.
     */
    timeout?: number;

    // -------------------------------------------------------------------------
    // Database Options
    // -------------------------------------------------------------------------

    /**
     * Database name (PostgreSQL).
     *
     * WHY: PostgreSQL connections are database-specific.
     */
    database?: string;

    /**
     * Open in read-only mode (SQLite).
     *
     * WHY: Prevents accidental writes to shared databases.
     */
    readonly?: boolean;

    /**
     * Create database file if missing (SQLite).
     *
     * WHY: Allows explicit control over file creation (default: true).
     */
    create?: boolean;
}

// =============================================================================
// CHANNEL API
// =============================================================================

/**
 * Channel API namespace.
 *
 * Provides protocol-aware message passing over persistent connections.
 * All methods are async and throw typed errors on failure.
 */
export const channel = {
    /**
     * Open a channel to a remote service.
     *
     * ALGORITHM:
     * 1. Validate protocol type
     * 2. Create channel via kernel syscall
     * 3. Return channel ID for subsequent operations
     *
     * @param proto - Protocol type (http, https, websocket, postgres, sqlite)
     * @param url - Connection URL or file path
     * @param opts - Protocol-specific options
     * @returns Channel ID (number)
     * @throws EINVAL - If protocol is not supported
     * @throws ECONNREFUSED - If connection fails
     *
     * @example
     * // HTTP channel with auth header
     * const api = await channel.open('http', 'https://api.example.com', {
     *     headers: { 'Authorization': 'Bearer token' },
     *     timeout: 30000
     * });
     *
     * // SQLite channel
     * const db = await channel.open('sqlite', './data.db', {
     *     readonly: true
     * });
     */
    async open(proto: string, url: string, opts?: ChannelOpts): Promise<number> {
        return unwrap<number>(syscall('channel:open', proto, url, opts));
    },

    /**
     * Send a request and receive a single response.
     *
     * Waits for the first response from the channel (ok or error).
     * Use this for request/response patterns like HTTP or single-result queries.
     *
     * ALGORITHM:
     * 1. Send message via kernel
     * 2. Wait for response
     * 3. Return response (may be ok or error)
     *
     * @param ch - Channel ID from open()
     * @param msg - Message to send
     * @returns Response from service
     * @throws EBADF - If channel is closed
     * @throws ETIMEDOUT - If request times out
     *
     * @example
     * const response = await channel.call(ch, {
     *     op: 'request',
     *     data: { method: 'GET', path: '/users' }
     * });
     * if (response.op === 'ok') {
     *     console.log(response.data);
     * }
     */
    async call<T = unknown>(ch: number, msg: Message): Promise<Response & { data?: T }> {
        return unwrap<Response & { data?: T }>(syscall('channel:call', ch, msg));
    },

    /**
     * Send a request and iterate streaming responses.
     *
     * Returns an async iterable that yields responses until terminal op.
     * Use for streaming patterns like database cursors or SSE.
     *
     * ALGORITHM:
     * 1. Send message via kernel
     * 2. Yield responses as they arrive
     * 3. Stop on 'done', 'ok', or 'error' response
     *
     * WHY async iterable: Natural fit for consuming streams. Allows
     * backpressure and early termination via break.
     *
     * @param ch - Channel ID from open()
     * @param msg - Message to send
     * @yields Response objects from service
     *
     * @example
     * for await (const response of channel.stream(ch, {
     *     op: 'query',
     *     data: { sql: 'SELECT * FROM users', cursor: true }
     * })) {
     *     if (response.op === 'item') {
     *         processRow(response.data);
     *     }
     * }
     */
    stream(ch: number, msg: Message): AsyncIterable<Response> {
        return syscall('channel:stream', ch, msg);
    },

    /**
     * Push a response to the remote (server-side channels).
     *
     * Used for SSE and WebSocket server channels to send data to clients.
     * This is the "send" side of bidirectional communication.
     *
     * @param ch - Channel ID
     * @param response - Response to push to client
     * @throws EBADF - If channel is closed
     * @throws EPIPE - If client disconnected
     *
     * @example
     * // SSE server pushing events
     * await channel.push(sseChannel, {
     *     op: 'event',
     *     data: { type: 'update', payload: { ... } }
     * });
     */
    async push(ch: number, response: Response): Promise<void> {
        return unwrapVoid(syscall('channel:push', ch, response));
    },

    /**
     * Receive a message from the remote (bidirectional channels).
     *
     * Used for WebSocket channels to receive messages from clients.
     * Blocks until a message is available.
     *
     * WHY blocking: Matches traditional socket recv() semantics.
     * Use with caution in single-threaded contexts.
     *
     * @param ch - Channel ID
     * @returns Message from remote
     * @throws EBADF - If channel is closed
     *
     * @example
     * // WebSocket server receiving messages
     * while (true) {
     *     const msg = await channel.recv(wsChannel);
     *     if (msg.op === 'close') break;
     *     await handleMessage(msg);
     * }
     */
    async recv(ch: number): Promise<Message> {
        return unwrap<Message>(syscall('channel:recv', ch));
    },

    /**
     * Close a channel.
     *
     * Releases kernel-side resources and closes underlying connection.
     * Safe to call multiple times (idempotent).
     *
     * @param ch - Channel ID
     *
     * @example
     * await channel.close(ch);
     */
    async close(ch: number): Promise<void> {
        return unwrapVoid(syscall('channel:close', ch));
    },
};

// =============================================================================
// HTTP HELPERS
// =============================================================================

/**
 * HTTP request structure.
 *
 * Convenience type for HTTP channel requests. Matches the data format
 * expected by the HTTP channel handler.
 */
export interface HttpRequest {
    /** HTTP method (GET, POST, PUT, DELETE, etc.) */
    method: string;

    /** Request path (e.g., '/users/123') */
    path: string;

    /** Query parameters (appended to URL) */
    query?: Record<string, unknown>;

    /** Request headers (merged with channel defaults) */
    headers?: Record<string, string>;

    /** Request body (JSON serialized) */
    body?: unknown;

    /** Accept header value (e.g., 'application/json') */
    accept?: string;
}

/**
 * Create an HTTP request message.
 *
 * Helper to construct properly formatted HTTP request messages.
 *
 * @param request - HTTP request parameters
 * @returns Message for channel.call()
 *
 * @example
 * const msg = httpRequest({ method: 'GET', path: '/users' });
 * const response = await channel.call(ch, msg);
 */
export function httpRequest(request: HttpRequest): Message {
    return { op: 'request', data: request };
}

// =============================================================================
// SQL HELPERS
// =============================================================================

/**
 * Create a SQL query message.
 *
 * Helper to construct properly formatted SQL query messages.
 * Works with both PostgreSQL and SQLite channels.
 *
 * @param sql - SQL query string (use $1, $2 for params in Postgres)
 * @param params - Query parameters (positional)
 * @param cursor - Whether to use cursor for streaming (large result sets)
 * @returns Message for channel.call() or channel.stream()
 *
 * @example
 * // Single result
 * const msg = sqlQuery('SELECT * FROM users WHERE id = $1', [userId]);
 * const response = await channel.call(db, msg);
 *
 * // Streaming results
 * const msg = sqlQuery('SELECT * FROM logs', [], true);
 * for await (const row of channel.stream(db, msg)) { ... }
 */
export function sqlQuery(sql: string, params?: unknown[], cursor?: boolean): Message {
    return { op: 'query', data: { sql, params, cursor } };
}

/**
 * Create a SQL execute message (DDL, no results).
 *
 * Helper for statements that don't return results (CREATE, DROP, etc.).
 *
 * @param sql - SQL statement
 * @returns Message for channel.call()
 *
 * @example
 * await channel.call(db, sqlExecute('CREATE TABLE users (id INT, name TEXT)'));
 */
export function sqlExecute(sql: string): Message {
    return { op: 'execute', data: { sql } };
}
