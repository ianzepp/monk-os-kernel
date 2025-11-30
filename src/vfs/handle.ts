/**
 * FileHandle
 *
 * Result of opening a path. Provides I/O operations on an open file.
 * The handle is the capability - permission was checked at open() time.
 */

/**
 * Open flags (combinable)
 */
export type OpenFlags = {
    /** Open for reading */
    read?: boolean;
    /** Open for writing */
    write?: boolean;
    /** Create if doesn't exist */
    create?: boolean;
    /** Fail if exists (with create) */
    exclusive?: boolean;
    /** Truncate to zero length */
    truncate?: boolean;
    /** Append to end on write */
    append?: boolean;
};

/**
 * Seek reference point
 */
export type SeekWhence = 'start' | 'current' | 'end';

/**
 * FileHandle interface for I/O operations.
 *
 * Implements AsyncDisposable for use with `await using`:
 * ```typescript
 * await using handle = await vfs.open('/path', { read: true });
 * const data = await handle.read();
 * // auto-closed on scope exit
 * ```
 */
export interface FileHandle extends AsyncDisposable {
    /** Unique handle identifier (for tracking/revocation) */
    readonly id: string;

    /** Path this handle was opened with */
    readonly path: string;

    /** Flags this handle was opened with */
    readonly flags: OpenFlags;

    /** True if handle has been closed or revoked */
    readonly closed: boolean;

    /**
     * Read bytes from current position.
     *
     * @param size - Maximum bytes to read (default: all remaining)
     * @returns Bytes read (may be less than size at EOF)
     * @throws EBADF if handle closed/revoked
     * @throws EACCES if not opened for reading
     */
    read(size?: number): Promise<Uint8Array>;

    /**
     * Write bytes at current position (or end if append mode).
     *
     * @param data - Bytes to write
     * @returns Number of bytes written
     * @throws EBADF if handle closed/revoked
     * @throws EACCES if not opened for writing
     * @throws ENOSPC if quota exceeded
     */
    write(data: Uint8Array): Promise<number>;

    /**
     * Seek to position.
     *
     * Not all models support seeking (e.g., network streams).
     *
     * @param offset - Byte offset
     * @param whence - Reference point for offset
     * @returns New absolute position
     * @throws EBADF if handle closed/revoked
     * @throws EINVAL if seek not supported or invalid position
     */
    seek(offset: number, whence: SeekWhence): Promise<number>;

    /**
     * Get current position.
     *
     * @returns Current byte offset
     */
    tell(): Promise<number>;

    /**
     * Flush pending writes to storage.
     *
     * @throws EBADF if handle closed/revoked
     */
    sync(): Promise<void>;

    /**
     * Close handle and release resources.
     *
     * Safe to call multiple times.
     */
    close(): Promise<void>;
}

/**
 * Options for opening a file
 */
export interface OpenOptions {
    /** Open specific version (read-only, versioned files only) */
    version?: number;

    /** Enable versioning for this write session */
    versioned?: boolean;
}
