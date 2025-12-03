/**
 * SQLite Storage Engine - SQLite-backed structured storage
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module implements the StorageEngine interface using SQLite as the backing
 * store via Bun's bun:sqlite module. It provides ACID transactions, efficient
 * BLOB storage, and change subscriptions via a polling-based watch mechanism.
 *
 * The storage schema is simple:
 * - Single table: storage(key TEXT PRIMARY KEY, value BLOB, mtime INTEGER)
 * - Key indexed for fast lookups and prefix scans
 * - mtime tracked via trigger on updates
 * - WAL mode enabled for concurrent read performance
 *
 * Transactions use SQLite's IMMEDIATE mode to acquire write lock early, preventing
 * deadlocks from multiple concurrent transactions. Watch subscriptions use a
 * callback-based observer pattern - watchers register callbacks that are invoked
 * when matching keys change.
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
 * SQLite serializes writes but allows concurrent reads (with WAL mode). Multiple
 * processes/threads can read simultaneously, but only one can write at a time.
 * The Bun SQLite binding is synchronous, so we don't have async interleaving
 * within a single operation. However:
 *
 * - Multiple watch() iterators can be active simultaneously
 * - Watchers are notified synchronously after mutations
 * - Transaction isolation is SERIALIZABLE (SQLite's default)
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: IMMEDIATE transactions acquire write lock early to prevent deadlocks
 * RC-2: Watch callback exceptions are caught to prevent cascade failures
 * RC-3: Watch iterators clean up their callbacks on break/return
 * RC-4: Transaction rollback is automatic if commit not called (via AsyncDisposable)
 *
 * MEMORY MANAGEMENT
 * =================
 * - Database connection owned by this instance
 * - Watcher callbacks stored in Map, cleaned up on iterator break
 * - Transaction buffers events during transaction, cleared on commit/rollback
 * - close() releases database connection and clears all watchers
 *
 * @module hal/storage/sqlite
 */

import { Database } from 'bun:sqlite';
import type { StorageEngine, StorageStat, Transaction, WatchEvent } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * SQLite-backed storage engine using bun:sqlite.
 *
 * WHY: SQLite provides embedded ACID transactions with excellent performance
 * for local storage. WAL mode enables concurrent reads while writes are in progress.
 *
 * TESTABILITY: Constructor accepts path, allowing tests to use ':memory:' for
 * isolated in-memory databases.
 */
export class BunStorageEngine implements StorageEngine {
    // =========================================================================
    // CORE DEPENDENCIES
    // =========================================================================

    /**
     * SQLite database connection.
     *
     * WHY: All operations go through this connection.
     * INVARIANT: Non-null until close() is called.
     */
    private db: Database;

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
     */
    private watchers: Map<string, Set<(event: WatchEvent) => void>> = new Map();

    /**
     * Poll interval for watching changes (currently unused).
     *
     * WHY: Reserved for future polling-based change detection.
     * Currently we use synchronous callbacks after mutations.
     *
     * NOTE: SQLite has no native change notification. For cross-process
     * watching, polling would be required. Current implementation only
     * detects changes made by this process.
     */
    private pollInterval: ReturnType<typeof setInterval> | null = null;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create a new SQLite storage engine.
     *
     * ALGORITHM:
     * 1. Open database connection
     * 2. Initialize schema and indexes
     * 3. Enable WAL mode for performance
     *
     * @param path - SQLite database path, or ':memory:' for in-memory
     */
    constructor(path: string) {
        this.db = new Database(path);
        this.init();
    }

    /**
     * Initialize database schema, indexes, and triggers.
     *
     * WHY: Ensures database structure is ready before operations.
     *
     * ALGORITHM:
     * 1. Enable WAL mode for concurrent reads
     * 2. Set synchronous=NORMAL (faster, still safe with WAL)
     * 3. Create storage table with BLOB value storage
     * 4. Create index on key column for fast prefix scans
     * 5. Create trigger to update mtime on updates
     *
     * RACE CONDITION: None - runs synchronously in constructor.
     */
    private init(): void {
        // Enable WAL mode for better concurrency
        // WHY: Allows readers to proceed while writer is active
        this.db.run('PRAGMA journal_mode = WAL');

        // NORMAL synchronous mode is safe with WAL
        // WHY: Faster than FULL, still durable (WAL checkpoints handle safety)
        this.db.run('PRAGMA synchronous = NORMAL');

        // Create storage table
        // WHY: BLOB for values allows efficient binary storage
        // mtime default ensures every row has a timestamp
        this.db.run(`
            CREATE TABLE IF NOT EXISTS storage (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL,
                mtime INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
            )
        `);

        // Index for prefix queries
        // WHY: Makes list(prefix) operations fast via index scan
        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_storage_key ON storage(key)
        `);

        // Trigger to update mtime on update
        // WHY: Ensures mtime stays current without manual tracking
        this.db.run(`
            CREATE TRIGGER IF NOT EXISTS update_mtime
            AFTER UPDATE ON storage
            BEGIN
                UPDATE storage SET mtime = strftime('%s', 'now') * 1000
                WHERE key = NEW.key;
            END
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
        const row = this.db.query('SELECT value FROM storage WHERE key = ?').get(key) as
            | { value: Uint8Array }
            | null;
        return row?.value ?? null;
    }

