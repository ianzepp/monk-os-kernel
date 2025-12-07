/**
 * VFS Syscalls - File and directory operation system calls
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * VFS syscalls provide the primary interface between user processes and the
 * Virtual File System. Each syscall is a standalone async generator function
 * that receives explicit dependencies (proc, kernel, vfs) and yields Response
 * messages back to the calling process.
 *
 * DESIGN: Direct dependencies instead of factory pattern
 * =====================================================
 * Unlike the previous design where syscalls were created via factory functions
 * with closures over dependencies, this module exports standalone functions.
 * Each function declares exactly what it needs in its parameter list:
 *
 *   - proc: Process context (nearly all syscalls need this)
 *   - kernel: For handle management operations
 *   - vfs: For filesystem operations
 *   - Syscall-specific args (path, fd, flags, etc.)
 *
 * This makes dependencies explicit and enables easier testing with mocks.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All path arguments must be validated as strings before VFS calls
 * INV-2: All fd arguments must be validated as numbers before handle lookups
 * INV-3: Every syscall must yield at least one Response (ok, error, or done)
 * INV-4: Handle operations must check handle existence before delegation
 * INV-5: User identity (proc.user) is passed to VFS for permission checks
 *
 * CONCURRENCY MODEL
 * =================
 * Syscalls run in the kernel's main async context. Multiple syscalls from
 * different processes can execute concurrently and interleave at await points.
 * Each syscall is independent - they do not share mutable state.
 *
 * VFS operations may await storage operations, creating suspension points.
 * Handle state (position, flags) is managed by Handle objects, not syscalls.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Handle validity is checked on every operation
 * RC-2: VFS path resolution is atomic within each syscall
 * RC-3: Stream operations check count limits
 *
 * @module syscall/vfs
 */

import type { Kernel } from '@src/kernel/kernel.js';
import type { VFS } from '@src/vfs/index.js';
import type { Process, OpenFlags, Response, SeekWhence } from './types.js';
import { respond, MAX_STREAM_ENTRIES } from './types.js';

// Kernel functions for handle management
import { openFile } from '@src/kernel/kernel/open-file.js';
import { closeHandle } from '@src/kernel/kernel/close-handle.js';
import { getHandle } from '@src/kernel/kernel/get-handle.js';
import { mountFs } from '@src/kernel/kernel/mount-fs.js';
import { umountFs } from '@src/kernel/kernel/umount-fs.js';

// =============================================================================
// FILE DESCRIPTOR OPERATIONS
// =============================================================================

/**
 * Open a file and allocate a file descriptor.
 *
 * This syscall needs both VFS (to open the file) and Kernel (to assign the handle).
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance (for handle allocation)
 * @param vfs - VFS instance (for file operations) - currently unused, kernel.vfs used
 * @param path - File path to open
 * @param flags - Open flags (read, write, create, append, truncate)
 */
export async function* fileOpen(
    proc: Process,
    kernel: Kernel,
    _vfs: VFS,
    path: unknown,
    flags?: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    // Parse flags with read-only default
    const openFlags: OpenFlags = typeof flags === 'object' && flags !== null
        ? flags as OpenFlags
        : { read: true };

    const fd = await openFile(kernel, proc, path, openFlags);
    yield respond.ok(fd);
}

/**
 * Close a file descriptor.
 *
 * Only needs Kernel - handle management is kernel's domain.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - File descriptor to close
 */
export async function* fileClose(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');
        return;
    }

    await closeHandle(kernel, proc, fd);
    yield respond.ok();
}

/**
 * Read from a file descriptor.
 *
 * Only needs Kernel - get handle and delegate to it.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - File descriptor
 * @param chunkSize - Optional chunk size for partial reads
 */
export async function* fileRead(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
    chunkSize?: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');
        return;
    }

    const handle = getHandle(kernel, proc, fd);
    if (!handle) {
        yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
        return;
    }

    // Delegate to handle's recv implementation
    yield* handle.exec({ op: 'recv', data: { chunkSize } });
}

/**
 * Write to a file descriptor.
 *
 * Only needs Kernel - get handle and delegate to it.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - File descriptor
 * @param data - Data to write
 */
