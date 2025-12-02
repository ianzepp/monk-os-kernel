/**
 * Storage Types
 *
 * Shared types and interfaces for storage implementations.
 */

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
