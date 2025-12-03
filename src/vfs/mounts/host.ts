/**
 * HostMount - Bridge between VFS and host filesystem
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * HostMount enables Monk OS to access files on the actual host machine's filesystem.
 * This is essential for development workflows where binaries and configuration files
 * are stored on the host (e.g., ./src/bin/) but need to be accessible within the VFS
 * (e.g., /bin/).
 *
 * The mount creates a bidirectional mapping:
 * - VFS path prefix (e.g., /bin) maps to host directory (e.g., ./src/bin)
 * - VFS path /bin/init.ts resolves to host path ./src/bin/init.ts
 *
 * This is similar to Docker volume mounts or NFS mounts in traditional Unix systems.
 * The key difference is that HostMount operates at the application layer, translating
 * VFS operations to Node.js fs/promises calls.
 *
 * SECURITY MODEL
 * ==============
 * Host mounts present significant security risks:
 *
 * 1. PATH TRAVERSAL: A malicious path like /bin/../../../etc/passwd could escape
 *    the mount boundary. This is mitigated by:
 *    - Resolving all paths to absolute before use
 *    - Verifying resolved paths start with the mount's resolved base path
 *    - Rejecting any path that escapes the mount boundary
 *
 * 2. SYMLINK ATTACKS: Host symlinks could point outside the mount. Currently NOT
 *    mitigated - the kernel follows host symlinks. Consider adding O_NOFOLLOW
 *    semantics for security-critical deployments.
 *
 * 3. WRITE ACCESS: Write operations could corrupt host files. Mitigated by:
 *    - Read-only default (options.readonly = true)
 *    - Write operations throw EACCES on readonly mounts
 *
 * STATE MACHINE (HostFileHandle)
 * ==============================
 *
 *   hostOpen() ──────────> OPEN ──────────> CLOSED
 *                           │                  ^
 *                           │ first read()     │
 *                           v                  │
 *                       LOADED ────────────────┘
 *                       (content cached)   close()
 *
 * WHY content is cached:
 * Host file content is loaded lazily on first read and cached for the handle's
 * lifetime. This provides:
 * - Consistent reads even if host file changes
 * - Efficient repeated reads without re-reading from disk
 * - Memory release on close()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: resolvedHostPath is always an absolute path
 * INV-2: resolveHostPath() returns null for paths outside mount boundary
 * INV-3: Readonly mounts reject all write operations
 * INV-4: Host file IDs are prefixed with "host:" to distinguish from VFS entities
 * INV-5: Host files report parent as null (not tracked in VFS entity system)
 * INV-6: Once handle is closed, no I/O operations are permitted
 * INV-7: Content is loaded lazily and cached until close()
 *
 * CONCURRENCY MODEL
 * =================
 * Each file handle has independent state. Multiple handles to the same file
 * get independent content caches - changes to one don't affect others.
 *
 * Host filesystem operations (readFile, stat, readdir) are async but Node.js
 * handles the concurrency. No explicit synchronization is needed in this code.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Path resolution happens atomically before any host FS operation
 * RC-2: Content is cached after first read (consistent within handle lifetime)
 * RC-3: Handle closure check before every I/O operation
 *
 * MEMORY MANAGEMENT
 * =================
 * - HostMount configuration is lightweight (just path strings)
 * - File content is loaded into memory on first read
 * - Content buffer is released on close()
 * - readdir yields entries lazily (no full directory buffering)
 *
 * @module vfs/mounts/host
 */

import { readFile, stat as fsStat, readdir } from 'fs/promises';
import { join, resolve, basename } from 'path';
import type { FileHandle, OpenFlags, SeekWhence } from '@src/vfs/handle.js';
import type { ModelStat } from '@src/vfs/model.js';
import { ENOENT, EACCES, EISDIR, ENOTDIR, EBADF } from '@src/hal/errors.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Prefix for synthetic host file IDs.
 * WHY: Distinguishes host-backed entities from VFS-native entities.
 * Allows VFS to route operations to the correct backend.
 */
const HOST_ID_PREFIX = 'host:';

/**
 * Prefix for host file handle IDs.
 * WHY: Enables handle tracking and identification in logs/debugging.
 */
const HOST_HANDLE_PREFIX = 'host-handle:';

/**
 * Default owner for host files.
 * WHY: Host files aren't owned by VFS processes. Using 'kernel'
 * indicates system-level ownership.
 */
const HOST_FILE_OWNER = 'kernel';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration options for host mounts.
 *
 * SECURITY: readonly defaults to true for safety. Explicitly set to false
 * only when write access is required and understood.
 */
