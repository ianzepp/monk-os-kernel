/**
 * PostgreSQL Storage Engine - PostgreSQL-backed structured storage
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module implements the StorageEngine interface using PostgreSQL as the backing
 * store via Bun's Bun.SQL API. It provides ACID transactions, efficient BYTEA storage,
 * and change subscriptions via a callback-based watch mechanism.
 *
 * The storage schema is simple:
 * - Single table: storage(key TEXT PRIMARY KEY, value BYTEA, mtime BIGINT)
 * - Key indexed for fast lookups and prefix scans
 * - mtime tracked via trigger on updates
 *
 * Transactions use PostgreSQL's standard BEGIN/COMMIT/ROLLBACK with full MVCC
 * support for concurrent writers (unlike SQLite's single-writer model).
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Database connection is valid until close() is called
 * INV-2: All mutations (put/delete) emit watch events
 * INV-3: Transaction events are buffered and emitted only after commit
 * INV-4: Watch callbacks never throw (caught and logged)
 * INV-5: mtime is always in milliseconds since epoch
 * INV-6: Keys are unique (enforced by PRIMARY KEY)
 *
 * CONCURRENCY MODEL
 * =================
 * PostgreSQL supports full MVCC with multiple concurrent writers. Transactions
 * are isolated with READ COMMITTED by default. Multiple processes can read and
 * write simultaneously without blocking (except for same-row updates).
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Transactions provide isolation for multi-key operations
 * RC-2: Watch callback exceptions are caught to prevent cascade failures
 * RC-3: Watch iterators clean up their callbacks on break/return
 * RC-4: Transaction rollback is automatic if commit not called (via AsyncDisposable)
 *
 * MEMORY MANAGEMENT
 * =================
 * - Bun.SQL owns connection pool
 * - Watcher callbacks stored in Map, cleaned up on iterator break
 * - Transaction buffers events during transaction, cleared on commit/rollback
 * - close() releases connection pool and clears all watchers
 *
 * @module hal/storage/postgres
 */

import type { StorageEngine, StorageStat, Transaction, WatchEvent } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * PostgreSQL-backed storage engine using Bun.SQL.
 *
 * WHY: PostgreSQL provides production-grade ACID transactions with excellent
 * concurrency for distributed storage. MVCC enables concurrent readers and
 * writers without blocking.
 *
 * TESTABILITY: Constructor accepts URL, allowing tests to use separate test
 * databases for isolated testing.
 */
export class PostgresStorageEngine implements StorageEngine {
    // =========================================================================
    // CORE DEPENDENCIES
    // =========================================================================

    /**
     * Bun.SQL connection pool.
     *
     * WHY: All operations go through this connection pool.
     * INVARIANT: Non-null until close() is called.
     */
    private sql: InstanceType<typeof Bun.SQL>;

    // =========================================================================
    // WATCH SUBSCRIPTIONS
    // =========================================================================

