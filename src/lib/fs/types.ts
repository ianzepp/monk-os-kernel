/**
 * FS Type Definitions
 *
 * Core interfaces for the Filesystem abstraction layer.
 * Provides a unified filesystem interface over database-backed storage and API mounts.
 */

/**
 * Filesystem entry metadata
 */
export interface FSEntry {
    name: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    mode: number;
    uid?: string;
    gid?: string;
    atime?: Date;
    mtime?: Date;
    ctime?: Date;
    target?: string;
}

/**
 * FS error codes following POSIX conventions
 */
export type FSErrorCode =
    | 'ENOENT'    // No such file or directory
    | 'EEXIST'    // File exists
    | 'EISDIR'    // Is a directory (can't read as file)
    | 'ENOTDIR'   // Not a directory (can't list)
    | 'EACCES'    // Permission denied
    | 'ENOTEMPTY' // Directory not empty
    | 'EROFS'     // Read-only filesystem
    | 'EINVAL'    // Invalid argument
    | 'ENOSPC'    // No space left on device
    | 'EIO';      // I/O error

/**
 * FS-specific error class
 */
export class FSError extends Error {
    constructor(
        public code: FSErrorCode,
        public path: string,
        message?: string
    ) {
        super(message || `${code}: ${path}`);
        this.name = 'FSError';
    }
}

/**
 * Mount interface - implemented by each filesystem backend
 *
 * All paths passed to mount methods are relative to the mount point.
 * For example, if mounted at "/api/data", a request for "/api/data/users/123.json"
 * will call the mount with path "/users/123.json".
 */
/** Entry type for lightweight type checking */
export type FSEntryType = 'file' | 'directory' | 'symlink';

export interface Mount {
    /**
     * Get entry type from path structure (optional, no I/O)
     *
     * Returns the type if determinable from path alone, null otherwise.
     * Mounts with fixed path structures (e.g., DataMount) can implement this
     * to avoid database queries when only the type is needed.
     *
     * @param path - Path relative to mount point
     * @returns Entry type or null if I/O required
     */
    getType?(path: string): FSEntryType | null;

    /**
     * Get metadata for a file or directory
     */
    stat(path: string): Promise<FSEntry>;

    /**
     * List directory contents
     */
    readdir(path: string): Promise<FSEntry[]>;

    /**
     * Read file contents
     */
    read(path: string): Promise<string | Buffer>;

    /**
     * Write file contents (optional - omit for read-only mounts)
     */
    write?(path: string, content: string | Buffer): Promise<void>;

    /**
     * Append to file (optional)
     */
    append?(path: string, content: string | Buffer): Promise<void>;

    /**
     * Truncate file to size (optional)
     */
    truncate?(path: string, size: number): Promise<void>;

    /**
     * Delete a file (optional)
     */
    unlink?(path: string): Promise<void>;

    /**
     * Create a directory (optional)
     */
    mkdir?(path: string, mode?: number): Promise<void>;

    /**
     * Remove a directory (optional)
     */
    rmdir?(path: string): Promise<void>;

    /**
     * Rename/move a file or directory (optional)
     */
    rename?(oldPath: string, newPath: string): Promise<void>;

    /**
     * Change permissions (optional)
     */
    chmod?(path: string, mode: number): Promise<void>;

    /**
     * Change ownership (optional)
     */
    chown?(path: string, uid: string, gid?: string): Promise<void>;

    /**
     * Create a symbolic link (optional)
     */
    symlink?(target: string, path: string): Promise<void>;

    /**
     * Read symbolic link target (optional)
     */
    readlink?(path: string): Promise<string>;

    /**
     * Get disk usage for a path (optional)
     *
     * Returns total size in bytes of the file or directory tree.
     * For files: returns the file size.
     * For directories: returns the sum of all descendant file sizes.
     *
     * This method is designed for efficient `du` (disk usage) operations.
     * Mounts can implement this with optimized queries (e.g., single SQL SUM)
     * rather than requiring recursive stat() calls.
     *
     * If not implemented, callers should fall back to recursive traversal
     * using readdir() + stat().
     *
     * @param path - Path to calculate usage for
     * @returns Total size in bytes
     */
    getUsage?(path: string): Promise<number>;
}

/**
 * Result of resolving a path to its mount handler
 */
export interface ResolvedPath {
    handler: Mount;
    relativePath: string;
    mountPath: string;
}
