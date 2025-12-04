/**
 * Channel Types - Protocol-aware communication interfaces
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines the core Channel interface and related types for Monk OS's
 * protocol-aware communication layer. Channels are HAL-level abstractions that
 * wrap application protocols (HTTP, WebSocket, SQL, SSE) and expose unified
 * message-based interfaces.
 *
 * Unlike raw sockets (byte streams) or file handles (generic I/O), channels
 * understand protocol semantics:
 * - HTTP: Methods, headers, status codes, streaming responses
 * - WebSocket: Bidirectional messages, connection lifecycle
 * - PostgreSQL/SQLite: SQL queries, result sets, transactions
 * - SSE: Server-to-client event streams
 *
 * This design enables processes to communicate with external systems using
 * high-level operations without implementing protocol parsers or dealing with
 * wire formats. The kernel maps channel operations to handle exec() calls.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Channel.id is unique across all channels in the system
 * INV-2: Channel.proto never changes after construction
 * INV-3: Once closed=true, handle() must reject with error response
 * INV-4: handle() always yields at least one response (ok, error, or done)
 * INV-5: push() and recv() behavior depends on protocol (not all support both)
 *
 * CONCURRENCY MODEL
 * =================
 * Channels are protocol-specific wrappers around connections. Multiple processes
 * may call handle(), push(), or recv() concurrently. Channel implementations
 * must handle concurrent access safely:
 *
 * - HTTP: Each request is independent (fetch() manages connection pooling)
 * - WebSocket: Messages may interleave (queue if order matters)
 * - SQL: Queries are serialized by database (PostgreSQL/SQLite handle locking)
 * - SSE: Server pushes are serialized by TCP (socket write queue)
 *
 * The Channel interface provides no concurrency control - implementations
 * choose appropriate strategies for their protocols.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Implementations must check closed state before operations
 * RC-2: close() must be safe to call at any time (idempotent)
 * RC-3: Protocol-specific connection races handled by implementations
 * RC-4: Kernel revokes channels on process exit to prevent use-after-free
 *
 * MEMORY MANAGEMENT
 * =================
 * - Channels own their connections (network sockets, database handles, etc.)
 * - close() must release all resources
 * - Kernel calls close() on all channels when process exits
 * - Streaming responses should support cancellation (stop iteration early)
 *
 * TESTABILITY
 * ===========
 * The Channel interface is designed for testability:
 *
 * - Mock channels can be created by implementing the interface
 * - closed property allows tests to verify cleanup
 * - description enables human-readable test assertions
 * - Proto string enables protocol-specific test logic
 *
 * @module hal/channel/types
 */

import type { Message, Response } from '@src/message.js';
import type { Socket } from '../network/types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Channel options for protocol-specific configuration.
 *
 * WHY: Different protocols need different options. Union type would be complex
 * and rigid. Optional properties provide flexibility while maintaining type safety.
 *
 * DESIGN: Properties are protocol-specific. Unused properties are ignored.
 * This enables adding new protocols without breaking existing code.
 */
export interface ChannelOpts {
    /**
     * Default HTTP headers (HTTP only).
     *
     * WHY: Common headers (auth, accept, etc.) can be set once per channel
     * instead of repeating in every request.
     */
    headers?: Record<string, string>;

    /**
     * Keep connection alive (HTTP, WebSocket).
     *
     * WHY: Enables connection reuse. HTTP/1.1 default is keep-alive, but
     * this allows explicit control.
     */
    keepAlive?: boolean;

    /**
     * Request timeout in milliseconds (HTTP, WebSocket).
     *
     * WHY: Prevents requests from hanging indefinitely on unresponsive servers.
     * Uses AbortController internally.
     */
    timeout?: number;

    /**
     * Database name (PostgreSQL only).
     *
     * WHY: PostgreSQL connection URLs may omit database name. This allows
     * specifying it separately from URL.
     */
    database?: string;

    /**
     * Open database read-only (SQLite only).
     *
     * WHY: Read-only mode prevents accidental writes and enables better
     * concurrency (no write locks).
     */
    readonly?: boolean;

    /**
     * Create file if missing (SQLite only, default: true).
     *
     * WHY: Control whether SQLite creates database file or fails if missing.
     * Tests often want to fail if database doesn't exist.
     */
    create?: boolean;
}

