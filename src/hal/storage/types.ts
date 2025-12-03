/**
 * Storage Types - Interfaces for structured storage implementations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines the core types and interfaces for Monk OS's storage layer.
 * It provides a unified interface for key-value storage with transactions and
 * change subscriptions, abstracting underlying implementations (SQLite, PostgreSQL,
 * memory, etc.).
 *
 * The StorageEngine interface provides:
 * 1. CRUD operations (get, put, delete, list)
 * 2. ACID transactions (begin, commit, rollback)
 * 3. Change subscriptions (watch)
 * 4. Metadata queries (exists, stat)
 *
 * Design principles:
 * - Simple key-value model (keys are strings, values are binary)
 * - Transactions provide atomicity via buffered events
 * - Watch patterns enable reactive data flows
 * - Async interfaces support both sync (SQLite) and async (network) backends
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Keys are non-empty strings
 * INV-2: Values are Uint8Array (binary-safe)
 * INV-3: Transactions are isolated until commit
 * INV-4: Watch events are emitted only after commit (for transactional operations)
 * INV-5: StorageStat.mtime is in milliseconds since epoch
 *
 * CONCURRENCY MODEL
 * =================
 * The interface is async but concurrency semantics depend on the implementation:
 *
 * - SQLite: Single writer, multiple readers (WAL mode)
 * - PostgreSQL: Full multi-writer concurrency with MVCC
 * - Memory: Single-threaded (no actual concurrency)
 *
 * Callers must not assume operations are atomic unless wrapped in a transaction.
 * Implementations must document their concurrency model.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Transactions prevent torn reads/writes
 * RC-2: Watch callbacks should not throw (implementation handles errors)
 * RC-3: Async iterators (list, watch) must clean up resources on break/return
 *
 * MEMORY MANAGEMENT
 * =================
 * - StorageEngine owns its connection/resources
 * - close() must release all resources
 * - Transaction implements AsyncDisposable for automatic cleanup
 * - Watch iterators clean up callbacks when stopped
 *
 * TESTABILITY
 * ===========
 * - Interface allows complete mocking for unit tests
 * - In-memory implementation provides fast test backend
 * - Transactions are testable via get() after put() within transaction
 *
 * @module hal/storage/types
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Storage key metadata.
 *
 * WHY: Allows checking size and modification time without reading entire value.
 * Useful for caching, change detection, and quota management.
 *
 * TESTABILITY: Simple struct, easy to construct in tests.
 */
export interface StorageStat {
    /**
     * Value size in bytes.
     *
     * WHY: Allows quota enforcement and size-based decisions without reading value.
     * INVARIANT: Non-negative integer.
     */
    size: number;

    /**
     * Last modification time (milliseconds since epoch).
     *
     * WHY: Enables cache invalidation and change tracking.
     * INVARIANT: Milliseconds since epoch (not seconds).
     */
    mtime: number;
}

/**
 * Watch event emitted when data changes.
 *
 * WHY: Enables reactive patterns - processes can watch for changes to keys
 * and react accordingly (cache invalidation, UI updates, etc.).
 *
 * TESTABILITY: Simple struct, easy to construct and assert in tests.
 */
export interface WatchEvent {
    /**
     * Key that changed.
     *
     * WHY: Identifies which key was modified.
     */
    key: string;

    /**
     * Type of change.
     *
     * WHY: Allows different handling for puts vs deletes.
     * INVARIANT: Only 'put' or 'delete'.
     */
    op: 'put' | 'delete';

    /**
     * New value (undefined for delete).
     *
     * WHY: Provides the new value for put operations, avoiding additional get().
     * Undefined for deletes since there is no new value.
     */
    value?: Uint8Array;

    /**
     * Timestamp of change (milliseconds since epoch).
     *
     * WHY: Allows time-based filtering and ordering of events.
     * INVARIANT: Milliseconds since epoch (not seconds).
     */
    timestamp: number;
}