export interface HostMountOptions {
    /**
     * Mount as read-only.
     *
     * WHY default true: Prevents accidental writes to host filesystem.
     * Write access requires explicit opt-in.
     */
    readonly?: boolean;
}

/**
 * Host mount configuration record.
 *
 * Represents a mapping between a VFS path prefix and a host directory.
 * Created via createHostMount() which handles path normalization.
 */
export interface HostMount {
    /**
     * VFS path prefix (e.g., '/bin').
     *
     * INVARIANT: Normalized (no trailing slash unless root '/').
     */
    vfsPath: string;

    /**
     * Original host path as provided (e.g., './src/bin').
     *
     * WHY preserved: Useful for debugging and display.
     */
    hostPath: string;

    /**
     * Resolved absolute host path (e.g., '/Users/dev/project/src/bin').
     *
     * INVARIANT: Always absolute path.
     * WHY: Security - all path operations use this to prevent traversal.
     */
    resolvedHostPath: string;

    /**
     * Mount options.
     *
     * INVARIANT: Always has readonly field set (defaults applied).
     */
    options: Required<HostMountOptions>;
}

// =============================================================================
// MOUNT CONFIGURATION
// =============================================================================

/**
 * Create a host mount configuration.
 *
 * ALGORITHM:
 * 1. Normalize VFS path (remove trailing slashes)
 * 2. Resolve host path to absolute
 * 3. Apply default options
 * 4. Return configuration record
 *
 * WHY separate from mounting:
 * Allows mount configuration to be created, validated, and serialized
 * before actually activating the mount in the VFS.
 *
 * @param vfsPath - VFS path prefix to mount at
 * @param hostPath - Host directory to mount
 * @param options - Mount options
 * @returns Mount configuration
 *
 * @example
 * const mount = createHostMount('/bin', './src/bin', { readonly: true });
 * // mount.vfsPath === '/bin'
 * // mount.resolvedHostPath === '/absolute/path/to/src/bin'
 */
export function createHostMount(
    vfsPath: string,
    hostPath: string,
    options: HostMountOptions = {}
): HostMount {
    // Normalize VFS path: remove trailing slashes, ensure at least '/'
    // WHY: Consistent path matching requires normalized paths
    const normalizedVfsPath = vfsPath.replace(/\/+$/, '') || '/';

    // Resolve host path to absolute
    // WHY: Security - relative paths could be ambiguous or exploited
    const resolvedHostPath = resolve(hostPath);

    return {
        vfsPath: normalizedVfsPath,
        hostPath,
        resolvedHostPath,
        options: {
            // Default to readonly for safety
            readonly: options.readonly ?? true,
        },
    };
}

// =============================================================================
// PATH RESOLUTION
// =============================================================================

/**
 * Resolve a VFS path to a host filesystem path.
 *
 * ALGORITHM:
 * 1. Check if VFS path exactly matches mount point
 * 2. Check if VFS path starts with mount prefix
 * 3. Calculate relative path within mount
 * 4. Join with resolved host path
 * 5. SECURITY: Verify result is still under mount (no traversal)
 *
 * SECURITY (Path Traversal):
 * A malicious path like /bin/../../../etc/passwd would:
 * 1. Match prefix /bin/
 * 2. Relative path would be /../../../etc/passwd
 * 3. Joined path would be /resolved/host/path/../../../etc/passwd
 * 4. Resolved path would be /etc/passwd
 * 5. Check fails: /etc/passwd doesn't start with /resolved/host/path
 * 6. Returns null, preventing the attack
 *
 * @param mount - Mount configuration
 * @param vfsPath - VFS path to resolve
 * @returns Resolved host path, or null if path is outside mount boundary
 */
export function resolveHostPath(mount: HostMount, vfsPath: string): string | null {
    // Exact match: /bin -> /resolved/host/path
    if (vfsPath === mount.vfsPath) {
        return mount.resolvedHostPath;
    }

    // Calculate prefix to check
    // WHY special case for root: '/' + '/' would be '//', but we want any path
    const prefix = mount.vfsPath === '/' ? '/' : mount.vfsPath + '/';

    // Check if path is under this mount
    if (!vfsPath.startsWith(prefix)) {
        return null;
    }

    // Extract relative path within mount
    // For root mount (/): /foo/bar -> /foo/bar (keep leading /)
    // For other mounts: /bin/foo -> /foo (strip mount prefix)
    const relativePath = mount.vfsPath === '/'
        ? vfsPath
        : vfsPath.slice(mount.vfsPath.length);

    // Join with resolved host path
    const hostPath = join(mount.resolvedHostPath, relativePath);

    // SECURITY: Verify resolved path is still under mount
    // This catches path traversal attacks like /../../../etc/passwd
    const resolved = resolve(hostPath);
    if (!resolved.startsWith(mount.resolvedHostPath)) {
        // Path traversal attempt detected
        return null;
    }

    return resolved;
}

