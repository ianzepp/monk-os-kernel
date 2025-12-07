/**
 * Handle Lookup - Resolve fd to Handle object
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Translates a process-local file descriptor (integer 0-255) to the global
 * Handle object. This is a two-step lookup: fd → handle ID (process table),
 * then handle ID → Handle object (kernel table).
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: If proc.handles contains an fd, kernel.handles must contain the handle ID
 *        VIOLATED BY: Inconsistent deletion (process entry survives kernel cleanup)
 * INV-2: Handle returned is never closed (closed=true means stale reference)
 *        VIOLATED BY: Failing to remove from proc.handles on close
 *
 * CONCURRENCY MODEL
 * =================
 * Single-threaded: All handle operations run in main kernel thread.
 * No async points, no race conditions.
 *
 * SAFETY: Returns undefined instead of throwing
 * ==============================================
 * WHY: Callers can distinguish "fd not found" from "internal error".
 * Syscalls can return EBADF explicitly rather than bubbling up exceptions.
 *
 * @module kernel/kernel/get-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Handle } from '../handle.js';
import { EBADF } from '../errors.js';

/**
 * Get a handle by process-local file descriptor.
 *
 * ALGORITHM:
 * 1. Lookup handle ID in process table (fd → UUID)
 * 2. Lookup Handle object in kernel table (UUID → Handle)
 * 3. Return Handle or undefined if not found
 *
 * WHY two-level lookup:
 * - Process table provides isolation: Each process has own fd namespace
 * - Kernel table provides sharing: Multiple fds can point to same handle
 * - Enables dup, redirect, and cross-process handle passing
 *
 * INVARIANT CHECK:
 * If process has an fd mapping but kernel doesn't have the handle, this
 * indicates a refcount bug or cleanup ordering issue. This should never
 * happen and represents data corruption.
 *
 * @param self - Kernel instance
 * @param proc - Process owning the fd
 * @param h - Handle number (fd) to lookup
 * @returns Handle object or undefined if fd not found
 */
export function getHandle(self: Kernel, proc: Process, h: number): Handle | undefined {
    // Step 1: Process-local lookup (fd → handle ID)
    const handleId = proc.handles.get(h);

    if (!handleId) {
        // Normal case: fd doesn't exist in this process
        return undefined;
    }

    // Step 2: Kernel-global lookup (handle ID → Handle object)
    const handle = self.handles.get(handleId);

    // INVARIANT CHECK: If process has mapping, kernel must have handle
    if (!handle) {
        // CRITICAL BUG: Process table and kernel table are out of sync
        // This means unrefHandle() deleted the kernel entry but process
        // still has the fd mapping. This is a refcount accounting error.
        throw new EBADF(
            `Invariant violation: Process ${proc.id} has fd ${h} → ${handleId} ` +
            `but kernel has no such handle. This indicates a refcount bug.`,
        );
    }

    return handle;
}
