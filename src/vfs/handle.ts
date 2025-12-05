/**
 * FileHandle - Capability-based file I/O interface
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * FileHandle represents an open file and provides the I/O interface for reading,
 * writing, and seeking within the file. In Monk OS's capability-based security
 * model, the handle IS the capability - possession of a valid handle implies
 * that permission was checked and granted at open() time.
 *
 * This design has several important implications:
 * - No per-operation permission checks (already validated at open)
 * - Handles can be passed between processes (capability delegation)
 * - Revocation requires invalidating the handle (not changing ACLs)
 * - Handle leaks are security leaks (must be closed when done)
 *
 * The FileHandle interface is model-agnostic. Different models (FileModel,
 * DeviceModel, NetworkModel) implement this interface differently. A file
 * handle provides random access, while a network handle is stream-only.
 *
 * STATE MACHINE
 * =============
 *
 *   open() ──────────> OPEN ──────────> CLOSED
 *                       │                  ^
 *                       │ close() or       │
 *                       │ error            │
 *                       │                  │
 *                       └──────────────────┘
 *
 * Once closed:
 * - All I/O methods throw EBADF
 * - close() is idempotent (safe to call multiple times)
 * - Handle cannot be reopened (must open() again)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Once closed, no I/O operations are permitted (throw EBADF)
 * INV-2: flags are immutable after construction
 * INV-3: id is unique within a process (UUID or similar)
 * INV-4: read requires flags.read; write requires flags.write
 * INV-5: close() is idempotent - multiple calls are safe
 *
 * CONCURRENCY MODEL
 * =================
 * Each FileHandle instance is independent. Operations on the same handle
 * should be serialized (JavaScript event loop guarantees this for single
 * async chains). Multiple handles to the same file operate independently
 * with last-writer-wins semantics.
 *
 * MEMORY MANAGEMENT
 * =================
 * - FileHandle implementations may buffer content in memory
 * - close() releases internal buffers
 * - Use `await using` pattern for automatic cleanup
 * - Unclosed handles leak resources until process exit
 *
 * @module vfs/handle
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Open flags controlling handle behavior.
 *
 * These flags mirror POSIX open() flags but are represented as a typed object
 * rather than bitmask for clarity and type safety.
 *
 * DESIGN DECISIONS:
 * - All flags optional (defaults to read-only)
 * - Boolean flags avoid magic numbers
 * - Flags are immutable after open()
 *
 * FLAG COMBINATIONS:
 * - { read: true } - Read-only access
 * - { write: true } - Write-only access
 * - { read: true, write: true } - Read-write access
 * - { write: true, create: true } - Create or write
 * - { write: true, create: true, exclusive: true } - Create only (fail if exists)
 * - { write: true, truncate: true } - Overwrite existing content
 * - { write: true, append: true } - Append to end
 */
export interface OpenFlags {
    /**
     * Open for reading.
     *
     * WHY optional: Defaults to false. At least one of read/write should be set.
     */
    read?: boolean;

    /**
     * Open for writing.
     *
     * WHY optional: Defaults to false. Enables write() and content modification.
     */
    write?: boolean;

    /**
     * Create file if it doesn't exist.
     *
     * WHY optional: Only meaningful with write. Without this, open fails on
     * non-existent files.
     */
    create?: boolean;

    /**
     * Fail if file exists (used with create).
     *
     * WHY: Enables atomic create-if-not-exists. Prevents race conditions
     * where two processes try to create the same file.
     *
     * POSIX equivalent: O_EXCL
     */
    exclusive?: boolean;

    /**
     * Truncate file to zero length on open.
     *
     * WHY: Common pattern for overwriting files. Happens atomically at open.
     *
     * POSIX equivalent: O_TRUNC
     */
    truncate?: boolean;

    /**
     * Writes always append to end.
     *
     * WHY: Enables safe concurrent appends. Position is moved to EOF before
     * each write, regardless of seek position.
     *
     * POSIX equivalent: O_APPEND
     */
    append?: boolean;
}

/**
 * Seek reference point.
 *
 * Defines the origin for seek offset calculations.
 *
 * WHY string literals: More readable than SEEK_SET/SEEK_CUR/SEEK_END constants.
 */
export type SeekWhence =
    /** Offset from beginning of file */
    | 'start'
    /** Offset from current position */
    | 'current'
    /** Offset from end of file (typically negative) */
    | 'end';

// =============================================================================
// FILE HANDLE INTERFACE
// =============================================================================

/**
 * FileHandle interface for I/O operations.
 *
 * Implements AsyncDisposable for use with `await using` pattern, ensuring
 * handles are closed even when exceptions occur.
 *
 * USAGE EXAMPLE:
 * ```typescript
 * await using handle = await vfs.open('/path', { read: true });
 * const data = await handle.read();
 * // handle automatically closed on scope exit
 * ```
 *
 * IMPLEMENTATION NOTES:
 * - All methods are async (storage may be remote)
 * - Errors are thrown as typed exceptions (EBADF, EACCES, etc.)
 * - Position is maintained internally (tell/seek to query/modify)
 */