export async function* fileWrite(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
    data: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');
        return;
    }

    const handle = getHandle(kernel, proc, fd);
    if (!handle) {
        yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
        return;
    }

    yield* handle.exec({ op: 'send', data: { data } });
}

/**
 * Seek to a position in a file.
 *
 * Only needs Kernel - get handle and delegate to it.
 * Only valid for file handles (not sockets/pipes).
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - File descriptor
 * @param offset - Byte offset from whence
 * @param whence - Reference point (start, current, end)
 */
export async function* fileSeek(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
    offset: unknown,
    whence?: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');
        return;
    }

    const handle = getHandle(kernel, proc, fd);
    if (!handle) {
        yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
        return;
    }

    // Only file handles support seek
    if (handle.type !== 'file') {
        yield respond.error('EINVAL', 'Illegal seek on socket');
        return;
    }

    yield* handle.exec({ op: 'seek', data: { offset, whence: (whence as SeekWhence) ?? 'start' } });
}

// =============================================================================
// METADATA OPERATIONS
// =============================================================================

/**
 * Get file stats by path.
 *
 * Only needs VFS - no handle involved.
 *
 * @param proc - Calling process
 * @param vfs - VFS instance
 * @param path - File path
 */
export async function* fileStat(
    proc: Process,
    vfs: VFS,
    path: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    const stat = await vfs.stat(path, proc.user);
    yield respond.ok(stat);
}

/**
 * Get file stats by file descriptor.
 *
 * Needs Kernel (to get handle) and VFS (to stat by path).
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param vfs - VFS instance
 * @param fd - File descriptor
 */
export async function* fileFstat(
    proc: Process,
    kernel: Kernel,
    vfs: VFS,
    fd: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');
        return;
    }

    const handle = getHandle(kernel, proc, fd);
    if (!handle) {
        yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
        return;
    }

    // Only file handles have path-based stat
    if (handle.type !== 'file') {
        yield respond.error('EINVAL', 'fstat not supported on sockets');
        return;
    }

    // Use handle's description as path
    const stat = await vfs.stat(handle.description, proc.user);
    yield respond.ok(stat);
}

// =============================================================================
// DIRECTORY OPERATIONS
// =============================================================================

/**
 * Create a directory.
 *
 * Only needs VFS.
 *
 * @param proc - Calling process
 * @param vfs - VFS instance
 * @param path - Directory path to create
 * @param opts - Optional: { recursive?: boolean }
 */
export async function* fileMkdir(
    proc: Process,
    vfs: VFS,
    path: unknown,
    opts?: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    const options = opts as { recursive?: boolean } | undefined;
    await vfs.mkdir(path, proc.user, options);
    yield respond.ok();
}

/**
 * Remove a file or symbolic link.
 *
 * Only needs VFS.
 *
 * @param proc - Calling process
 * @param vfs - VFS instance
 * @param path - Path to remove
 */
export async function* fileUnlink(
    proc: Process,
    vfs: VFS,
    path: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    await vfs.unlink(path, proc.user);
    yield respond.ok();
}

/**
 * Remove a directory.
 *
 * Only needs VFS.
 *
 * @param proc - Calling process
 * @param vfs - VFS instance
 * @param path - Directory path to remove
 */
export async function* fileRmdir(
    proc: Process,
    vfs: VFS,
    path: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    await vfs.unlink(path, proc.user);
    yield respond.ok();
}

/**
 * List directory contents (streaming).
 *
 * Only needs VFS. Yields items one at a time, then done.
 *
 * @param proc - Calling process
 * @param vfs - VFS instance
 * @param path - Directory path
 */