/**
 * Channel interface for protocol-aware message passing.
 *
 * WHY: Unified interface for all protocol channels. Kernel can dispatch
 * operations without knowing concrete protocol implementation.
 *
 * DESIGN RATIONALE:
 * - Message-based (not method-based) enables protocol extensibility
 * - handle() returns AsyncIterable for streaming responses
 * - push() and recv() support bidirectional protocols (WebSocket)
 * - closed property enables fast-path checks without async calls
 *
 * INVARIANTS:
 * - id is unique across all channels
 * - proto never changes
 * - Once closed=true, operations must fail
 * - close() is idempotent
 */
export interface Channel {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique channel identifier.
     *
     * WHY: Allows kernel to track channels in tables, revoke on process exit,
     * and correlate channels across operations.
     *
     * INVARIANT: Unique across all channels in the system.
     *
     * FORMAT: Typically a UUID, but implementation-defined.
     */
    readonly id: string;

    /**
     * Protocol type.
     *
     * WHY: Enables kernel to dispatch based on protocol without instanceof.
     * For example, SQL channels might require transaction tracking while
     * HTTP channels might require rate limiting.
     *
     * INVARIANT: Never changes after construction.
     *
     * EXAMPLES: 'http', 'websocket', 'postgres', 'sqlite', 'sse'
     */
    readonly proto: string;

    /**
     * Human-readable description.
     *
     * WHY: Used in error messages, debugging output, and process listings.
     * Should identify what this channel represents.
     *
     * EXAMPLES:
     * - HTTP: "https://api.example.com"
     * - WebSocket: "wss://example.com/ws"
     * - PostgreSQL: "postgresql://localhost:5432/mydb"
     * - SQLite: "/var/db/app.sqlite"
     * - SSE: "sse:server"
     *
     * INVARIANT: Non-empty string.
     */
    readonly description: string;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether the channel is closed.
     *
     * WHY: Provides fast-path check without async call. Allows kernel to
     * skip operations entirely if channel is already closed.
     *
     * INVARIANT: Once true, never becomes false again.
     */
    readonly closed: boolean;

    // =========================================================================
    // OPERATIONS
    // =========================================================================

    /**
     * Handle a message operation on this channel.
     *
     * WHY: Unified interface for protocol-agnostic dispatch. Kernel can route
     * messages to any channel without knowing protocol details.
     *
     * ALGORITHM:
     * 1. Validate msg structure
     * 2. Check closed state
     * 3. Dispatch based on msg.op (protocol-specific)
     * 4. Yield Response messages
     * 5. Always yield at least one Response (even if error)
     *
     * COMMON OPERATIONS (protocol-dependent):
     * - request: HTTP request (method, path, body)
     * - query: SQL SELECT (returns rows)
     * - execute: SQL INSERT/UPDATE/DELETE (returns affected rows)
     * - send: Send message (WebSocket)
     * - recv: Receive message (WebSocket)
     *
     * RESPONSE PATTERNS:
     * - Single value: yield ok(data)
     * - Streaming: yield item(data) per item, then done()
     * - Error: yield error(code, message)
     *
     * RACE CONDITION:
     * Multiple processes may call handle() concurrently. Channel implementations
     * must either serialize operations or support concurrent access safely.
     * The caller will iterate the returned AsyncIterable and may stop at any
     * time (e.g., if process is killed).
     *
     * ERROR HANDLING:
     * - Unknown operations should yield respond.error('EINVAL', 'Unknown op')
     * - Closed channels should yield respond.error('EBADF', 'Channel closed')
     * - Protocol errors use appropriate error codes (EIO, ETIMEDOUT, etc.)
     * - Must not throw exceptions - always yield error responses
     *
     * @param msg - Message containing operation (msg.op) and data (msg.data)
     * @returns Async iterable of responses (must yield at least one)
     */
    handle(msg: Message): AsyncIterable<Response>;

    /**
     * Push a response to remote (server-side).
     *
     * WHY: Server-side channels (SSE, WebSocket server) need to push messages
     * to clients. Unlike handle() which responds to requests, push() initiates
     * message send.
     *
     * ALGORITHM:
     * 1. Check closed state
     * 2. Format response per protocol (JSON, SSE, WebSocket frame)
     * 3. Write to connection
     * 4. Handle backpressure (block if buffer full)
     *
     * SUPPORTED PROTOCOLS:
     * - SSE: Push events to client (one-way)
     * - WebSocket: Push messages to client (bidirectional)
     * - HTTP/SQL: Not supported (throw error)
     *
     * ERROR HANDLING:
     * - Closed channel: throw Error
     * - Unsupported protocol: throw Error
     * - Network error: throw Error (propagates to caller)
     *
     * @param response - Response to push
     * @throws Error if channel is closed or protocol doesn't support push
     */
    push(response: Response): Promise<void>;

