/**
 * Storage Engine
 *
 * Structured key-value storage with transactions and subscriptions.
 * Primary data store for VFS and application data.
 *
 * Bun touchpoints:
 * - bun:sqlite for embedded SQLite
 * - Database class from bun:sqlite
 *
 * Caveats:
 * - SQLite WAL mode recommended for concurrent reads
 * - watch() uses polling in SQLite (no native change notifications)
 * - PostgreSQL implementation would use LISTEN/NOTIFY for real subscriptions
 */

import { Database } from 'bun:sqlite';

/**
 * Storage key metadata
 */
export interface StorageStat {
    /** Value size in bytes */
    size: number;
    /** Last modification time (ms since epoch) */
    mtime: number;
}

/**
 * Watch event emitted when data changes
 */
export interface WatchEvent {
    /** Key that changed */
    key: string;
    /** Type of change */
    op: 'put' | 'delete';
    /** New value (undefined for delete) */
    value?: Uint8Array;
    /** Timestamp of change */
    timestamp: number;
}

/**
 * Transaction handle for atomic operations.
 *
 * Implements AsyncDisposable for use with `await using`:
 * ```typescript
 * await using tx = await storage.begin();
 * await tx.put('key', value);
 * await tx.commit();
 * // If exception thrown before commit, automatically rolled back
 * ```
 */
export interface Transaction extends AsyncDisposable {
    /**
     * Get value by key within transaction.
     */
    get(key: string): Promise<Uint8Array | null>;

    /**
     * Store value by key within transaction.
     */
    put(key: string, value: Uint8Array): Promise<void>;

    /**
     * Delete key within transaction.
     */
    delete(key: string): Promise<void>;

    /**
     * Commit transaction.
     * All operations become visible atomically.
     */
    commit(): Promise<void>;

    /**
     * Rollback transaction.
     * All operations are discarded.
     */
    rollback(): Promise<void>;
}

/**
 * Storage engine interface.
 *
 * Provides structured key-value storage with transactions
 * and change subscriptions.
 */
export interface StorageEngine {
    /**
     * Get value by key.
     *
     * Bun: Single SELECT query
     *
     * @returns Value bytes or null if not found
     */
    get(key: string): Promise<Uint8Array | null>;

    /**
     * Store value by key.
     * Overwrites if exists.
     *
     * Bun: INSERT OR REPLACE query
     */
    put(key: string, value: Uint8Array): Promise<void>;

    /**
     * Delete key.
     * No error if key doesn't exist.
     *
     * Bun: DELETE query
     */
    delete(key: string): Promise<void>;

    /**
     * List keys matching prefix.
     *
     * Bun: SELECT with LIKE 'prefix%'
     *
     * @param prefix - Key prefix to match (empty string for all)
     * @yields Matching keys in lexicographic order
     */
    list(prefix: string): AsyncIterable<string>;

    /**
     * Check if key exists without reading value.
     *
     * Bun: SELECT 1 with EXISTS
     */
    exists(key: string): Promise<boolean>;

    /**
     * Get key metadata without reading value.
     *
     * @returns Metadata or null if not found
     */
    stat(key: string): Promise<StorageStat | null>;

    /**
     * Begin a transaction.
     * All operations on returned Transaction are atomic.
     *
     * Bun: BEGIN IMMEDIATE to acquire write lock early
     *
     * Caveat: Only one write transaction at a time in SQLite.
     * Concurrent begin() calls will block until previous commits.
     */
    begin(): Promise<Transaction>;

    /**
     * Watch for changes matching pattern.
     * Pattern supports * (single segment) and ** (multiple segments).
     *
     * Bun/SQLite: Uses polling (no native notifications).
     * Check interval is implementation-defined (default 100ms).
     *
     * Caveat: Changes made outside this process are detected on
     * next poll, not immediately. For real-time needs, use PostgreSQL
     * with LISTEN/NOTIFY.
     *
     * @yields Change events
     */
    watch(pattern: string): AsyncIterable<WatchEvent>;

    /**
     * Close the storage engine and release resources.
     */
    close(): Promise<void>;
}

/**
 * SQLite-backed storage engine using bun:sqlite
 *
 * Bun touchpoints:
 * - new Database(path) - open database
 * - db.run() - execute statements
 * - db.query() - prepare and run queries
 * - db.transaction() - wrap in transaction
 *
 * Caveats:
 * - WAL mode enabled for better concurrency
 * - BLOB storage for values (efficient binary)
 * - mtime tracked via trigger on update
 * - watch() uses polling, not triggers (triggers can't push to JS)
 */
export class BunStorageEngine implements StorageEngine {
    private db: Database;
    private watchers: Map<string, Set<(event: WatchEvent) => void>> = new Map();
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    private lastPollTime: number = Date.now();

    /**
     * @param path - SQLite database path, or ':memory:' for in-memory
     */
    constructor(path: string) {
        this.db = new Database(path);
        this.init();
    }