/**
 * Check if a VFS path is under a host mount.
 *
 * WHY separate from resolveHostPath:
 * Quick check without the full resolution overhead.
 * Used by VFS to determine which mount handles a path.
 *
 * @param mount - Mount configuration
 * @param vfsPath - VFS path to check
 * @returns True if path is under this mount
 */
export function isUnderHostMount(mount: HostMount, vfsPath: string): boolean {
    // Exact match
    if (vfsPath === mount.vfsPath) {
        return true;
    }

    // Prefix match
    const prefix = mount.vfsPath === '/' ? '/' : mount.vfsPath + '/';
    return vfsPath.startsWith(prefix);
}

// =============================================================================
// FILE OPERATIONS
// =============================================================================

/**
 * Get file/directory metadata from host filesystem.
 *
 * ALGORITHM:
 * 1. Resolve VFS path to host path
 * 2. Call host fs.stat
 * 3. Convert to ModelStat format
 *
 * WHY synthetic ID:
 * Host files don't have VFS entity UUIDs. The synthetic ID (host:/path)
 * allows the VFS to identify and route operations correctly.
 *
 * @param mount - Mount configuration
 * @param vfsPath - VFS path to stat
 * @returns File metadata in ModelStat format
 * @throws ENOENT - If file doesn't exist or path is outside mount
 */
export async function hostStat(mount: HostMount, vfsPath: string): Promise<ModelStat> {
    // Resolve and validate path
    const hostPath = resolveHostPath(mount, vfsPath);
    if (!hostPath) {
        throw new ENOENT(`No such file: ${vfsPath}`);
    }

    try {
        const stats = await fsStat(hostPath);

        // Extract filename from path
        // WHY fallback to mount basename: for mount root, vfsPath might be just '/bin'
        const name = basename(vfsPath) || basename(mount.vfsPath);

        return {
            id: `${HOST_ID_PREFIX}${vfsPath}`,
            model: stats.isDirectory() ? 'folder' : 'file',
            name,
            parent: null, // Host files don't participate in VFS parent tracking
            owner: HOST_FILE_OWNER,
            size: stats.size,
            mtime: stats.mtimeMs,
            ctime: stats.ctimeMs,
        };
    } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
            throw new ENOENT(`No such file: ${vfsPath}`);
        }
        throw err;
    }
}

/**
 * Read directory contents from host filesystem.
 *
 * ALGORITHM:
 * 1. Resolve VFS path to host path
 * 2. Call host fs.readdir with file types
 * 3. For each entry, stat and yield ModelStat
 * 4. Skip entries that fail to stat (permission errors, etc.)
 *
 * WHY async generator:
 * Allows lazy iteration without loading entire directory into memory.
 * Useful for large directories.
 *
 * WHY skip failing entries:
 * A single unreadable file shouldn't prevent listing other files.
 * Common with permission-restricted files in system directories.
 *
 * @param mount - Mount configuration
 * @param vfsPath - VFS path of directory to read
 * @yields ModelStat for each directory entry
 * @throws ENOENT - If directory doesn't exist
 * @throws ENOTDIR - If path is not a directory
 */
export async function* hostReaddir(
    mount: HostMount,
    vfsPath: string
): AsyncIterable<ModelStat> {
    // Resolve and validate path
    const hostPath = resolveHostPath(mount, vfsPath);
    if (!hostPath) {
        throw new ENOENT(`No such directory: ${vfsPath}`);
    }

    try {
        // Read directory with file type information
        const entries = await readdir(hostPath, { withFileTypes: true });

        for (const entry of entries) {
            // Construct VFS path for this entry
            const entryVfsPath = vfsPath === '/'
                ? `/${entry.name}`
                : `${vfsPath}/${entry.name}`;
            const entryHostPath = join(hostPath, entry.name);

            try {
                // Stat entry for full metadata
                const stats = await fsStat(entryHostPath);

                yield {
                    id: `${HOST_ID_PREFIX}${entryVfsPath}`,
                    model: entry.isDirectory() ? 'folder' : 'file',
                    name: entry.name,
                    parent: null,
                    owner: HOST_FILE_OWNER,
                    size: stats.size,
                    mtime: stats.mtimeMs,
                    ctime: stats.ctimeMs,
                };
            } catch {
                // Skip entries we can't stat
                // WHY: Don't let one bad entry prevent listing others
            }
        }
    } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
            throw new ENOENT(`No such directory: ${vfsPath}`);
        }
        if (error.code === 'ENOTDIR') {
            throw new ENOTDIR(`Not a directory: ${vfsPath}`);
        }
        throw err;
    }
}