    /**
     * Receive a message from remote (bidirectional).
     *
     * WHY: Bidirectional channels (WebSocket) need to receive messages initiated
     * by remote. Unlike handle() which responds to kernel messages, recv() waits
     * for network messages.
     *
     * ALGORITHM:
     * 1. Check closed state
     * 2. Wait for network message
     * 3. Parse per protocol (JSON, WebSocket frame)
     * 4. Return as Message
     *
     * SUPPORTED PROTOCOLS:
     * - WebSocket: Receive messages from remote (bidirectional)
     * - HTTP/SQL/SSE: Not supported (throw error)
     *
     * ERROR HANDLING:
     * - Closed channel: return { op: 'close', data: null }
     * - Unsupported protocol: throw Error
     * - Network error: throw Error (propagates to caller)
     *
     * @returns Message from remote
     * @throws Error if protocol doesn't support recv
     */
    recv(): Promise<Message>;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close the channel and release resources.
     *
     * WHY: Channels own connections and must release them. Kernel calls this
     * on process exit to prevent resource leaks.
     *
     * ALGORITHM:
     * 1. Set closed=true
     * 2. Close connection (TCP socket, database handle, etc.)
     * 3. Cancel pending operations (best-effort)
     * 4. Release resources
     *
     * INVARIANTS:
     * - Must be idempotent (safe to call multiple times)
     * - After close(), closed must be true
     * - After close(), handle() must fail with EBADF
     *
     * RACE CONDITION:
     * close() may be called while handle() is running. Implementations should:
     * - Set closed flag first (stops new operations)
     * - Allow in-flight operations to complete or fail gracefully
     * - Release resources last (prevents use-after-free)
     *
     * ERROR HANDLING:
     * Should not throw exceptions. Log errors internally but always complete
     * successfully. This ensures process cleanup can't be blocked by failed
     * channel cleanup.
     *
     * @returns Promise that resolves when cleanup is complete
     */
    close(): Promise<void>;
}

/**
 * Channel device interface.
 *
 * WHY: HAL provides channel creation for both client and server sides.
 * Centralizes protocol dispatch and simplifies kernel implementation.
 *
 * TESTABILITY: Device can be mocked to inject test channels or simulate
 * connection failures.
 */
export interface ChannelDevice {
    /**
     * Open a channel as client.
     *
     * WHY: Client mode initiates connections to remote endpoints. Each protocol
     * has different connection semantics (TCP handshake, HTTP request, SQL login)
     * but all present a unified Channel interface.
     *
     * ALGORITHM:
     * 1. Parse protocol string
     * 2. Create protocol-specific channel implementation
     * 3. Initiate connection (may be lazy)
     * 4. Return channel (caller owns lifecycle)
     *
     * SUPPORTED PROTOCOLS:
     * - http/https: HTTP client via fetch()
     * - websocket/ws/wss: WebSocket client
     * - postgres/postgresql: PostgreSQL via Bun.SQL
     * - sqlite: SQLite via bun:sqlite
     *
     * ERROR HANDLING:
     * - Unsupported protocol: throw Error (fail-fast)
     * - Connection failure: may throw or fail lazily on first operation
     *
     * @param proto - Protocol type (case-sensitive)
     * @param url - Connection URL or path
     * @param opts - Protocol-specific options
     * @returns Channel instance (caller must close)
     * @throws Error if protocol is unsupported
     */
    open(proto: string, url: string, opts?: ChannelOpts): Promise<Channel>;

