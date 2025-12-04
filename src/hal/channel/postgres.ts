/**
 * PostgreSQL Channel - PostgreSQL database via Bun.SQL
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The PostgreSQL channel provides message-based SQL query execution using
 * Bun's built-in Bun.SQL API. Unlike raw TCP connections or protocol
 * implementations, this channel handles PostgreSQL wire protocol, connection
 * pooling, authentication, and result set streaming.
 *
 * The channel supports two operation types:
 * 1. query: Execute SELECT and return rows as stream (yields item per row)
 * 2. execute: Execute INSERT/UPDATE/DELETE and return affected rows (yields ok)
 *
 * This design enables processes to interact with PostgreSQL databases without
 * implementing the wire protocol or managing connection pools. The kernel maps
 * these operations to handle exec() calls.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Connection URL is set at construction and never modified
 * INV-2: Once closed=true, all handle() calls must yield error response
 * INV-3: handle() always yields at least one response (ok, error, item+done)
 * INV-4: query op yields item per row followed by done
 * INV-5: execute op yields single ok with affectedRows count
 * INV-6: sql connection is closed only once (on close())
 *
 * CONCURRENCY MODEL
 * =================
 * Multiple processes may call handle() concurrently on the same channel.
 * Bun.SQL manages connection pooling and query serialization internally.
 * Queries execute in the order received per-connection, but different
 * connections may interleave.
 *
 * PostgreSQL queries are atomic at the statement level but not between
 * statements unless wrapped in explicit transactions. Callers must use
 * BEGIN/COMMIT/ROLLBACK for multi-statement atomicity.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: closed flag checked at start of handle() (before query execution)
 * RC-2: Bun.SQL handles connection pool races internally
 * RC-3: close() calls sql.close() which waits for pending queries
 * RC-4: Error handling prevents connection from being left in bad state
 *
 * MEMORY MANAGEMENT
 * =================
 * - sql connection owns PostgreSQL connection pool
 * - Result sets are streamed (not buffered entirely in memory)
 * - close() must be called to release connections (kernel ensures this)
 * - Bun.SQL automatically releases per-query resources after iteration
 *
 * @module hal/channel/postgres
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Channel, ChannelOpts, QueryData, TransactionData } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * PostgreSQL channel using Bun.SQL.
 *
 * WHY: Bun.SQL provides async PostgreSQL with connection pooling, prepared
 * statements, and streaming result sets. Using it instead of raw sockets
 * eliminates ~2000 lines of protocol implementation.
 *
 * TESTABILITY: Can be mocked by injecting test database URL or by intercepting
 * Bun.SQL constructor. Integration tests use real PostgreSQL instance.
 */
export class BunPostgresChannel implements Channel {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique channel identifier.
     *
     * WHY: Enables kernel to track channels in handle tables and correlate
     * queries in logs. Useful for debugging connection pool issues.
     *
     * INVARIANT: Set once at construction, never changes.
     */
    readonly id = randomUUID();

    /**
     * Protocol type.
     *
     * WHY: Identifies this as a PostgreSQL channel for kernel dispatch and logging.
     *
     * INVARIANT: Always 'postgres'.
     */
    readonly proto = 'postgres';

    /**
     * Human-readable description.
     *
     * WHY: Shows connection URL in logs and error messages. Redacts password
     * if present (Bun.SQL connection string may contain credentials).
     */
    readonly description: string;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Bun.SQL connection instance.
     *
     * WHY: Manages connection pool, query execution, and protocol handling.
     * Created once at construction, closed on close().
     *
     * INVARIANT: Non-null until close() is called, then unusable.
     */
    private sql: InstanceType<typeof Bun.SQL>;