    private init(): void {
        // Enable WAL mode for better concurrency
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA synchronous = NORMAL');

        // Create storage table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS storage (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL,
                mtime INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
            )
        `);

        // Index for prefix queries
        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_storage_key ON storage(key)
        `);

        // Trigger to update mtime on update
        this.db.run(`
            CREATE TRIGGER IF NOT EXISTS update_mtime
            AFTER UPDATE ON storage
            BEGIN
                UPDATE storage SET mtime = strftime('%s', 'now') * 1000
                WHERE key = NEW.key;
            END
        `);
    }

    async get(key: string): Promise<Uint8Array | null> {
        const row = this.db.query('SELECT value FROM storage WHERE key = ?').get(key) as
            | { value: Uint8Array }
            | null;
        return row?.value ?? null;
    }

    async put(key: string, value: Uint8Array): Promise<void> {
        this.db.run('INSERT OR REPLACE INTO storage (key, value, mtime) VALUES (?, ?, ?)', [
            key,
            value,
            Date.now(),
        ]);
        this.emit({ key, op: 'put', value, timestamp: Date.now() });
    }

    async delete(key: string): Promise<void> {
        this.db.run('DELETE FROM storage WHERE key = ?', [key]);
        this.emit({ key, op: 'delete', timestamp: Date.now() });
    }

    async *list(prefix: string): AsyncIterable<string> {
        const pattern = prefix + '%';
        const rows = this.db.query('SELECT key FROM storage WHERE key LIKE ? ORDER BY key').all(pattern) as Array<{
            key: string;
        }>;
        for (const row of rows) {
            yield row.key;
        }
    }

    async exists(key: string): Promise<boolean> {
        const row = this.db.query('SELECT 1 FROM storage WHERE key = ?').get(key);
        return row !== null;
    }

    async stat(key: string): Promise<StorageStat | null> {
        const row = this.db.query('SELECT length(value) as size, mtime FROM storage WHERE key = ?').get(key) as
            | { size: number; mtime: number }
            | null;
        return row ? { size: row.size, mtime: row.mtime } : null;
    }

    async begin(): Promise<Transaction> {
        // Use IMMEDIATE to acquire write lock at start, avoiding deadlocks
        this.db.run('BEGIN IMMEDIATE');
        return new SQLiteTransaction(this.db, this);
    }

    async *watch(pattern: string): AsyncIterable<WatchEvent> {
        // Convert glob pattern to tracking key
        const key = pattern;

        // Create a queue for this watcher
        const queue: WatchEvent[] = [];
        let resolve: (() => void) | null = null;

        const callback = (event: WatchEvent) => {
            if (this.matchPattern(pattern, event.key)) {
                queue.push(event);
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
            this.watchers.get(key)?.delete(callback);
            if (this.watchers.get(key)?.size === 0) {
                this.watchers.delete(key);
            }
        }
    }

    /**
     * Emit event to matching watchers
     */
    private emit(event: WatchEvent): void {
        for (const [pattern, callbacks] of this.watchers) {
            if (this.matchPattern(pattern, event.key)) {
                for (const callback of callbacks) {
                    callback(event);
                }
            }
        }
    }

    /**
     * Match key against glob pattern
     * Supports * (single segment) and ** (multiple segments)
     */
    private matchPattern(pattern: string, key: string): boolean {
        // Simple implementation: convert to regex
        const regex = pattern
            .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<<DOUBLESTAR>>>/g, '.*');
        return new RegExp(`^${regex}$`).test(key);
    }

    async close(): Promise<void> {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.db.close();
    }

    /**
     * Internal: commit transaction and emit events
     */
    _commit(): void {
        this.db.run('COMMIT');
    }

    /**
     * Internal: rollback transaction
     */
    _rollback(): void {
        this.db.run('ROLLBACK');
    }
}

/**
 * SQLite transaction implementation
 */
class SQLiteTransaction implements Transaction {
    private committed = false;
    private rolledBack = false;
    private events: WatchEvent[] = [];

    constructor(
        private db: Database,
        private engine: BunStorageEngine
    ) {}

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.committed && !this.rolledBack) {
            await this.rollback();
        }
    }

    async get(key: string): Promise<Uint8Array | null> {
        const row = this.db.query('SELECT value FROM storage WHERE key = ?').get(key) as
            | { value: Uint8Array }
            | null;
        return row?.value ?? null;
    }

    async put(key: string, value: Uint8Array): Promise<void> {
        this.db.run('INSERT OR REPLACE INTO storage (key, value, mtime) VALUES (?, ?, ?)', [
            key,
            value,
            Date.now(),
        ]);
        this.events.push({ key, op: 'put', value, timestamp: Date.now() });
    }

    async delete(key: string): Promise<void> {
        this.db.run('DELETE FROM storage WHERE key = ?', [key]);
        this.events.push({ key, op: 'delete', timestamp: Date.now() });
    }

    async commit(): Promise<void> {
        if (this.committed) return;
        this.committed = true;
        this.engine._commit();
        // Emit events after commit
        for (const event of this.events) {
            // Access private emit via casting
            (this.engine as any).emit(event);
        }
    }

    async rollback(): Promise<void> {
        if (this.committed || this.rolledBack) return;
        this.rolledBack = true;
        this.engine._rollback();
        this.events = [];
    }
}