/**
 * Transaction handle for atomic operations.
 *
 * WHY: Provides ACID properties for groups of operations. All operations within
 * a transaction are isolated from other transactions and committed atomically.
 *
 * USAGE:
 * ```typescript
 * await using tx = await storage.begin();
 * await tx.put('key1', value1);
 * await tx.put('key2', value2);
 * await tx.commit(); // Both puts committed atomically
 * // If exception thrown before commit, automatically rolled back
 * ```
 *
 * INVARIANTS:
 * - Once committed, transaction cannot be used again
 * - Once rolled back, transaction cannot be used again
 * - If neither commit nor rollback called, rollback happens on dispose
 *
 * TESTABILITY: AsyncDisposable enables automatic cleanup in tests.
 */
export interface Transaction extends AsyncDisposable {
    /**
     * Get value by key within transaction.
     *
     * WHY: Reads uncommitted changes from current transaction. Allows
     * read-modify-write patterns within a transaction.
     *
     * @param key - Key to retrieve
     * @returns Value bytes or null if not found
     */
    get(key: string): Promise<Uint8Array | null>;

    /**
     * Store value by key within transaction.
     *
     * WHY: Buffers write until commit. Allows atomic multi-key updates.
     *
     * @param key - Key to store
     * @param value - Value bytes to store
     */
    put(key: string, value: Uint8Array): Promise<void>;

    /**
     * Delete key within transaction.
     *
     * WHY: Buffers delete until commit. Allows atomic multi-key deletes.
     *
     * @param key - Key to delete
     */
    delete(key: string): Promise<void>;

    /**
     * Commit transaction.
     *
     * ALGORITHM:
     * 1. Apply all buffered operations atomically
     * 2. Emit watch events for all changes
     * 3. Release transaction lock
     *
     * WHY: Makes all operations visible to other transactions/operations.
     *
     * INVARIANT: Idempotent (no-op if already committed).
     * RACE CONDITION: After commit, other transactions can see changes.
     *
     * @returns Promise that resolves when commit is complete
     */
    commit(): Promise<void>;

    /**
     * Rollback transaction.
     *
     * ALGORITHM:
     * 1. Discard all buffered operations
     * 2. Release transaction lock
     * 3. Do not emit any watch events
     *
     * WHY: Aborts transaction, making no changes visible.
     *
     * INVARIANT: Idempotent (no-op if already committed or rolled back).
     *
     * @returns Promise that resolves when rollback is complete
     */
    rollback(): Promise<void>;
}

/**
 * Storage engine interface.
 *
 * WHY: Provides structured key-value storage with transactions and subscriptions.
 * This is the primary data store for VFS metadata and application data.
 *
 * DESIGN RATIONALE:
 * - Binary values (Uint8Array) avoid encoding assumptions
 * - Async methods support both sync (SQLite) and async (network) backends
 * - Prefix-based listing enables hierarchical key namespaces
 * - Transactions provide ACID properties for complex operations
 * - Watch patterns enable reactive data flows
 *
 * TESTABILITY: Interface allows mocking and in-memory implementations for tests.
 */
export interface StorageEngine {
    // =========================================================================
    // BASIC OPERATIONS
    // =========================================================================

    /**
     * Get value by key.
     *
     * ALGORITHM:
     * 1. Look up key in backing store
     * 2. Return value bytes or null if not found
     *
     * WHY: Primary read operation for retrieving stored data.
     *
     * @param key - Key to retrieve
     * @returns Value bytes or null if not found
     */
    get(key: string): Promise<Uint8Array | null>;

    /**
     * Store value by key.
     *
     * ALGORITHM:
     * 1. Write value to backing store (insert or update)
     * 2. Update mtime to current time
     * 3. Emit watch event to subscribers
     *
     * WHY: Primary write operation for storing data. Overwrites if key exists.
     *
     * RACE CONDITION: Concurrent puts to same key will serialize.
     * Last write wins (no conflict detection).
     *
     * @param key - Key to store
     * @param value - Value bytes to store
     */
    put(key: string, value: Uint8Array): Promise<void>;

    /**
     * Delete key.
     *
     * ALGORITHM:
     * 1. Remove key from backing store
     * 2. Emit watch event to subscribers
     *
     * WHY: Removes data from storage. No error if key doesn't exist.
     *
     * @param key - Key to delete
     */
    delete(key: string): Promise<void>;