export interface FileHandle extends AsyncDisposable {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique handle identifier.
     *
     * WHY: Enables handle tracking, logging, and revocation by kernel.
     * Format is implementation-defined (typically UUID).
     *
     * INVARIANT: Unique within the lifetime of the process.
     */
    readonly id: string;

    /**
     * Path this handle was opened with.
     *
     * WHY: Useful for error messages and debugging.
     *
     * NOTE: May be empty for handles opened by UUID.
     */
    readonly path: string;

    /**
     * Flags this handle was opened with.
     *
     * WHY: Allows callers to check what operations are permitted.
     *
     * INVARIANT: Immutable after construction.
     */
    readonly flags: OpenFlags;

    /**
     * True if handle has been closed or revoked.
     *
     * WHY: Allows callers to check handle validity without try/catch.
     *
     * INVARIANT: Once true, never becomes false.
     */
    readonly closed: boolean;

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    /**
     * Read bytes from current position.
     *
     * ALGORITHM:
     * 1. Read up to 'size' bytes from current position
     * 2. Advance position by bytes actually read
     * 3. Return bytes read (may be less than size at EOF)
     *
     * WHY returns less than size: At EOF, fewer bytes remain. Caller should
     * check returned array length, not assume full read.
     *
     * @param size - Maximum bytes to read (default: all remaining)
     * @returns Bytes read (empty Uint8Array at EOF)
     * @throws EBADF - If handle is closed/revoked
     * @throws EACCES - If not opened for reading
     */
    read(size?: number): Promise<Uint8Array>;

    // =========================================================================
    // WRITE OPERATIONS
    // =========================================================================

    /**
     * Write bytes at current position (or end if append mode).
     *
     * ALGORITHM:
     * 1. If append mode, seek to end first
     * 2. Write data at current position
     * 3. Advance position by bytes written
     * 4. Return bytes written (normally equals data.length)
     *
     * WHY returns count: Allows detection of partial writes (e.g., disk full).
     * Most implementations write all or throw.
     *
     * @param data - Bytes to write
     * @returns Number of bytes written
     * @throws EBADF - If handle is closed/revoked
     * @throws EACCES - If not opened for writing
     * @throws ENOSPC - If storage quota exceeded
     */
    write(data: Uint8Array): Promise<number>;

    // =========================================================================
    // POSITION OPERATIONS
    // =========================================================================

    /**
     * Seek to position in file.
     *
     * ALGORITHM:
     * 1. Calculate new position based on whence
     * 2. Validate position (>= 0)
     * 3. Update internal position
     * 4. Return new absolute position
     *
     * WHY seeking past EOF is allowed: POSIX semantics. Subsequent writes
     * create sparse regions (zeros). Reads past EOF return empty.
     *
     * @param offset - Byte offset from whence
     * @param whence - Reference point: 'start', 'current', or 'end'
     * @returns New absolute position
     * @throws EBADF - If handle is closed/revoked
     * @throws EINVAL - If seek not supported or would result in negative position
     */
    seek(offset: number, whence: SeekWhence): Promise<number>;

    /**
     * Get current position.
     *
     * Equivalent to seek(0, 'current') but doesn't modify position.
     *
     * @returns Current byte offset from start of file
     */
    tell(): Promise<number>;

    // =========================================================================
    // SYNC OPERATIONS
    // =========================================================================

    /**
     * Flush pending writes to storage.
     *
     * WHY explicit sync: Writes may be buffered for performance. sync()
     * ensures data is durably stored before returning.
     *
     * @throws EBADF - If handle is closed/revoked
     */
    sync(): Promise<void>;

    /**
     * Close handle and release resources.
     *
     * ALGORITHM:
     * 1. Flush any pending writes
     * 2. Mark handle as closed
     * 3. Release internal buffers
     *
     * INVARIANT: Safe to call multiple times (idempotent).
     *
     * WHY no throw on error: Errors during close are logged but not thrown.
     * The handle is closed regardless, and callers rarely handle close errors.
     */
    close(): Promise<void>;
}

// =============================================================================
// OPEN OPTIONS
// =============================================================================

/**
 * Additional options for opening files.
 *
 * Extends basic flags with model-specific options.
 */
export interface OpenOptions {
    /**
     * Open specific version (read-only, versioned files only).
     *
     * WHY: Versioned files maintain history. This allows reading old versions
     * without restoring them.
     *
     * CONSTRAINT: Only valid with read flag, not write.
     */
    version?: number;

    /**
     * Enable versioning for this write session.
     *
     * WHY: Opt-in versioning per write. Not all files need version history.
     * Enabling creates a new version on close() instead of overwriting.
     */
    versioned?: boolean;
}