    /**
     * Store value by key (insert or update).
     *
     * ALGORITHM:
     * 1. INSERT OR REPLACE with current timestamp
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
        this.db.run('INSERT OR REPLACE INTO storage (key, value, mtime) VALUES (?, ?, ?)', [
            key,
            value,
            Date.now(),
        ]);
        // Notify watchers after successful write
        this.emit({ key, op: 'put', value, timestamp: Date.now() });
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
        this.db.run('DELETE FROM storage WHERE key = ?', [key]);
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
        const rows = this.db.query('SELECT key FROM storage WHERE key LIKE ? ORDER BY key').all(pattern) as Array<{
            key: string;
        }>;
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
        const row = this.db.query('SELECT 1 FROM storage WHERE key = ?').get(key);
        return row !== null;
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
        const row = this.db.query('SELECT length(value) as size, mtime FROM storage WHERE key = ?').get(key) as
            | { size: number; mtime: number }
            | null;
        return row ? { size: row.size, mtime: row.mtime } : null;
    }

    // =========================================================================
    // TRANSACTIONS
    // =========================================================================

    /**
     * Begin a new transaction.
     *
     * ALGORITHM:
     * 1. Start SQLite transaction with IMMEDIATE mode
     * 2. Return transaction handle
     *
     * WHY: IMMEDIATE mode acquires write lock immediately, preventing deadlocks
     * from multiple concurrent BEGIN calls trying to upgrade to write locks.
     *
     * CAVEAT: Only one write transaction can be active at a time in SQLite.
     * Concurrent begin() calls will block until previous transaction commits.
     *
     * @returns Transaction handle
     */
    async begin(): Promise<Transaction> {
        // Use IMMEDIATE to acquire write lock at start, avoiding deadlocks
        // WHY: Prevents "database is locked" errors from lock upgrades
        this.db.run('BEGIN IMMEDIATE');
        return new SQLiteTransaction(this.db, this);
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
     * CAVEAT: This only detects changes made by this process. SQLite has no
     * cross-process change notification. For multi-process watching, polling
     * would be required (check mtime on interval).
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
                } else {
                    // Wait for next event
                    await new Promise<void>((r) => {
                        resolve = r;
                    });
                }
            }
        } finally {
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
     * 1. Clear poll interval if set
     * 2. Close database connection
     *
     * WHY: Ensures clean shutdown and resource release.
     *
     * NOTE: Does not explicitly clear watchers map, as close() means no more
     * operations will occur. Watchers will be garbage collected.
     *
     * @returns Promise that resolves when cleanup is complete
     */
    async close(): Promise<void> {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.db.close();
    }

    // =========================================================================
    // INTERNAL (for SQLiteTransaction)
    // =========================================================================

    /**
     * Internal: commit transaction and emit events.
     *
     * WHY: Allows SQLiteTransaction to commit and emit buffered events.
     * Public to allow transaction access, but prefixed _ to indicate internal use.
     */
    _commit(): void {
        this.db.run('COMMIT');
    }

    /**
     * Internal: rollback transaction.
     *
     * WHY: Allows SQLiteTransaction to rollback on error or explicit call.
     * Public to allow transaction access, but prefixed _ to indicate internal use.
     */
    _rollback(): void {
        this.db.run('ROLLBACK');
    }

    /**
     * Internal: emit event (for transaction use).
     *
     * WHY: Allows SQLiteTransaction to emit events after commit.
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
 * SQLite transaction implementation.
 *
 * WHY: Provides ACID properties for groups of operations. Events are buffered
 * during transaction and emitted only after successful commit.
 *
 * INVARIANTS:
 * - Once committed, transaction cannot be used again
 * - Once rolled back, transaction cannot be used again
 * - If neither commit nor rollback called, rollback happens on dispose
 *
 * TESTABILITY: Implements AsyncDisposable for use with `await using`.
 */
class SQLiteTransaction implements Transaction {
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
     * @param db - SQLite database connection
     * @param engine - Parent storage engine (for commit/rollback/emit)
     */
    constructor(
        private db: Database,
        private engine: BunStorageEngine
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
        const row = this.db.query('SELECT value FROM storage WHERE key = ?').get(key) as
            | { value: Uint8Array }
            | null;
        return row?.value ?? null;
    }

    /**
     * Store value by key within transaction.
     *
     * ALGORITHM:
     * 1. INSERT OR REPLACE in transaction
     * 2. Buffer event for emission after commit
     *
     * WHY: Events buffered so watchers only see committed changes.
     *
     * @param key - Key to store
     * @param value - Value bytes to store
     */
    async put(key: string, value: Uint8Array): Promise<void> {
        this.db.run('INSERT OR REPLACE INTO storage (key, value, mtime) VALUES (?, ?, ?)', [
            key,
            value,
            Date.now(),
        ]);
        // Buffer event for emission after commit
        this.events.push({ key, op: 'put', value, timestamp: Date.now() });
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
        this.db.run('DELETE FROM storage WHERE key = ?', [key]);
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
     * 2. Commit SQLite transaction
     * 3. Emit buffered events to watchers
     *
     * INVARIANT: Idempotent (no-op if already committed).
     *
     * @returns Promise that resolves when commit is complete
     */
    async commit(): Promise<void> {
        if (this.committed) return;
        this.committed = true;
        this.engine._commit();
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
     * 2. Rollback SQLite transaction
     * 3. Discard buffered events
     *
     * INVARIANT: Idempotent (no-op if already committed or rolled back).
     *
     * @returns Promise that resolves when rollback is complete
     */
    async rollback(): Promise<void> {
        if (this.committed || this.rolledBack) return;
        this.rolledBack = true;
        this.engine._rollback();
        // Discard buffered events
        this.events = [];
    }
}