    // =========================================================================
    // LISTING AND METADATA
    // =========================================================================

    /**
     * List keys matching prefix in lexicographic order.
     *
     * ALGORITHM:
     * 1. Scan keys starting with prefix
     * 2. Yield keys in lexicographic order
     *
     * WHY: Enables hierarchical key namespaces (e.g., 'user/123/' for all
     * data belonging to user 123). Async generator allows streaming large
     * result sets.
     *
     * PATTERN:
     * - Empty string matches all keys
     * - 'user/' matches all keys starting with 'user/'
     * - No wildcard support (use watch() for pattern matching)
     *
     * @param prefix - Key prefix to match (empty string for all)
     * @yields Matching keys in lexicographic order
     */
    list(prefix: string): AsyncIterable<string>;

    /**
     * Check if key exists without reading value.
     *
     * WHY: More efficient than get() when only existence is needed.
     * Useful for validation and conditional operations.
     *
     * @param key - Key to check
     * @returns true if key exists
     */
    exists(key: string): Promise<boolean>;

    /**
     * Get key metadata without reading value.
     *
     * WHY: Allows checking size and mtime without loading potentially large
     * value into memory. Useful for caching and quota management.
     *
     * @param key - Key to stat
     * @returns Metadata (size, mtime) or null if not found
     */
    stat(key: string): Promise<StorageStat | null>;

    // =========================================================================
    // TRANSACTIONS
    // =========================================================================

    /**
     * Begin a new transaction.
     *
     * ALGORITHM:
     * 1. Acquire write lock (implementation-dependent)
     * 2. Return transaction handle
     * 3. Transaction buffers operations until commit/rollback
     *
     * WHY: Provides ACID properties for groups of operations. All operations
     * within a transaction are isolated and committed atomically.
     *
     * CONCURRENCY:
     * - SQLite: Only one write transaction at a time. Concurrent begin() calls
     *   will block until previous transaction commits.
     * - PostgreSQL: Multiple concurrent transactions with MVCC.
     *
     * USAGE:
     * ```typescript
     * await using tx = await storage.begin();
     * await tx.put('key1', value1);
     * await tx.put('key2', value2);
     * await tx.commit();
     * ```
     *
     * @returns Transaction handle
     */
    begin(): Promise<Transaction>;

    // =========================================================================
    // CHANGE SUBSCRIPTIONS
    // =========================================================================

    /**
     * Watch for changes matching pattern.
     *
     * ALGORITHM:
     * 1. Register callback for matching keys
     * 2. Yield events as they occur
     * 3. Clean up callback when iterator breaks
     *
     * PATTERN SYNTAX:
     * - * matches any characters in a single segment (no /)
     * - ** matches any characters across segments (including /)
     * - Literal strings match exactly
     *
     * EXAMPLES:
     * - 'user/123/*' matches 'user/123/name', not 'user/123/posts/1'
     * - 'user/123/**' matches 'user/123/name' and 'user/123/posts/1'
     * - 'user/123/name' matches only 'user/123/name'
     *
     * WHY: Enables reactive patterns - processes can watch for changes and
     * react accordingly (cache invalidation, UI updates, etc.).
     *
     * CAVEATS:
     * - SQLite: Uses polling (no native notifications). Changes made outside
     *   this process are detected on next poll, not immediately.
     * - PostgreSQL: Uses LISTEN/NOTIFY for real-time notifications.
     * - In-memory: Immediate notification (same process).
     *
     * MEMORY: Iterator holds a callback reference. Breaking the iterator
     * cleans up the callback automatically.
     *
     * @param pattern - Glob pattern to match keys
     * @yields Change events for matching keys
     */
    watch(pattern: string): AsyncIterable<WatchEvent>;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close the storage engine and release resources.
     *
     * ALGORITHM:
     * 1. Clear all watch subscriptions
     * 2. Close database connection
     * 3. Release any other resources
     *
     * WHY: Ensures clean shutdown and resource release.
     *
     * INVARIANT: After close(), all operations must fail.
     *
     * @returns Promise that resolves when cleanup is complete
     */
    close(): Promise<void>;
}