    /**
     * Wrap an accepted socket as server-side channel.
     *
     * WHY: Server-side channels wrap already-accepted TCP sockets with protocol
     * handlers. This separation enables socket acceptance (TCP handshake) to
     * happen in the network layer while protocol handling happens here.
     *
     * ALGORITHM:
     * 1. Socket is already accepted (TCP established)
     * 2. Wrap with protocol-specific channel implementation
     * 3. Return channel (caller owns lifecycle)
     *
     * SUPPORTED PROTOCOLS:
     * - sse: Server-Sent Events (one-way push)
     * - websocket: Requires HTTP upgrade first (error for now)
     *
     * ERROR HANDLING:
     * - Unsupported protocol: throw Error (fail-fast)
     * - Socket already has data: channel must handle buffered data
     *
     * @param socket - Already-accepted TCP socket
     * @param proto - Protocol to layer on socket
     * @param opts - Protocol-specific options
     * @returns Channel instance (caller must close)
     * @throws Error if protocol is unsupported or requires HTTP upgrade
     */
    accept(socket: Socket, proto: string, opts?: ChannelOpts): Promise<Channel>;
}

// =============================================================================
// PROTOCOL-SPECIFIC TYPES
// =============================================================================

/**
 * HTTP request data.
 *
 * WHY: Structured representation of HTTP request. Maps to fetch() options
 * but hides implementation details from userland.
 *
 * DESIGN: Includes common HTTP semantics (method, path, headers, body).
 * Query params are separate to simplify URL construction.
 */
export interface HttpRequest {
    /**
     * HTTP method (GET, POST, PUT, DELETE, etc.).
     *
     * WHY: Standard HTTP methods. Uppercase per convention.
     */
    method: string;

    /**
     * Request path (can be relative to channel baseUrl).
     *
     * WHY: Relative paths simplify API clients - no need to repeat host.
     */
    path: string;

    /**
     * Query parameters (appended to path as ?key=value&...).
     *
     * WHY: Separate from path for clean API. Handles encoding automatically.
     */
    query?: Record<string, unknown>;

    /**
     * HTTP headers (merged with channel default headers).
     *
     * WHY: Per-request headers override channel defaults. Common pattern
     * for auth, content negotiation, etc.
     */
    headers?: Record<string, string>;

    /**
     * Request body (JSON-serialized automatically).
     *
     * WHY: High-level API - no need for manual JSON.stringify().
     * Channel handles Content-Type header.
     */
    body?: unknown;

    /**
     * Accept header (for content negotiation).
     *
     * WHY: Determines response handling (JSONL streaming, SSE, JSON).
     * Shorthand for headers['Accept'].
     */
    accept?: string;
}

/**
 * Query data for database channels.
 *
 * WHY: Unified interface for SQL queries across PostgreSQL and SQLite.
 * Uses positional parameters (?) for consistency.
 */
export interface QueryData {
    /**
     * SQL query string.
     *
     * WHY: Raw SQL provides full database feature access. Uses ? placeholders
     * for parameters (converted to $1, $2 for PostgreSQL).
     */
    sql: string;

    /**
     * Query parameters (positional, not named).
     *
     * WHY: Positional params are universal (SQLite and PostgreSQL).
     * Named params would require dialect-specific parsing.
     */
    params?: unknown[];
}

/**
 * Single statement within a transaction.
 *
 * WHY: Transactions contain multiple statements that must execute atomically.
 * Each statement has its own SQL and parameters.
 */
export interface TransactionStatement {
    /**
     * SQL statement string.
     *
     * WHY: Same format as QueryData.sql - uses ? placeholders.
     */
    sql: string;

    /**
     * Statement parameters (positional).
     *
     * WHY: Same format as QueryData.params - positional for portability.
     */
    params?: unknown[];
}

/**
 * Transaction data for atomic multi-statement execution.
 *
 * WHY: Enables atomic execution of multiple SQL statements. All statements
 * succeed or all are rolled back. Solves parallel write conflicts by making
 * the transaction a single message to the channel.
 *
 * DESIGN: Array of statements executed in order within BEGIN/COMMIT.
 * Channel handles transaction semantics using Bun's sql.begin() API.
 */
export interface TransactionData {
    /**
     * Statements to execute atomically.
     *
     * WHY: Order matters - statements execute sequentially within transaction.
     * All must succeed for commit; any failure triggers rollback.
     */
    statements: TransactionStatement[];
}

/**
 * Transaction result with per-statement affected row counts.
 *
 * WHY: Callers may need to know how many rows each statement affected.
 * Returns array parallel to input statements array.
 */
export interface TransactionResult {
    /**
     * Affected row counts per statement.
     *
     * WHY: One count per statement in same order as input.
     * SELECT statements return 0 (use query op for SELECTs).
     */
    results: number[];
}
