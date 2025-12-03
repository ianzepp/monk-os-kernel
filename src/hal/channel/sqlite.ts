/**
 * SQLite Channel - SQLite database via bun:sqlite
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The SQLite channel provides message-based SQL query execution using Bun's
 * built-in bun:sqlite module. Unlike network databases (PostgreSQL, MySQL),
 * SQLite is file-based and synchronous, but we maintain the same async
 * interface for consistency with other channels.
 *
 * The channel supports two operation types:
 * 1. query: Execute SELECT and return rows as stream (yields item per row)
 * 2. execute: Execute INSERT/UPDATE/DELETE and return affected rows (yields ok)
 *
 * SQLite uses WAL (Write-Ahead Logging) mode for better concurrency - readers
 * don't block writers. This enables multiple processes to query the same
 * database file simultaneously.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Database path is set at construction and never modified
 * INV-2: Once closed=true, all handle() calls must yield error response
 * INV-3: handle() always yields at least one response (ok, error, item+done)
 * INV-4: query op yields item per row followed by done
 * INV-5: execute op yields single ok with affectedRows count
 * INV-6: db is closed only once (on close())
 * INV-7: WAL mode is enabled for all databases
 *
 * CONCURRENCY MODEL
 * =================
 * SQLite operations are synchronous at the library level but wrapped in async
 * methods for interface consistency. Multiple processes can query the same
 * database file via different channel instances (different file handles).
 *
 * WAL mode enables concurrent reads and single writer. Readers see consistent
 * snapshot even if writer is modifying database. Writes are serialized by
 * SQLite's locking mechanism.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: closed flag checked at start of handle() (before query execution)
 * RC-2: WAL mode reduces lock contention between readers and writers
 * RC-3: SQLite handles file locking internally (cross-process safe)
 * RC-4: close() is idempotent (safe to call multiple times)
 *
 * MEMORY MANAGEMENT
 * =================
 * - db owns file handle to database file
 * - Result sets are arrays (SQLite loads entire result into memory)
 * - close() must be called to release file handle and flush WAL
 * - Prepared statements are reusable but not cached in this implementation
 *
 * @module hal/channel/sqlite
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Channel, ChannelOpts, QueryData } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * SQLite channel using bun:sqlite.
 *
 * WHY: bun:sqlite provides zero-dependency SQLite access with good performance.
 * Synchronous API simplifies error handling (no async cancellation races).
 *
 * TESTABILITY: Can be mocked by using in-memory database (':memory:') or
 * temporary files. Each test gets isolated database instance.
 */
export class BunSqliteChannel implements Channel {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique channel identifier.
     *
     * WHY: Enables kernel to track channels in handle tables and correlate
     * queries in logs. Useful for debugging file lock issues.
     *
     * INVARIANT: Set once at construction, never changes.
     */
    readonly id = randomUUID();

    /**
     * Protocol type.
     *
     * WHY: Identifies this as a SQLite channel for kernel dispatch and logging.
     *
     * INVARIANT: Always 'sqlite'.
     */
    readonly proto = 'sqlite';

    /**
     * Human-readable description.
     *
     * WHY: Shows database file path in logs and error messages. Helps identify
     * which database a query is targeting.
     */
    readonly description: string;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * SQLite database instance.
     *
     * WHY: Manages file handle, prepared statements, and query execution.
     * Created once at construction, closed on close().
     *
     * INVARIANT: Non-null until close() is called, then unusable.
     */
    private db: import('bun:sqlite').Database;

