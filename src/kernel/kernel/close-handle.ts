/**
 * Handle Close - Remove fd mapping and decrement refcount
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Closes a file descriptor by removing the process's fd → handle mapping and
 * decrementing the global refcount. The handle itself is only closed when the
 * last reference is removed.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: fd must exist in process table before close
 *        VIOLATED BY: Double-close, closing never-opened fd
 * INV-2: Process table entry is removed before refcount decrement
 *        VIOLATED BY: Wrong cleanup order (could cause use-after-close)
 * INV-3: closeHandle() is idempotent (second close throws EBADF)
 *        VIOLATED BY: Missing fd check, allowing double-close
 * INV-4: Refcount is decremented exactly once per close
 *        VIOLATED BY: Missing unrefHandle() call, double-unref
 *
 * CONCURRENCY MODEL
 * =================
 * Single-threaded: All handle operations run in main kernel thread.
 * This function is async (to match syscall interface) but has no await points.
 *
 * CLEANUP ORDER (CRITICAL)
 * =========================
 * 1. Remove fd from process table (proc.handles.delete)
 * 2. Decrement refcount (unrefHandle)
 *
 * WHY this order:
 * Prevents race where process could re-allocate same fd number before
 * refcount is decremented. If unref happens first, fd mapping still exists
 * but points to potentially-closed handle.
 *
 * MEMORY MANAGEMENT
 * =================
 * Two-level cleanup:
 * 1. Process level: Remove fd → handle ID mapping
 * 2. Kernel level: Decrement refcount, close when 0
 *
 * WHY separate levels:
 * Multiple fds can point to same handle (dup, redirect). Handle must
 * stay alive until ALL fds are closed.
 *
 * @module kernel/kernel/close-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EBADF } from '../errors.js';
import { unrefHandle } from './unref-handle.js';
import { printk } from './printk.js';

/**
 * Close a handle by removing fd mapping and decrementing refcount.
 *
 * ALGORITHM:
 * 1. Validate fd exists in process table
 * 2. Remove fd → handle ID mapping from process
 * 3. Decrement global refcount (triggers close if last ref)
 *
 * ERROR HANDLING:
 * Throws EBADF if fd doesn't exist. This is correct POSIX behavior:
 * - close(invalid_fd) should fail, not silently succeed
 * - Double-close should fail on second attempt
 * - Prevents masking bugs in handle lifecycle management
 *
 * REFCOUNT SEMANTICS:
 * closeHandle() removes ONE reference (this process's fd).
 * If other fds/processes still reference the handle, it stays alive.
 * Only when refcount reaches 0 does unrefHandle() actually close it.
 *
 * RACE CONDITION: Process exit during close
 * ==========================================
 * If process is being killed while closeHandle() runs:
 * 1. Process cleanup will call unrefHandle() for all fds
 * 2. This closeHandle() will also call unrefHandle()
 * 3. Refcount accounting handles this correctly (double-decrement)
 *
 * MITIGATION: Process cleanup should clear proc.handles first, preventing
 * syscall dispatch. If that fails, unrefHandle() handles negative refcount.
 *
 * @param self - Kernel instance
 * @param proc - Process owning the fd
 * @param h - Handle number (fd) to close
 * @throws EBADF if fd doesn't exist
 */
export async function closeHandle(self: Kernel, proc: Process, h: number): Promise<void> {
    // Validate fd exists
    const handleId = proc.handles.get(h);

    if (!handleId) {
        throw new EBADF(`Bad file descriptor: ${h}`);
    }

    // DEBUG: Log when listener fd might be closed
    const handle = self.handles.get(handleId);
    if (handle?.type === 'port') {
        printk(self, 'debug', `closeHandle: closing PORT fd ${h} (${handleId.slice(0, 8)}) for process ${proc.cmd}`);
    }

    // CRITICAL: Remove from process BEFORE decrementing refcount
    // This prevents race where fd number could be reused before cleanup completes
    proc.handles.delete(h);

    // -------------------------------------------------------------------------
    // FIRE-AND-FORGET: unrefHandle -> handle.close()
    // -------------------------------------------------------------------------
    //
    // WHAT: unrefHandle decrements refcount and may trigger close(). The close
    // is fire-and-forget - we return immediately without waiting.
    //
    // WHY: The close syscall should return quickly. Most callers don't care
    // about the actual I/O completion, just that the fd is released. Awaiting
    // would block the process on potentially slow I/O (network flush, disk
    // sync, etc.).
    //
    // TRADE-OFF: Caller can't detect close failures. If the underlying
    // resource fails to close (network error, disk full), the error is logged
    // but not reported to the process.
    //
    // This matches POSIX close() semantics - errors are reported but often
    // ignored by callers. The important invariant is that the fd is released
    // and won't be reused until the close completes.
    //
    unrefHandle(self, handleId);
}