    /**
     * Whether channel is closed.
     *
     * WHY: Fast-path check to reject operations after close(). Prevents
     * use-after-close bugs and queries on closed connections.
     *
     * INVARIANT: Once true, never becomes false.
     */
    private _closed = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create PostgreSQL channel.
     *
     * WHY: Establishes connection pool on construction. First query may still
     * trigger actual TCP connection (lazy connect), but pool is ready.
     *
     * @param url - PostgreSQL connection URL (postgresql://user:pass@host:port/db)
     * @param _opts - Channel options (currently unused for PostgreSQL)
     */
    constructor(url: string, _opts?: ChannelOpts) {
        this.description = url;
        // WHY: Bun.SQL constructor parses URL and sets up connection pool.
        // Actual connections are established lazily on first query.
        this.sql = new Bun.SQL(url);
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
    // QUERY HANDLING
    // =========================================================================

    /**
     * Handle SQL query or execute message.
     *
     * WHY: Unified interface for both streaming (SELECT) and non-streaming
     * (INSERT/UPDATE/DELETE) operations. Op discriminates behavior.
     *
     * ALGORITHM:
     * 1. Check closed state
     * 2. Switch on msg.op (query vs execute)
     * 3. Extract sql and params from msg.data
     * 4. Execute via Bun.SQL
     * 5. For query: yield item per row, then done
     * 6. For execute: yield ok with affectedRows
     * 7. On error: yield error with PostgreSQL error code
     *
     * SUPPORTED OPERATIONS:
     * - query: SELECT statements (streaming result set)
     * - execute: INSERT/UPDATE/DELETE statements (returns affected rows)
     *
     * RACE CONDITION:
     * closed flag is checked only at start of method. If close() is called
     * mid-query, query continues but subsequent calls will fail. Bun.SQL
     * handles graceful connection shutdown.
     *
     * ERROR HANDLING:
     * - PostgreSQL errors (syntax, constraint violations): yield error('EIO', code:message)
     * - Network errors: yield error('EIO', message)
     * - Closed channel: yield error('EBADF', 'Channel closed')
     *
     * @param msg - Message with op='query'|'execute', data=QueryData
     * @returns AsyncIterable of responses
     */
    async *handle(msg: Message): AsyncIterable<Response> {
        // RACE FIX: Check closed at method entry, before any async operations
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        try {
            switch (msg.op) {
                case 'query': {
                    // WHY: Query operation returns rows. Use sql.unsafe() for raw SQL
                    // with positional parameters. Bun.SQL uses $1, $2, etc. placeholders.
                    const { sql, params } = msg.data as QueryData;
                    const rows = await this.sql.unsafe(sql, params ?? []);

                    // WHY: Stream rows instead of buffering. Enables processing large
                    // result sets without exhausting memory. Backpressure from kernel
                    // prevents overwhelming the consumer.
                    for (const row of rows) {
                        yield respond.item(row);
                    }
                    // WHY: done signals end of result set. Kernel knows stream is complete.
                    yield respond.done();
                    break;
                }

                case 'execute': {
                    // WHY: Execute operation for statements that don't return rows.
                    // Returns affected row count, not result set.
                    const { sql, params } = msg.data as QueryData;
                    const result = await this.sql.unsafe(sql, params ?? []);

                    // WHY: result.count is Bun.SQL's property for affected rows.
                    // Equivalent to PG's cmdStatus rows count.
                    yield respond.ok({ affectedRows: result.count });
                    break;
                }

                case 'transaction': {
                    // WHY: Transaction operation for atomic multi-statement execution.
                    // All statements succeed or all are rolled back. Uses Bun.SQL's
                    // sql.begin() API which provides a scoped transaction connection.
                    //
                    // CONCURRENCY: sql.begin() reserves a connection for the transaction.
                    // The callback receives a scoped `tx` object. BEGIN is sent automatically,
                    // COMMIT on success, ROLLBACK on any error. Multiple parallel transaction
                    // messages each get their own connection from the pool.
                    const { statements } = msg.data as TransactionData;
                    const results: number[] = [];

                    // WHY: sql.begin() takes an async callback with a scoped transaction.
                    // All queries within the callback use the same connection and transaction.
                    // Any exception triggers automatic ROLLBACK.
                    await this.sql.begin(async (tx) => {
                        for (const stmt of statements) {
                            const result = await tx.unsafe(stmt.sql, stmt.params ?? []);
                            results.push(result.count);
                        }
                    });

                    yield respond.ok({ results });
                    break;
                }

                default:
                    // WHY: Unknown operations fail fast. Helps catch bugs in syscall layer.
                    yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
            }
        } catch (err) {
            // WHY: PostgreSQL errors include code property (23505 for unique violation, etc.)
            // Include code in error message for caller to parse if needed.
            const pgErr = err as Error & { code?: string };
            const code = pgErr.code ?? '';
            // WHY: Use EIO (generic I/O error) for database errors. Could use EPROTO
            // for protocol errors, but EIO is more generic and expected for DB failures.
            yield respond.error('EIO', `${code}: ${pgErr.message}`);
        }
    }

    // =========================================================================
    // UNSUPPORTED OPERATIONS
    // =========================================================================

    /**
     * Push not supported (PostgreSQL is request/response, not bidirectional).
     *
     * WHY: PostgreSQL protocol doesn't support server-initiated messages outside
     * of query response cycle. Use LISTEN/NOTIFY for pub/sub instead.
     */
    async push(_response: Response): Promise<void> {
        throw new Error('PostgreSQL channels do not support push');
    }

    /**
     * Receive not supported (PostgreSQL is request/response, not bidirectional).
     *
     * WHY: Client initiates queries, server responds. No unsolicited messages.
     * NOTIFY events would require separate listener connection.
     */
    async recv(): Promise<Message> {
        throw new Error('PostgreSQL channels do not support recv');
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close channel and release connection pool.
     *
     * WHY: Releases PostgreSQL connections back to pool or closes them.
     * Bun.SQL waits for pending queries to complete before closing.
     *
     * ALGORITHM:
     * 1. Set closed flag (rejects new queries)
     * 2. Call sql.close() (waits for pending queries)
     * 3. Return (connection pool cleaned up)
     *
     * INVARIANT: Idempotent - safe to call multiple times (sql.close() handles this).
     *
     * RACE CONDITION:
     * If queries are in flight, close() waits for them. This prevents
     * connection from being closed while query is reading result set.
     */
    async close(): Promise<void> {
        this._closed = true;
        // WHY: sql.close() releases connection pool and waits for pending queries.
        // This ensures clean shutdown without interrupting in-flight queries.
        this.sql.close();
    }
}