    /**
     * Whether channel is closed.
     *
     * WHY: Fast-path check to reject operations after close(). Prevents
     * use-after-close bugs and queries on closed database.
     *
     * INVARIANT: Once true, never becomes false.
     */
    private _closed = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create SQLite channel.
     *
     * WHY: Opens database file and enables WAL mode for better concurrency.
     * File is created if missing (unless create=false in opts).
     *
     * ALGORITHM:
     * 1. Import bun:sqlite (built-in module)
     * 2. Open database file with options
     * 3. Enable WAL mode via PRAGMA
     *
     * @param path - Database file path (or ':memory:' for in-memory)
     * @param opts - Channel options (readonly, create)
     */
    constructor(path: string, opts?: ChannelOpts) {
        this.description = path;

        // WHY: bun:sqlite is built-in module. require() is synchronous and safe.
        // Could use import() but that's async and unnecessary here.
        const { Database } = require('bun:sqlite');

        // WHY: readonly=true opens in read-only mode (no writes allowed).
        // create=true creates file if missing (default behavior).
        this.db = new Database(path, {
            readonly: opts?.readonly ?? false,
            create: opts?.create ?? true,
        });

        // WHY: WAL (Write-Ahead Logging) enables concurrent readers and single writer.
        // Without WAL, readers block writers and vice versa. WAL is production best practice.
        // exec() runs immediate SQL without returning results.
        this.db.exec('PRAGMA journal_mode = WAL');

        // WHY: Foreign keys are not enabled by default in SQLite. Enable them for
        // referential integrity (e.g., fields.model_name -> models.model_name).
        this.db.exec('PRAGMA foreign_keys = ON');
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
     * Handle SQL query, execute, or exec message.
     *
     * WHY: Unified interface for streaming (SELECT), non-streaming
     * (INSERT/UPDATE/DELETE), and raw SQL (schema/migration) operations.
     * Op discriminates behavior.
     *
     * ALGORITHM:
     * 1. Check closed state
     * 2. Switch on msg.op (query vs execute vs exec)
     * 3. Extract sql and params from msg.data
     * 4. For query/execute: prepare statement, bind parameters, execute
     * 5. For exec: run raw SQL directly (multiple statements allowed)
     * 6. For query: yield item per row, then done
     * 7. For execute: yield ok with affectedRows
     * 8. For exec: yield ok (no return value)
     * 9. On error: yield error with SQLite error message
     *
     * SUPPORTED OPERATIONS:
     * - query: SELECT statements (returns all rows)
     * - execute: INSERT/UPDATE/DELETE statements (returns affected rows)
     * - exec: Raw SQL execution (multiple statements, no return value)
     *
     * RACE CONDITION:
     * closed flag is checked only at start of method. If close() is called
     * mid-query, query may fail with "database is closed" error. This is
     * acceptable - caller must ensure channel isn't closed during use.
     *
     * ERROR HANDLING:
     * - SQLite errors (syntax, constraint violations): yield error('EIO', message)
     * - File access errors: yield error('EIO', message)
     * - Closed channel: yield error('EBADF', 'Channel closed')
     *
     * @param msg - Message with op='query'|'execute', data=QueryData
     * @returns AsyncIterable of responses
     */
    async *handle(msg: Message): AsyncIterable<Response> {
        // RACE FIX: Check closed at method entry, before any operations
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        try {
            switch (msg.op) {
                case 'query': {
                    // WHY: Query operation returns rows. Use prepare() for parameterized
                    // queries (prevents SQL injection). all() returns array of all rows.
                    const { sql, params } = msg.data as QueryData;
                    const stmt = this.db.prepare(sql);

                    // WHY: Cast params to SQLite binding type. SQLite accepts strings,
                    // numbers, null, Uint8Array. Objects are not supported directly.
                    const bindings = (params ?? []) as import('bun:sqlite').SQLQueryBindings[];
                    const rows = stmt.all(...bindings);

                    // WHY: SQLite returns all rows as array (not streaming). We yield
                    // one item per row for consistency with other database channels.
                    // Memory usage is higher than streaming but acceptable for SQLite.
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
                    const stmt = this.db.prepare(sql);
                    const bindings = (params ?? []) as import('bun:sqlite').SQLQueryBindings[];
                    const result = stmt.run(...bindings);

                    // WHY: result.changes is SQLite's property for affected rows.
                    // Matches PostgreSQL's affectedRows naming in response.
                    yield respond.ok({ affectedRows: result.changes });
                    break;
                }

                case 'exec': {
                    // WHY: Exec operation for raw SQL that may contain multiple statements.
                    // Used for schema initialization, migrations, and batch operations.
                    // No parameters supported - raw SQL only.
                    // No return value - use query/execute for results.
                    const { sql } = msg.data as QueryData;

                    // WHY: db.exec() handles multiple statements separated by semicolons.
                    // Unlike prepare().run() which only handles single statements.
                    this.db.exec(sql);

                    yield respond.ok({});
                    break;
                }

                default:
                    // WHY: Unknown operations fail fast. Helps catch bugs in syscall layer.
                    yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
            }
        } catch (err) {
            // WHY: SQLite errors are Error instances with message property.
            // No error codes like PostgreSQL - just message strings.
            const sqliteErr = err as Error;
            // WHY: Use EIO (generic I/O error) for database errors. Consistent
            // with other database channels.
            yield respond.error('EIO', sqliteErr.message);
        }
    }

    // =========================================================================
    // UNSUPPORTED OPERATIONS
    // =========================================================================

    /**
     * Push not supported (SQLite is request/response, not bidirectional).
     *
     * WHY: SQLite is file-based, no network connection or server to push to.
     */
    async push(_response: Response): Promise<void> {
        throw new Error('SQLite channels do not support push');
    }

    /**
     * Receive not supported (SQLite is request/response, not bidirectional).
     *
     * WHY: Client initiates queries, no unsolicited messages from database file.
     */
    async recv(): Promise<Message> {
        throw new Error('SQLite channels do not support recv');
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close channel and release database file handle.
     *
     * WHY: Releases file handle and flushes WAL. Database remains on disk
     * (unlike in-memory databases which are deleted).
     *
     * ALGORITHM:
     * 1. Set closed flag (rejects new queries)
     * 2. Call db.close() (flushes WAL, releases handle)
     * 3. Return (file handle cleaned up)
     *
     * INVARIANT: Idempotent - safe to call multiple times (db.close() handles this).
     *
     * RACE CONDITION:
     * If queries are in flight, they complete before close() returns.
     * SQLite is synchronous so no async cancellation issues.
     */
    async close(): Promise<void> {
        this._closed = true;
        // WHY: db.close() flushes WAL and releases file handle. Critical for
        // WAL mode - ensures all writes are checkpointed to main database file.
        this.db.close();
    }
}
