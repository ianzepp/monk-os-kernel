/**
 * File Syscalls - File and directory operation system calls
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * File syscalls provide the primary interface between user processes and the VFS
 * layer. Each syscall is an async generator that yields Response messages back to
 * the calling process. This design enables streaming results (e.g., for readdir)
 * and incremental error handling without blocking the kernel.
 *
 * The syscalls are created via a factory function that receives dependencies
 * (VFS, HAL, handle management functions) and returns a registry of syscall
 * handlers. This dependency injection pattern enables testing and decouples
 * syscalls from kernel internals.
 *
 * File descriptors (fds) are integers that reference Handle objects. Handles
 * can be files, sockets, or pipes. The syscall layer validates fd arguments
 * and delegates to handle-specific operations when appropriate.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All path arguments must be validated as strings before VFS calls
 * INV-2: All fd arguments must be validated as numbers before handle lookups
 * INV-3: Every syscall must yield at least one Response (ok, error, or done)
 * INV-4: File handles support seek, socket handles do not
 * INV-5: Stream responses (readdir) must not exceed MAX_STREAM_ENTRIES
 * INV-6: Handle operations must check handle existence before delegation
 * INV-7: User identity (proc.user) is passed to VFS for permission checks
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * syscalls from the same or different processes can run concurrently. Each
 * syscall is independent - they do not share mutable state.
 *
 * Concurrent operations on the same file descriptor are allowed but may produce
 * unexpected results. The kernel message dispatcher ensures syscall handlers
 * run to completion (yielding responses) before processing the next message.
 *
 * VFS operations (stat, mkdir, unlink) may await storage operations, creating
 * suspension points where other syscalls can execute. Handle state (position,
 * flags) is managed by Handle objects, not syscalls.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Handle validity is checked on every operation (handle may be closed
 *       by concurrent close() syscall after fd validation but before use)
 * RC-2: VFS path resolution is atomic within each syscall - no TOCTOU between
 *       path validation and operation (VFS handles concurrency internally)
 * RC-3: Stream operations (readdir) check count limits to prevent memory
 *       exhaustion from concurrent directory modifications
 *
 * MEMORY MANAGEMENT
 * =================
 * - Syscalls allocate minimal memory (Response objects, iterator state)
 * - Large data (file contents) is managed by Handle objects, not syscalls
 * - Stream responses are yielded incrementally - caller controls backpressure
 * - No cleanup required - async generators are GC'd when exhausted/closed
 *
 * @module kernel/syscalls/file
 */