export async function* fileReaddir(
    proc: Process,
    vfs: VFS,
    path: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    let count = 0;

    try {
        for await (const entry of vfs.readdir(path, proc.user)) {
            count++;
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
}

/**
 * Rename a file or directory.
 *
 * @param proc - Calling process
 * @param vfs - VFS instance
 * @param oldPath - Current path
 * @param newPath - New path
 */
export async function* fileRename(
    proc: Process,
    _vfs: VFS,
    oldPath: unknown,
    newPath: unknown,
): AsyncIterable<Response> {
    if (typeof oldPath !== 'string' || typeof newPath !== 'string') {
        yield respond.error('EINVAL', 'paths must be strings');
        return;
    }

    // TODO: Implement rename in VFS
    void proc;
    yield respond.error('ENOSYS', 'rename');
}

// =============================================================================
// SYMBOLIC LINK OPERATIONS
// =============================================================================

/**
 * Create a symbolic link.
 *
 * Only needs VFS.
 *
 * @param proc - Calling process
 * @param vfs - VFS instance
 * @param target - Path the symlink points to
 * @param linkPath - Path where symlink will be created
 */
export async function* fileSymlink(
    proc: Process,
    vfs: VFS,
    target: unknown,
    linkPath: unknown,
): AsyncIterable<Response> {
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
}

// =============================================================================
// ACCESS CONTROL OPERATIONS
// =============================================================================

/**
 * Get or set access control list (ACL) for a path.
 *
 * Only needs VFS.
 *
 * @param proc - Calling process
 * @param vfs - VFS instance
 * @param path - Path to check/modify
 * @param acl - Optional ACL to set (null to clear, undefined to get)
 */
export async function* fileAccess(
    proc: Process,
    vfs: VFS,
    path: unknown,
    acl?: unknown,
): AsyncIterable<Response> {
    if (typeof path !== 'string') {
        yield respond.error('EINVAL', 'path must be a string');
        return;
    }

    if (acl !== undefined) {
        // Set ACL
        await vfs.setAccess(path, proc.user, acl as import('@src/vfs/index.js').ACL | null);
        yield respond.ok();
        return;
    }

    // Get ACL
    const result = await vfs.access(path, proc.user);
    yield respond.ok(result);
}

// =============================================================================
// MESSAGE-BASED I/O OPERATIONS
// =============================================================================

/**
 * Receive messages from fd (message-based I/O).
 *
 * Only needs Kernel.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - File descriptor
 */
export async function* fileRecv(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');
        return;
    }

    const handle = getHandle(kernel, proc, fd);
    if (!handle) {
        yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
        return;
    }

    yield* handle.exec({ op: 'recv' });
}

/**
 * Send a message to fd (message-based I/O).
 *
 * Only needs Kernel.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - File descriptor
 * @param msg - Message to send
 */
export async function* fileSend(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
    msg: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');
        return;
    }

    const handle = getHandle(kernel, proc, fd);
    if (!handle) {
        yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
        return;
    }

    yield* handle.exec({ op: 'send', data: msg as Response });
}

// =============================================================================
// MOUNT OPERATIONS
// =============================================================================

/**
 * Mount a filesystem.
 *
 * Needs Kernel (for policy enforcement) and VFS (for mount operation).
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param vfs - VFS instance (currently unused, kernel.vfs used)
 * @param source - Source path (e.g., 'host:/path', 's3://bucket')
 * @param target - Target mount point
 * @param opts - Mount options
 */
export async function* fsMount(
    proc: Process,
    kernel: Kernel,
    _vfs: VFS,
    source: unknown,
    target: unknown,
    opts?: unknown,
): AsyncIterable<Response> {
    if (typeof source !== 'string') {
        yield respond.error('EINVAL', 'source must be a string');
        return;
    }

    if (typeof target !== 'string') {
        yield respond.error('EINVAL', 'target must be a string');
        return;
    }

    await mountFs(kernel, proc, source, target, opts as Record<string, unknown> | undefined);
    yield respond.ok();
}

/**
 * Unmount a filesystem.
 *
 * Needs Kernel (for policy enforcement) and VFS (for unmount operation).
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param vfs - VFS instance (currently unused, kernel.vfs used)
 * @param target - Mount point to unmount
 */
export async function* fsUmount(
    proc: Process,
    kernel: Kernel,
    _vfs: VFS,
    target: unknown,
): AsyncIterable<Response> {
    if (typeof target !== 'string') {
        yield respond.error('EINVAL', 'target must be a string');
        return;
    }

    await umountFs(kernel, proc, target);
    yield respond.ok();
}