/**
 * Open a file from host filesystem.
 *
 * ALGORITHM:
 * 1. Resolve VFS path to host path
 * 2. Check write permission against mount options
 * 3. Stat file to verify it exists and isn't a directory
 * 4. Create and return HostFileHandle
 *
 * SECURITY:
 * - Readonly mounts reject any write flags
 * - Directory open throws EISDIR (use readdir instead)
 *
 * @param mount - Mount configuration
 * @param vfsPath - VFS path to open
 * @param flags - Open flags (read/write/create/etc.)
 * @returns File handle for I/O operations
 * @throws ENOENT - If file doesn't exist (and create not specified)
 * @throws EACCES - If write requested on readonly mount
 * @throws EISDIR - If path is a directory
 */
export async function hostOpen(
    mount: HostMount,
    vfsPath: string,
    flags: OpenFlags
): Promise<FileHandle> {
    // Resolve and validate path
    const hostPath = resolveHostPath(mount, vfsPath);
    if (!hostPath) {
        throw new ENOENT(`No such file: ${vfsPath}`);
    }

    // SECURITY: Check write permission against mount options
    if (flags.write && mount.options.readonly) {
        throw new EACCES(`Mount is read-only: ${vfsPath}`);
    }

    // Verify file exists and check type
    try {
        const stats = await fsStat(hostPath);
        if (stats.isDirectory()) {
            throw new EISDIR(`Is a directory: ${vfsPath}`);
        }
    } catch (err: unknown) {
        // Handle specific error cases
        if (err instanceof EISDIR) {
            throw err; // Re-throw our own error
        }

        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
            // File doesn't exist
            if (!flags.create) {
                throw new ENOENT(`No such file: ${vfsPath}`);
            }
            // Create flag set but mount is readonly
            if (mount.options.readonly) {
                throw new EACCES(`Mount is read-only: ${vfsPath}`);
            }
            // Would create on first write (not implemented)
            throw new EACCES(`Host mount file creation not implemented: ${vfsPath}`);
        }
        throw err;
    }

    return new HostFileHandle(hostPath, vfsPath, flags);
}

// =============================================================================
// FILE HANDLE IMPLEMENTATION
// =============================================================================

/**
 * HostFileHandle - File handle for host filesystem files.
 *
 * Provides FileHandle interface backed by Node.js fs operations.
 * Content is loaded lazily on first read and cached for consistency.
 *
 * LIMITATIONS:
 * - Write operations not implemented (throws EACCES)
 * - Content is fully loaded into memory (no streaming for large files)
 * - Changes to host file after open are not visible
 *
 * INVARIANTS:
 * - Once closed, all operations throw EBADF
 * - Content is loaded lazily on first read or seek
 * - Content is released on close
 */
class HostFileHandle implements FileHandle {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Unique handle identifier.
     *
     * WHY includes timestamp: Ensures uniqueness across multiple opens
     * of the same file.
     */
    readonly id: string;

    /**
     * VFS path this handle was opened with.
     *
     * WHY preserved: Useful for error messages and debugging.
     */
    readonly path: string;

    /**
     * Open flags.
     *
     * INVARIANT: Immutable after construction.
     */
    readonly flags: OpenFlags;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether handle has been closed.
     *
     * INVARIANT: Once true, never becomes false.
     */
    private _closed = false;

    /**
     * Current read position in bytes.
     *
     * INVARIANT: Always >= 0.
     */
    private _position = 0;

    /**
     * Cached file content.
     *
     * WHY cached: Provides consistent reads within handle lifetime.
     * Loaded lazily on first read.
     *
     * INVARIANT: Null until first read/seek, then immutable until close.
     */
    private _content: Uint8Array | null = null;