import type { VFS } from '@src/vfs/index.js';
import type { HAL } from '@src/hal/index.js';
import type { Process, OpenFlags } from '@src/kernel/types.js';
import { MAX_STREAM_ENTRIES } from '@src/kernel/types.js';
import type { Handle } from '@src/kernel/handle.js';
import type { Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { SyscallRegistry } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Mkdir options.
 *
 * WHY: Typed wrapper for mkdir syscall options parameter.
 */
interface MkdirOptions {
    /** Create parent directories if they don't exist */
    recursive?: boolean;
}

// =============================================================================
// MAIN FACTORY
// =============================================================================

/**
 * Create file operation syscalls.
 *
 * Factory function that creates a registry of file syscall handlers with
 * injected dependencies.
 *
 * WHY factory pattern:
 * - Enables dependency injection for testing
 * - Decouples syscalls from kernel implementation details
 * - Allows VFS and HAL instances to be swapped without code changes
 *
 * @param vfs - VFS instance for file operations
 * @param _hal - HAL instance (currently unused, reserved for future HAL-level ops)
 * @param getHandle - Function to retrieve handle by fd
 * @param openFile - Function to open file and allocate fd
 * @param closeHandle - Function to close fd and release handle
 * @returns Registry of syscall handlers
 */
export function createFileSyscalls(
    vfs: VFS,
    _hal: HAL,
    getHandle: (proc: Process, fd: number) => Handle | undefined,
    openFile: (proc: Process, path: string, flags: OpenFlags) => Promise<number>,
    closeHandle: (proc: Process, fd: number) => Promise<void>,
): SyscallRegistry {
    return {
        // =====================================================================
        // FILE DESCRIPTOR OPERATIONS
        // =====================================================================

        /**
         * Open a file or directory.
         *
         * Creates a handle for the given path and allocates a file descriptor.
         * Default flags are read-only if not specified.
         *
         * ALGORITHM:
         * 1. Validate path is a string
         * 2. Parse flags object (default: read-only)
         * 3. Call openFile to create handle and allocate fd
         * 4. Return fd to caller
         *
         * @param proc - Calling process
         * @param path - File or directory path
         * @param flags - Open flags (read, write, append, truncate)
         * @yields Response with allocated fd or error
         */
        async *'file:open'(proc: Process, path: unknown, flags: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');

                return;
            }

            // Parse flags or use read-only default
            // WHY: Defensive parsing prevents invalid flag objects from crashing
            const openFlags: OpenFlags = typeof flags === 'object' && flags !== null
                ? flags as OpenFlags
                : { read: true };

            const fd = await openFile(proc, path, openFlags);

            yield respond.ok(fd);
        },

        /**
         * Close a file descriptor.
         *
         * Releases the handle and flushes any pending writes.
         *
         * @param proc - Calling process
         * @param fd - File descriptor to close
         * @yields Response (ok) or error
         */
        async *'file:close'(proc: Process, fd: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');

                return;
            }

            await closeHandle(proc, fd);
            yield respond.ok();
        },

        // =====================================================================
        // BYTE-ORIENTED I/O OPERATIONS
        // =====================================================================

        /**
         * Read bytes from a file descriptor.
         *
         * Delegates to the handle's recv implementation. For file handles,
         * this reads from the current position. For sockets/pipes, this
         * receives a message.
         *
         * RACE CONDITION:
         * Handle may be closed between validation and delegation. Handle.exec
         * will detect this and return EBADF.
         *
         * @param proc - Calling process
         * @param fd - File descriptor
         * @param chunkSize - Optional chunk size for partial reads
         * @yields Response stream from handle (data or error)
         */
        async *'file:read'(proc: Process, fd: unknown, chunkSize?: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');

                return;
            }

            const handle = getHandle(proc, fd);

            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);

                return;
            }

            // Delegate to handle's recv implementation
            // WHY: Handle knows whether it's file/socket/pipe and handles accordingly
            yield* handle.exec({ op: 'recv', data: { chunkSize } });
        },

        /**
         * Write bytes to a file descriptor.
         *
         * Delegates to the handle's send implementation. For file handles,
         * this writes at the current position. For sockets/pipes, this
         * sends a message.
         *
         * @param proc - Calling process
         * @param fd - File descriptor
         * @param data - Data to write (Uint8Array or message)
         * @yields Response stream from handle (bytes written or error)
         */
        async *'file:write'(proc: Process, fd: unknown, data: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');

                return;
            }

            const handle = getHandle(proc, fd);

            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);

                return;
            }

            // Delegate to handle's send implementation
            yield* handle.exec({ op: 'send', data: { data } });
        },

        /**
         * Seek to a position in a file.
         *
         * Only valid for file handles. Socket/pipe handles do not support seek.
         *
         * WHY type check:
         * Seeking on a socket is a programming error. We detect this early
         * rather than delegating to the handle and getting a cryptic error.
         *
         * @param proc - Calling process
         * @param fd - File descriptor
         * @param offset - Byte offset from whence
         * @param whence - Reference point (start, current, end)
         * @yields Response with new position or error
         */
        async *'file:seek'(proc: Process, fd: unknown, offset: unknown, whence: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');

                return;
            }

            const handle = getHandle(proc, fd);

            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);

                return;
            }

            // Only file handles support seek
            // WHY: Prevents confusing errors from seeking on sockets/pipes
            if (handle.type !== 'file') {
                yield respond.error('EINVAL', 'Illegal seek on socket');

                return;
            }

            // Delegate to handle's seek implementation
            yield* handle.exec({ op: 'seek', data: { offset, whence: whence ?? 'start' } });
        },

        // =====================================================================
        // METADATA OPERATIONS
        // =====================================================================

        /**
         * Get file/directory metadata by path.
         *
         * @param proc - Calling process
         * @param path - File or directory path
         * @yields Response with stat object or error
         */
        async *'file:stat'(proc: Process, path: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');

                return;
            }

            const statResult = await vfs.stat(path, proc.user);

            yield respond.ok(statResult);
        },

        /**
         * Get file/directory metadata by file descriptor.
         *
         * Only valid for file handles (not sockets/pipes).
         *
         * WHY separate from stat:
         * fstat operates on an already-open fd, avoiding path resolution
         * and potential TOCTOU issues.
         *
         * @param proc - Calling process
         * @param fd - File descriptor
         * @yields Response with stat object or error
         */
        async *'file:fstat'(proc: Process, fd: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');

                return;
            }

            const handle = getHandle(proc, fd);

            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);

                return;
            }

            // Only file handles have path-based stat
            // WHY: Sockets don't have filesystem paths
            if (handle.type !== 'file') {
                yield respond.error('EINVAL', 'fstat not supported on sockets');

                return;
            }

            // Use handle's description as path
            // WHY: Description contains the resolved path from open()
            const statResult = await vfs.stat(handle.description, proc.user);

            yield respond.ok(statResult);
        },

        // =====================================================================
        // DIRECTORY OPERATIONS
        // =====================================================================

        /**
         * Create a directory.
         *
         * @param proc - Calling process
         * @param path - Directory path to create
         * @param opts - Optional flags (recursive)
         * @yields Response (ok) or error
         */
        async *'file:mkdir'(proc: Process, path: unknown, opts?: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');

                return;
            }

            const options = opts as MkdirOptions | undefined;

            await vfs.mkdir(path, proc.user, options);
            yield respond.ok();
        },

        /**
         * Remove a file or symbolic link.
         *
         * Does not work on directories (use rmdir instead).
         *
         * @param proc - Calling process
         * @param path - Path to remove
         * @yields Response (ok) or error
         */
        async *'file:unlink'(proc: Process, path: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');

                return;
            }

            await vfs.unlink(path, proc.user);
            yield respond.ok();
        },

        /**
         * Remove a directory.
         *
         * WHY same as unlink:
         * VFS unlink() checks the entity type and handles both files and
         * directories. POSIX has separate syscalls for API clarity, but
         * they can share implementation.
         *
         * @param proc - Calling process
         * @param path - Directory path to remove
         * @yields Response (ok) or error
         */
        async *'file:rmdir'(proc: Process, path: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');

                return;
            }

            await vfs.unlink(path, proc.user);
            yield respond.ok();
        },

        /**
         * List directory contents.
         *
         * Streams directory entries as individual Response.item messages,
         * followed by Response.done. This avoids allocating large arrays
         * for huge directories.
         *
         * RACE CONDITION:
         * Directory may be modified during iteration. VFS returns a snapshot
         * iterator. We enforce MAX_STREAM_ENTRIES to prevent memory exhaustion
         * from malicious or buggy processes.
         *
         * @param proc - Calling process
         * @param path - Directory path to list
         * @yields Stream of Response.item (entries) followed by Response.done or error
         */
        async *'file:readdir'(proc: Process, path: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');

                return;
            }

            let count = 0;

            try {
                for await (const entry of vfs.readdir(path, proc.user)) {
                    count++;
                    // Enforce stream size limit
                    // WHY: Prevents unbounded memory growth from huge directories
                    if (count > MAX_STREAM_ENTRIES) {
                        yield respond.error('EFBIG', `Directory listing exceeded ${MAX_STREAM_ENTRIES} entries`);

                        return;
                    }

                    yield respond.item(entry.name);
                }

                yield respond.done();
            }
            catch (err) {
                yield respond.error('ENOENT', (err as Error).message);
            }
        },

        /**
         * Rename a file or directory.
         *
         * TODO: Not yet implemented in VFS.
         *
         * @param _proc - Calling process (unused until implemented)
         * @param oldPath - Current path
         * @param newPath - New path
         * @yields Response.error (ENOSYS)
         */
        async *'file:rename'(_proc: Process, oldPath: unknown, newPath: unknown): AsyncIterable<Response> {
            if (typeof oldPath !== 'string' || typeof newPath !== 'string') {
                yield respond.error('EINVAL', 'paths must be strings');

                return;
            }

            // TODO: Implement rename in VFS
            // WHY deferred: Rename requires atomic move semantics which are
            // complex to implement correctly across different storage backends
            yield respond.error('ENOSYS', 'rename');
        },

        // =====================================================================
        // SYMBOLIC LINK OPERATIONS
        // =====================================================================

        /**
         * Create a symbolic link.
         *
         * @param proc - Calling process
         * @param target - Path the symlink points to (not validated)
         * @param linkPath - Path where symlink will be created
         * @yields Response (ok) or error
         */
        async *'file:symlink'(proc: Process, target: unknown, linkPath: unknown): AsyncIterable<Response> {
            if (typeof target !== 'string') {
                yield respond.error('EINVAL', 'target must be a string');

                return;
            }

            if (typeof linkPath !== 'string') {
                yield respond.error('EINVAL', 'linkPath must be a string');

                return;
            }

            await vfs.symlink(target, linkPath, proc.user);
            yield respond.ok();
        },

        // =====================================================================
        // ACCESS CONTROL OPERATIONS
        // =====================================================================

        /**
         * Get or set access control list (ACL) for a path.
         *
         * WHY dual behavior:
         * Consolidates get/set into one syscall to reduce API surface.
         * If acl parameter is provided, it's a set operation. Otherwise, get.
         *
         * @param proc - Calling process
         * @param path - Path to check/modify
         * @param acl - Optional ACL to set (null to clear, undefined to get)
         * @yields Response with ACL (get) or ok (set) or error
         */
        async *'file:access'(proc: Process, path: unknown, acl?: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');

                return;
            }

            if (acl !== undefined) {
                // Set ACL
                // WHY null is allowed: Clears ACL (back to default permissions)
                await vfs.setAccess(path, proc.user, acl as import('@src/vfs/index.js').ACL | null);
                yield respond.ok();

                return;
            }

            // Get ACL
            const result = await vfs.access(path, proc.user);

            yield respond.ok(result);
        },

        // =====================================================================
        // MESSAGE-BASED I/O OPERATIONS
        // =====================================================================

        /**
         * Receive messages from fd (message-based I/O).
         *
         * Used for fd 0/1/2 (stdin/stdout/stderr) which are MessagePipe handles,
         * and for socket handles. Different from read() in that it receives
         * complete messages rather than byte streams.
         *
         * @param proc - Calling process
         * @param fd - File descriptor
         * @yields Response stream from handle (messages or error)
         */
        async *'file:recv'(proc: Process, fd: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');

                return;
            }

            const handle = getHandle(proc, fd);

            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);

                return;
            }

            yield* handle.exec({ op: 'recv' });
        },

        /**
         * Send a message to fd (message-based I/O).
         *
         * Used for fd 0/1/2 (stdin/stdout/stderr) which are MessagePipe handles,
         * and for socket handles. Different from write() in that it sends
         * complete messages rather than byte streams.
         *
         * @param proc - Calling process
         * @param fd - File descriptor
         * @param msg - Message to send (Response object)
         * @yields Response stream from handle (ok or error)
         */
        async *'file:send'(proc: Process, fd: unknown, msg: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');

                return;
            }

            const handle = getHandle(proc, fd);

            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);

                return;
            }

            yield* handle.exec({ op: 'send', data: msg as Response });
        },
    };
}
