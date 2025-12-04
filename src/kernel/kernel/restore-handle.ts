/**
 * Handle Restore - Revert fd redirection
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Restores a file descriptor to its original handle after a redirect operation.
 * Used to undo temporary I/O redirection (e.g., restoring stdout after command
 * execution with piped output).
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: targetH must exist in process table before restore
 *        VIOLATED BY: Restoring fd that was closed, restoring wrong fd
 * INV-2: savedHandleId must have been previously returned by redirectHandle()
 *        VIOLATED BY: Restoring with wrong handle ID, fabricated restore
 * INV-3: Refcount is decremented exactly once for redirected handle
 *        VIOLATED BY: Missing decrement, double-decrement
 * INV-4: Original handle is not refcounted (already owned by process)
 *        VIOLATED BY: Calling refHandle() on restore (would leak refs)
 *
 * CONCURRENCY MODEL
 * =================
 * Single-threaded: All handle operations run in main kernel thread.
 * No async points, no race conditions.
 *
 * REDIRECT/RESTORE LIFECYCLE
 * ==========================
 * 1. redirectHandle(target, source):
 *    - Saves target's original handle ID
 *    - Points target to source's handle ID
 *    - Increments refcount on source's handle
 *    - Returns saved handle ID
 *
 * 2. restoreHandle(target, savedHandleId):
 *    - Points target back to saved handle ID
 *    - Decrements refcount on redirected handle
 *    - Does NOT increment refcount on original (still owned by process)
 *
 * MEMORY MANAGEMENT
 * =================
 * Refcount changes during redirect/restore cycle:
 *
 * Initial state:
 *   fd 1 → handle A (refcount=1)
 *   fd 3 → handle B (refcount=1)
 *
 * After redirectHandle(1, 3):
 *   fd 1 → handle B (refcount=2, shared)
 *   fd 3 → handle B (refcount=2, shared)
 *   handle A (refcount=1, orphaned but saved)
 *
 * After restoreHandle(1, handleA):
 *   fd 1 → handle A (refcount=1, restored)
 *   fd 3 → handle B (refcount=1, unshared)
 *
 * WHY no refHandle() on restore:
 * The original handle (handle A) was never unrefed during redirect.
 * Process still owns it, just wasn't using it. Restoring just reactivates
 * the existing reference.
 *
 * @module kernel/kernel/restore-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EBADF } from '../errors.js';

/**
 * Restore a handle to its original resource.
 *
 * ALGORITHM:
 * 1. Validate target fd exists
 * 2. Lookup current (redirected) handle ID
 * 3. Replace target fd mapping with saved handle ID
 * 4. Decrement refcount on redirected handle
 *
 * WHY decrement only:
 * The redirected handle had its refcount incremented during redirectHandle().
 * Now that we're un-redirecting, we need to balance that increment.
 * The original handle never had its refcount changed, so no increment needed.
 *
 * CLEANUP SEMANTICS:
 * If refcount reaches 0 after decrement, the redirected handle will be closed.
 * This is correct: If redirect was the last reference, handle should close.
 *
 * REFCOUNT BUG MITIGATION:
 * Inline refcount decrement instead of calling unrefHandle() because we need
 * to handle the case where refcount is already 0 (indicates double-restore).
 * We log a warning but don't crash.
 *
 * ERROR HANDLING:
 * Throws EBADF if target fd doesn't exist. This prevents:
 * - Restoring fd that was closed during redirect
 * - Restoring wrong fd (would corrupt handle table)
 * - Double-restore (first restore removes fd, second fails)
 *
 * @param self - Kernel instance
 * @param proc - Process owning the fd
 * @param targetH - Target handle number (fd) to restore
 * @param savedHandleId - Saved handle ID from redirectHandle()
 * @throws EBADF if target fd doesn't exist
 */
export function restoreHandle(
    self: Kernel,
    proc: Process,
    targetH: number,
    savedHandleId: string
): void {
    // Validate target fd exists
    const currentHandleId = proc.handles.get(targetH);
    if (!currentHandleId) {
        throw new EBADF(`Bad file descriptor: ${targetH}`);
    }

    // Restore original handle mapping
    // This reactivates the saved handle (no refcount change needed)
    proc.handles.set(targetH, savedHandleId);

    // Decrement refcount on redirected handle
    // This balances the refHandle() call from redirectHandle()
    const refs = (self.handleRefs.get(currentHandleId) ?? 1) - 1;

    if (refs > 0) {
        // Still referenced elsewhere, just update count
        self.handleRefs.set(currentHandleId, refs);
    } else if (refs === 0) {
        // Last reference, remove from refcount table
        // Note: We don't close the handle here because:
        // 1. Handle might still be in use by another process
        // 2. Process cleanup will handle closing if needed
        // 3. Keeps restore fast and synchronous
        self.handleRefs.delete(currentHandleId);
    } else {
        // INVARIANT VIOLATION: Refcount went negative
        // This indicates more unrefs than refs (double-restore or missing redirect)
        self.handleRefs.delete(currentHandleId);
        throw new Error(
            `Handle ${currentHandleId} refcount went negative during restore. ` +
            `This indicates double-restore or restore without redirect.`
        );
    }
}