/**
 * In-memory storage engine
 *
 * Useful for:
 * - Testing (fast, isolated)
 * - Standalone mode with ephemeral storage
 *
 * Caveats:
 * - All data lost on process exit
 * - No persistence
 * - Transactions are fake (no real isolation)
 */
export class MemoryStorageEngine implements StorageEngine {
    private data: Map<string, { value: Uint8Array; mtime: number }> = new Map();
    private watchers: Map<string, Set<(event: WatchEvent) => void>> = new Map();

    async get(key: string): Promise<Uint8Array | null> {
        const entry = this.data.get(key);
        return entry?.value ?? null;
    }

    async put(key: string, value: Uint8Array): Promise<void> {
        const timestamp = Date.now();
        this.data.set(key, { value, mtime: timestamp });
        this.emit({ key, op: 'put', value, timestamp });
    }

    async delete(key: string): Promise<void> {
        const timestamp = Date.now();
        this.data.delete(key);
        this.emit({ key, op: 'delete', timestamp });
    }

    async *list(prefix: string): AsyncIterable<string> {
        const keys = Array.from(this.data.keys())
            .filter((k) => k.startsWith(prefix))
            .sort();
        for (const key of keys) {
            yield key;
        }
    }

    async exists(key: string): Promise<boolean> {
        return this.data.has(key);
    }

    async stat(key: string): Promise<StorageStat | null> {
        const entry = this.data.get(key);
        if (!entry) return null;
        return { size: entry.value.length, mtime: entry.mtime };
    }

    async begin(): Promise<Transaction> {
        // Memory transactions don't provide real isolation
        // This is a simplified implementation for testing
        return new MemoryTransaction(this);
    }

    async *watch(pattern: string): AsyncIterable<WatchEvent> {
        const queue: WatchEvent[] = [];
        let resolve: (() => void) | null = null;

        const callback = (event: WatchEvent) => {
            if (this.matchPattern(pattern, event.key)) {
                queue.push(event);
                if (resolve) {
                    resolve();
                    resolve = null;
                }
            }
        };

        if (!this.watchers.has(pattern)) {
            this.watchers.set(pattern, new Set());
        }
        this.watchers.get(pattern)!.add(callback);

        try {
            while (true) {
                if (queue.length > 0) {
                    yield queue.shift()!;
                } else {
                    await new Promise<void>((r) => {
                        resolve = r;
                    });
                }
            }
        } finally {
            this.watchers.get(pattern)?.delete(callback);
            if (this.watchers.get(pattern)?.size === 0) {
                this.watchers.delete(pattern);
            }
        }
    }

    private emit(event: WatchEvent): void {
        for (const [pattern, callbacks] of this.watchers) {
            if (this.matchPattern(pattern, event.key)) {
                for (const callback of callbacks) {
                    callback(event);
                }
            }
        }
    }

    private matchPattern(pattern: string, key: string): boolean {
        const regex = pattern
            .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<<DOUBLESTAR>>>/g, '.*');
        return new RegExp(`^${regex}$`).test(key);
    }

    async close(): Promise<void> {
        this.data.clear();
        this.watchers.clear();
    }

    /**
     * Reset storage to empty state.
     * Testing convenience method.
     */
    reset(): void {
        this.data.clear();
    }

    /**
     * Internal: emit event (for transaction use)
     */
    _emit(event: WatchEvent): void {
        this.emit(event);
    }
}

/**
 * Memory transaction implementation
 */
class MemoryTransaction implements Transaction {
    private committed = false;
    private rolledBack = false;
    private operations: Array<{ type: 'put' | 'delete'; key: string; value?: Uint8Array }> = [];

    constructor(private engine: MemoryStorageEngine) {}

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.committed && !this.rolledBack) {
            await this.rollback();
        }
    }

    async get(key: string): Promise<Uint8Array | null> {
        // Check pending operations first
        for (let i = this.operations.length - 1; i >= 0; i--) {
            const op = this.operations[i];
            if (op.key === key) {
                return op.type === 'put' ? op.value! : null;
            }
        }
        return this.engine.get(key);
    }

    async put(key: string, value: Uint8Array): Promise<void> {
        this.operations.push({ type: 'put', key, value });
    }

    async delete(key: string): Promise<void> {
        this.operations.push({ type: 'delete', key });
    }

    async commit(): Promise<void> {
        if (this.committed) return;
        this.committed = true;

        const timestamp = Date.now();
        for (const op of this.operations) {
            if (op.type === 'put') {
                await this.engine.put(op.key, op.value!);
            } else {
                await this.engine.delete(op.key);
            }
        }
    }

    async rollback(): Promise<void> {
        if (this.committed || this.rolledBack) return;
        this.rolledBack = true;
        this.operations = [];
    }
}