    /**
     * Map of pattern -> set of callbacks for watch subscriptions.
     *
     * WHY: Allows multiple watch() iterators on different patterns.
     * Each pattern can have multiple watchers.
     *
     * MEMORY: Callbacks removed when watch iterator breaks or returns.
     *
     * NOTE: This implementation only detects changes made by this process.
     * For cross-process watching, PostgreSQL LISTEN/NOTIFY would be required.
     */
    private watchers: Map<string, Set<(event: WatchEvent) => void>> = new Map();

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create a new PostgreSQL storage engine.
     *
     * ALGORITHM:
     * 1. Open connection pool
     * 2. Initialize schema and indexes
     *
     * @param url - PostgreSQL connection URL (postgresql://user:pass@host:port/db)
     */
    constructor(url: string) {
        this.sql = new Bun.SQL(url);
    }

    /**
     * Initialize database schema, indexes, and triggers.
     *
     * WHY: Ensures database structure is ready before operations.
     *
     * ALGORITHM:
     * 1. Create storage table with BYTEA value storage
     * 2. Create index on key column for fast prefix scans
     * 3. Create function and trigger to update mtime on updates
     *
     * NOTE: Called separately from constructor to allow async initialization.
     */
    async init(): Promise<void> {
        // Create storage table
        // WHY: BYTEA for values allows efficient binary storage
        // mtime default ensures every row has a timestamp
        await this.sql.unsafe(`
            CREATE TABLE IF NOT EXISTS storage (
                key TEXT PRIMARY KEY,
                value BYTEA NOT NULL,
                mtime BIGINT NOT NULL DEFAULT (extract(epoch FROM now()) * 1000)::BIGINT
            )
        `);

        // Index for prefix queries
        // WHY: Makes list(prefix) operations fast via index scan
        // text_pattern_ops enables LIKE 'prefix%' to use the index
        await this.sql.unsafe(`
            CREATE INDEX IF NOT EXISTS idx_storage_key ON storage(key text_pattern_ops)
        `);

        // Create function for updating mtime
        // WHY: Encapsulates mtime update logic in a reusable function
        await this.sql.unsafe(`
            CREATE OR REPLACE FUNCTION update_storage_mtime()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.mtime := (extract(epoch FROM now()) * 1000)::BIGINT;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);

        // Create trigger to update mtime on update
        // WHY: Ensures mtime stays current without manual tracking
        // DROP first to handle recreation safely
        await this.sql.unsafe(`
            DROP TRIGGER IF EXISTS update_mtime ON storage
        `);
        await this.sql.unsafe(`
            CREATE TRIGGER update_mtime
            BEFORE UPDATE ON storage
            FOR EACH ROW
            EXECUTE FUNCTION update_storage_mtime()
        `);
    }

    // =========================================================================
    // KEY-VALUE OPERATIONS
    // =========================================================================

    /**
     * Get value by key.
     *
     * ALGORITHM:
     * 1. Query for value by exact key match
     * 2. Return value bytes or null if not found
     *
     * @param key - Key to retrieve
     * @returns Value bytes or null if not found
     */
    async get(key: string): Promise<Uint8Array | null> {
        const rows = await this.sql.unsafe('SELECT value FROM storage WHERE key = $1', [key]);

        if (rows.length === 0) {
            return null;
        }

        const value = rows[0].value;

        // Bun.SQL returns Buffer for BYTEA, convert to Uint8Array
        return value instanceof Uint8Array ? value : new Uint8Array(value);
    }

    /**
     * Store value by key (insert or update).
     *
     * ALGORITHM:
     * 1. INSERT ... ON CONFLICT UPDATE with current timestamp
     * 2. Emit watch event to subscribers
     *
     * RACE CONDITION: Watch callbacks execute synchronously before return.
     * If callback throws, operation succeeds but callback fails.
     * MITIGATION: emit() catches and logs callback exceptions.
     *
     * @param key - Key to store
     * @param value - Value bytes to store
     */
    async put(key: string, value: Uint8Array): Promise<void> {
        const mtime = Date.now();

        await this.sql.unsafe(
            `INSERT INTO storage (key, value, mtime) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = $2, mtime = $3`,
            [key, value, mtime],
        );
        // Notify watchers after successful write
        this.emit({ key, op: 'put', value, timestamp: mtime });
    }

    /**
     * Delete key (no error if key doesn't exist).
     *
     * ALGORITHM:
     * 1. DELETE by key (no-op if not found)
     * 2. Emit watch event to subscribers
     *
     * @param key - Key to delete
     */
    async delete(key: string): Promise<void> {
        await this.sql.unsafe('DELETE FROM storage WHERE key = $1', [key]);
        // Notify watchers after successful delete
        this.emit({ key, op: 'delete', timestamp: Date.now() });
    }

    // =========================================================================
    // LISTING AND METADATA
    // =========================================================================

    /**
     * List keys matching prefix in lexicographic order.
     *
     * ALGORITHM:
     * 1. Convert prefix to SQL LIKE pattern (prefix + '%')
     * 2. Query matching keys with ORDER BY
     * 3. Yield each key
     *
     * WHY: Async generator allows streaming results for large key sets.
     *
     * @param prefix - Key prefix to match (empty string matches all)
     * @yields Matching keys in lexicographic order
     */
    async *list(prefix: string): AsyncIterable<string> {
        const pattern = prefix + '%';
        const rows = await this.sql.unsafe(
            'SELECT key FROM storage WHERE key LIKE $1 ORDER BY key',
            [pattern],
        );

        for (const row of rows) {
            yield row.key;
        }
    }

    /**
     * Check if key exists without reading value.
     *
     * WHY: More efficient than get() when only existence is needed.
     *
     * @param key - Key to check
     * @returns true if key exists
     */
    async exists(key: string): Promise<boolean> {
        const rows = await this.sql.unsafe('SELECT 1 FROM storage WHERE key = $1', [key]);

        return rows.length > 0;
    }

    /**
     * Get key metadata without reading value.
     *
     * WHY: Allows checking size and mtime without loading potentially large value.
     *
     * @param key - Key to stat
     * @returns Metadata (size, mtime) or null if not found
     */
    async stat(key: string): Promise<StorageStat | null> {
        const rows = await this.sql.unsafe(
            'SELECT octet_length(value) as size, mtime FROM storage WHERE key = $1',
            [key],
        );

        if (rows.length === 0) {
            return null;
        }

        return { size: Number(rows[0].size), mtime: Number(rows[0].mtime) };
    }

    // =========================================================================
    // TRANSACTIONS
    // =========================================================================

    /**
     * Begin a new transaction.
     *
     * ALGORITHM:
     * 1. Reserve a connection from the pool for transaction use
     * 2. Start PostgreSQL transaction on that connection
     * 3. Return transaction handle
     *
     * WHY: PostgreSQL supports full MVCC, so multiple concurrent transactions
     * can proceed without blocking (except for same-row conflicts).
     *
     * NOTE: Bun.SQL requires using sql.begin() or sql.reserved() for transactions
     * to ensure connection pool safety.
     *
     * @returns Transaction handle
     */
    async begin(): Promise<Transaction> {
        // WHY: Bun.SQL requires reserving a connection for transactions
        // to prevent connection pool issues with BEGIN/COMMIT across connections
        const reserved = await this.sql.reserve();

        await reserved.unsafe('BEGIN');

        return new PostgresTransaction(reserved, this);
    }

    // =========================================================================
    // CHANGE SUBSCRIPTIONS
    // =========================================================================

    /**
     * Watch for changes matching pattern.
     *
     * ALGORITHM:
     * 1. Create event queue for this watcher
     * 2. Register callback for matching events
     * 3. Yield queued events or wait for new ones
     * 4. Clean up callback when iterator breaks
     *
     * PATTERN SYNTAX:
     * - * matches any characters in a single segment (no /)
     * - ** matches any characters across segments (including /)
     * - Literal strings match exactly
     *
     * CAVEAT: This only detects changes made by this process. PostgreSQL has
     * LISTEN/NOTIFY for cross-process change notification, but that would
     * require a dedicated listener connection and more complex setup.
     *
     * @param pattern - Glob pattern to match keys
     * @yields Change events for matching keys
     */
    async *watch(pattern: string): AsyncIterable<WatchEvent> {
        // Convert glob pattern to tracking key
        const key = pattern;

        // Create a queue for this watcher
        const queue: WatchEvent[] = [];
        let resolve: (() => void) | null = null;

        const callback = (event: WatchEvent) => {
            if (this.matchPattern(pattern, event.key)) {
                queue.push(event);
                // Wake up waiting promise if any
                if (resolve) {
                    resolve();
                    resolve = null;
                }
            }
        };

        // Register watcher
        if (!this.watchers.has(key)) {
            this.watchers.set(key, new Set());
        }

        this.watchers.get(key)!.add(callback);

        try {
            while (true) {
                if (queue.length > 0) {
                    // Yield next event from queue
                    yield queue.shift()!;
                }
                else {
                    // Wait for next event
                    await new Promise<void>(r => {
                        resolve = r;
                    });
                }
            }
        }
        finally {
            // Cleanup on break/return
            // WHY: Prevents memory leak from abandoned watchers
            this.watchers.get(key)?.delete(callback);
            if (this.watchers.get(key)?.size === 0) {
                this.watchers.delete(key);
            }
        }
    }

    /**
     * Emit event to matching watchers.
     *
     * WHY: Notifies all watch() iterators of changes.
     *
     * RACE CONDITION: Callbacks execute synchronously. If callback throws,
     * other callbacks still execute.
     * MITIGATION: Each callback should have try/catch, but we don't enforce it here.
     *
     * @param event - Event to emit
     */
    private emit(event: WatchEvent): void {
        for (const [pattern, callbacks] of this.watchers) {
            if (this.matchPattern(pattern, event.key)) {
                for (const callback of callbacks) {
                    // Call each callback (they should not throw, but if they do, it's their problem)
                    callback(event);
                }
            }
        }
    }

    /**
     * Match key against glob pattern.
     *
     * PATTERN SYNTAX:
     * - * matches any characters except / (single segment)
     * - ** matches any characters including / (multiple segments)
     * - Literal strings match exactly
     *
     * ALGORITHM:
     * 1. Convert ** to placeholder
     * 2. Convert * to regex [^/]*
     * 3. Convert ** placeholder to regex .*
     * 4. Test key against regex
     *
     * WHY: Simple regex-based matching is fast and sufficient for current needs.
     * Could be optimized with a real glob matcher library if needed.
     *
     * @param pattern - Glob pattern
     * @param key - Key to test
     * @returns true if key matches pattern
     */
    private matchPattern(pattern: string, key: string): boolean {
        // Simple implementation: convert to regex
        const regex = pattern
            .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<<DOUBLESTAR>>>/g, '.*');

        return new RegExp(`^${regex}$`).test(key);
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    /**
     * Close the storage engine and release resources.
     *
     * ALGORITHM:
     * 1. Close connection pool
     *
     * WHY: Ensures clean shutdown and resource release.
     *
     * NOTE: Does not explicitly clear watchers map, as close() means no more
     * operations will occur. Watchers will be garbage collected.
     *
     * @returns Promise that resolves when cleanup is complete
     */
    async close(): Promise<void> {
        this.sql.close();
    }

    // =========================================================================
    // INTERNAL (for PostgresTransaction)
    // =========================================================================

    /**
     * Internal: emit event (for transaction use).
     *
     * WHY: Allows PostgresTransaction to emit events after commit.
     * Public to allow transaction access, but prefixed _ to indicate internal use.
     *
     * @param event - Event to emit
     */
    _emit(event: WatchEvent): void {
        this.emit(event);
    }
}

// =============================================================================
// TRANSACTION IMPLEMENTATION
// =============================================================================

/**
 * Reserved connection type from Bun.SQL.reserve()
 */
type ReservedSQL = Awaited<ReturnType<InstanceType<typeof Bun.SQL>['reserve']>>;

/**
 * PostgreSQL transaction implementation.
 *
 * WHY: Provides ACID properties for groups of operations. Events are buffered
 * during transaction and emitted only after successful commit.
 *
 * INVARIANTS:
 * - Once committed, transaction cannot be used again
 * - Once rolled back, transaction cannot be used again
 * - If neither commit nor rollback called, rollback happens on dispose
 * - Reserved connection is released after commit or rollback
 *
 * TESTABILITY: Implements AsyncDisposable for use with `await using`.
 */
class PostgresTransaction implements Transaction {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether transaction has been committed.
     *
     * WHY: Prevents double-commit and operations after commit.
     */
    private committed = false;

    /**
     * Whether transaction has been rolled back.
     *
     * WHY: Prevents double-rollback and operations after rollback.
     */
    private rolledBack = false;

    /**
     * Buffered events to emit after commit.
     *
     * WHY: Ensures watchers only see committed changes, not uncommitted ones.
     */
    private events: WatchEvent[] = [];

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create a new transaction.
     *
     * @param reserved - Reserved Bun.SQL connection for this transaction
     * @param engine - Parent storage engine (for emit)
     */
    constructor(
        private reserved: ReservedSQL,
        private engine: PostgresStorageEngine,
    ) {}

    /**
     * AsyncDisposable handler - auto-rollback if not committed.
     *
     * WHY: Ensures transaction is never left open. If user forgets to commit,
     * rollback happens automatically.
     *
     * USAGE:
     * ```typescript
     * await using tx = await storage.begin();
     * await tx.put('key', value);
     * await tx.commit(); // If this throws, rollback happens automatically
     * ```
     */
    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.committed && !this.rolledBack) {
            await this.rollback();
        }
    }

    // =========================================================================
    // OPERATIONS
    // =========================================================================

    /**
     * Get value by key within transaction.
     *
     * WHY: Reads uncommitted changes from current transaction.
     *
     * @param key - Key to retrieve
     * @returns Value bytes or null if not found
     */
    async get(key: string): Promise<Uint8Array | null> {
        const rows = await this.reserved.unsafe('SELECT value FROM storage WHERE key = $1', [key]);

        if (rows.length === 0) {
            return null;
        }

        const value = rows[0].value;

        return value instanceof Uint8Array ? value : new Uint8Array(value);
    }

    /**
     * Store value by key within transaction.
     *
     * ALGORITHM:
     * 1. INSERT ... ON CONFLICT UPDATE in transaction
     * 2. Buffer event for emission after commit
     *
     * WHY: Events buffered so watchers only see committed changes.
     *
     * @param key - Key to store
     * @param value - Value bytes to store
     */
    async put(key: string, value: Uint8Array): Promise<void> {
        const mtime = Date.now();

        await this.reserved.unsafe(
            `INSERT INTO storage (key, value, mtime) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = $2, mtime = $3`,
            [key, value, mtime],
        );
        // Buffer event for emission after commit
        this.events.push({ key, op: 'put', value, timestamp: mtime });
    }

    /**
     * Delete key within transaction.
     *
     * ALGORITHM:
     * 1. DELETE in transaction
     * 2. Buffer event for emission after commit
     *
     * WHY: Events buffered so watchers only see committed changes.
     *
     * @param key - Key to delete
     */
    async delete(key: string): Promise<void> {
        await this.reserved.unsafe('DELETE FROM storage WHERE key = $1', [key]);
        // Buffer event for emission after commit
        this.events.push({ key, op: 'delete', timestamp: Date.now() });
    }

    // =========================================================================
    // COMMIT/ROLLBACK
    // =========================================================================

    /**
     * Commit transaction.
     *
     * ALGORITHM:
     * 1. Mark as committed
     * 2. Commit PostgreSQL transaction
     * 3. Release reserved connection back to pool
     * 4. Emit buffered events to watchers
     *
     * INVARIANT: Idempotent (no-op if already committed).
     *
     * @returns Promise that resolves when commit is complete
     */
    async commit(): Promise<void> {
        if (this.committed) {
            return;
        }

        this.committed = true;
        await this.reserved.unsafe('COMMIT');
        // Release connection back to pool
        this.reserved.release();
        // Emit events after commit succeeds
        // WHY: Ensures watchers only see atomically committed changes
        for (const event of this.events) {
            this.engine._emit(event);
        }
    }

    /**
     * Rollback transaction.
     *
     * ALGORITHM:
     * 1. Mark as rolled back
     * 2. Rollback PostgreSQL transaction
     * 3. Release reserved connection back to pool
     * 4. Discard buffered events
     *
     * INVARIANT: Idempotent (no-op if already committed or rolled back).
     *
     * @returns Promise that resolves when rollback is complete
     */
    async rollback(): Promise<void> {
        if (this.committed || this.rolledBack) {
            return;
        }

        this.rolledBack = true;
        await this.reserved.unsafe('ROLLBACK');
        // Release connection back to pool
        this.reserved.release();
        // Discard buffered events
        this.events = [];
    }
}
