/**
 * Handle Allocation - Register handles in kernel and process tables
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module allocates file descriptors (process-local integers) for handles
 * and registers them in both the kernel's global handle table and the process's
 * local fd table. It's the entry point for handle lifecycle management.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Each handle has exactly one entry in kernel.handles
 *        VIOLATED BY: Duplicate allocHandle() calls for same handle ID
 * INV-2: Each handle has exactly one refcount entry starting at 1
 *        VIOLATED BY: Missing handleRefs.set() or double-initialization
 * INV-3: Process fd → handle ID mapping is unique per process
 *        VIOLATED BY: Reusing fd before close, corrupted nextHandle counter
 * INV-4: Total fds per process never exceeds MAX_HANDLES (256)
 *        VIOLATED BY: Skipping size check, wraparound of nextHandle
 *
 * CONCURRENCY MODEL
 * =================
 * Single-threaded: All handle operations run in main kernel thread.
 * No async points in this function, so no race conditions within allocHandle.
 *
 * MEMORY MANAGEMENT
 * =================
 * Handle lifecycle:
 * 1. allocHandle() - Creates handle, sets refcount=1, assigns fd
 * 2. refHandle() - Increments refcount (dup, redirect)
 * 3. unrefHandle() - Decrements refcount, closes when 0
 * 4. closeHandle() - Removes fd mapping, unrefs handle
 *
 * WHY reference counting: Multiple fds can point to same handle (dup, redirect).
 * Handle must stay alive until all references are closed.
 *
 * @module kernel/kernel/alloc-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Handle } from '../handle.js';
import { EMFILE } from '../errors.js';
import { MAX_HANDLES } from '../types.js';

/**
 * Allocate a handle ID and register in process and kernel tables.
 *
 * ALGORITHM:
 * 1. Check process handle limit (MAX_HANDLES = 256)
 * 2. Register handle in kernel global table (handles Map)
 * 3. Initialize refcount to 1 (handleRefs Map)
 * 4. Allocate next available fd in process (nextHandle counter)
 * 5. Map fd → handle ID in process table (proc.handles Map)
 * 6. Return fd to caller
 *
 * WHY separate kernel and process tables:
 * - Kernel table: Global handle registry (UUID → Handle object)
 * - Process table: Per-process fd namespace (0-255 → UUID)
 * - Allows multiple processes to share handles (via spawn/fork)
 * - Allows multiple fds to point to same handle (dup, redirect)
 *
 * REFCOUNT INITIALIZATION:
 * Initial refcount is 1 because the caller now owns a reference via the
 * returned fd. When closeHandle() is called, it will decrement to 0 and
 * trigger cleanup.
 *
 * @param self - Kernel instance
 * @param proc - Process owning this fd
 * @param handle - Handle object to allocate (must have unique ID)
 * @returns File descriptor number (0-255)
 * @throws EMFILE if process has reached MAX_HANDLES limit
 */
export function allocHandle(self: Kernel, proc: Process, handle: Handle): number {
    // Check limit before making any changes
    if (proc.handles.size >= MAX_HANDLES) {
        throw new EMFILE('Too many open handles');
    }

    // Register in kernel global table
    // WHY check for duplicate: Prevent overwriting existing handle
    if (self.handles.has(handle.id)) {
        // CRITICAL: This should never happen - indicates caller bug
        // If handle already exists, caller should use refHandle() instead
        throw new Error(`Handle ${handle.id} already exists in kernel table`);
    }
    self.handles.set(handle.id, handle);
    self.handleRefs.set(handle.id, 1);

    // Allocate fd in process
    // WHY monotonic counter: Simple, no fd reuse until wraparound
    // nextHandle wraps naturally at 2^53 (JavaScript number limit)
    const h = proc.nextHandle++;
    proc.handles.set(h, handle.id);

    return h;
}