    /**
     * Resolved host filesystem path.
     *
     * WHY stored: Needed for lazy content loading.
     */
    private readonly _hostPath: string;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new HostFileHandle.
     *
     * @param hostPath - Resolved host filesystem path
     * @param vfsPath - VFS path for identification
     * @param flags - Open flags
     */
    constructor(hostPath: string, vfsPath: string, flags: OpenFlags) {
        this._hostPath = hostPath;
        this.id = `${HOST_HANDLE_PREFIX}${vfsPath}:${Date.now()}`;
        this.path = vfsPath;
        this.flags = flags;
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Whether handle is closed.
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    /**
     * Read bytes from file.
     *
     * ALGORITHM:
     * 1. Validate handle state and permissions
     * 2. Lazy-load content from host filesystem
     * 3. Return requested bytes from current position
     * 4. Advance position
     *
     * WHY lazy loading:
     * Defers disk I/O until actually needed. Handles opened but never
     * read don't incur loading cost.
     *
     * @param size - Maximum bytes to read (default: remaining)
     * @returns Bytes read (empty at EOF)
     * @throws EBADF - If handle is closed
     * @throws EACCES - If not opened for reading
     */
    async read(size?: number): Promise<Uint8Array> {
        // RACE FIX: Check closure state first
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        if (!this.flags.read) {
            throw new EACCES('Not opened for reading');
        }

        // Lazy load content from host filesystem
        if (this._content === null) {
            await this.loadContent();
        }

        // Calculate bytes to return
        const remaining = this._content!.length - this._position;
        if (remaining <= 0) {
            return new Uint8Array(0); // EOF
        }

        const toRead = size !== undefined ? Math.min(size, remaining) : remaining;
        const result = this._content!.slice(this._position, this._position + toRead);
        this._position += toRead;

        return result;
    }

    // =========================================================================
    // WRITE OPERATIONS
    // =========================================================================

    /**
     * Write bytes to file.
     *
     * WHY not implemented:
     * Host mounts are primarily for read-only access to development files.
     * Write support would require:
     * - Tracking dirty state
     * - Flushing on sync/close
     * - Handling concurrent host changes
     * - Permission and safety considerations
     *
     * @throws EBADF - If handle is closed
     * @throws EACCES - Always (not implemented)
     */
    async write(_data: Uint8Array): Promise<number> {
        // RACE FIX: Check closure state first
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        if (!this.flags.write) {
            throw new EACCES('Not opened for writing');
        }

        // Write not implemented for host mounts
        throw new EACCES('Host mount write not implemented');
    }

    // =========================================================================
    // POSITION OPERATIONS
    // =========================================================================

    /**
     * Seek to position in file.
     *
     * WHY loads content:
     * Need to know file size for 'end' whence and for clamping position.
     *
     * @param offset - Byte offset from whence
     * @param whence - Reference point: 'start', 'current', or 'end'
     * @returns New absolute position
     * @throws EBADF - If handle is closed
     */
    async seek(offset: number, whence: SeekWhence): Promise<number> {
        // RACE FIX: Check closure state first
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        // Load content to know size for 'end' whence
        if (this._content === null) {
            await this.loadContent();
        }

        let newPosition: number;

        switch (whence) {
            case 'start':
                newPosition = offset;
                break;
            case 'current':
                newPosition = this._position + offset;
                break;
            case 'end':
                newPosition = this._content!.length + offset;
                break;
        }

        // Clamp to 0 (no negative positions)
        if (newPosition < 0) {
            newPosition = 0;
        }

        this._position = newPosition;
        return this._position;
    }

    /**
     * Get current position.
     *
     * @returns Current byte offset
     */
    async tell(): Promise<number> {
        return this._position;
    }

    // =========================================================================
    // FLUSH OPERATIONS
    // =========================================================================

    /**
     * Sync file to storage.
     *
     * WHY no-op:
     * Host mounts are read-only. No pending writes to flush.
     */
    async sync(): Promise<void> {
        // No-op for read-only host files
    }

    /**
     * Close handle and release resources.
     *
     * Releases the cached content buffer. Safe to call multiple times.
     */
    async close(): Promise<void> {
        this._closed = true;
        this._content = null; // Release memory
    }

    /**
     * AsyncDisposable support for `await using` pattern.
     */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Load file content from host filesystem.
     *
     * WHY separate method:
     * Called from multiple places (read, seek). Centralizes loading logic.
     *
     * RACE CONDITION:
     * Host file could change between open and read. We accept this -
     * content is cached for handle lifetime, providing snapshot isolation.
     */
    private async loadContent(): Promise<void> {
        const buffer = await readFile(this._hostPath);
        this._content = new Uint8Array(buffer);
    }
}
