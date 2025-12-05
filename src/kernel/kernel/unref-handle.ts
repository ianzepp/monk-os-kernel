/**
 * Handle Reference Decrement - Decrease refcount, close when zero
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Decrements the reference count for a handle and triggers cleanup when the
 * count reaches zero. This is the primary resource cleanup mechanism for handles.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every unrefHandle() must be matched by a prior ref (alloc or ref)
 *        VIOLATED BY: Double-close, close without allocate
 * INV-2: Handle is closed and removed when refcount reaches 0
 *        VIOLATED BY: Skipping close() call, forgetting to delete from tables
 * INV-3: Refcount is deleted from handleRefs when reaching 0
 *        VIOLATED BY: Leaving orphaned refcount entries (memory leak)
 * INV-4: Handle is removed from kernel.handles when refcount reaches 0
 *        VIOLATED BY: Leaving orphaned handle entries (memory leak)
 *
 * CONCURRENCY MODEL
 * =================
 * Single-threaded: All handle operations run in main kernel thread.
 *
 * ASYNC CLOSE HANDLING:
 * handle.close() is async but we don't await it. This is intentional:
 * 1. Prevents blocking the kernel on slow I/O cleanup
 * 2. Errors are caught and logged, don't propagate to caller
 * 3. Handle is removed from tables immediately (synchronously)
 * 4. Any in-flight I/O will complete/fail independently
 *
 * RACE CONDITION: handle.close() failure
 * =======================================
 * If close() fails (e.g., flush error, socket already closed), we log but
 * don't retry. The handle is already removed from kernel tables, so it's
 * unreachable. Resource leaks at HAL level are acceptable (OS will clean up).
 *
 * MEMORY MANAGEMENT
 * =================
 * Cleanup sequence when refcount reaches 0:
 * 1. Lookup handle object from kernel.handles
 * 2. Call handle.close() (async, fire-and-forget)
 * 3. Remove from kernel.handles (prevents new references)
 * 4. Remove from handleRefs (frees refcount memory)
 *
 * WHY delete before close completes:
 * Prevents use-after-close bugs. Once refcount hits 0, handle is dead.
 * No new operations should start, even if close() hasn't finished yet.
 *
 * @module kernel/kernel/unref-handle
 */

import type { Kernel } from '../kernel.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Decrement reference count, closing handle if last reference.
 *
 * ALGORITHM:
 * 1. Lookup current refcount (default to 1 if missing - defensive)
 * 2. Decrement refcount
 * 3. If refcount > 0: Update refcount and return
 * 4. If refcount <= 0: Trigger cleanup
 *    a. Lookup handle object
 *    b. Call handle.close() (async, don't await)
 *    c. Remove from kernel.handles
 *    d. Remove from handleRefs
 *
 * WHY default refcount to 1:
 * Defensive programming. If handleRefs entry is missing, we assume 1 to
 * prevent premature cleanup. This is a bug (missing allocHandle/refHandle)
 * but won't cause crashes.
 *
 * CLEANUP ORDER:
 * Critical: Must delete from kernel.handles BEFORE close() completes.
 * This prevents race where another operation tries to use the handle
 * between refcount=0 and close completion.
 *
 * ERROR HANDLING:
 * close() errors are logged but not thrown. WHY:
 * 1. Caller has already released ownership (refcount=0)
 * 2. Handle is unrecoverable (can't retry close)
 * 3. Propagating error would complicate all close paths
 * 4. OS-level resources will be cleaned up on process exit
 *
 * @param self - Kernel instance
 * @param handleId - Handle ID to unreference
 */
export function unrefHandle(self: Kernel, handleId: string): void {
    // Decrement refcount
    const refs = (self.handleRefs.get(handleId) ?? 1) - 1;

    if (refs > 0) {
        // Still referenced, update count and return
        self.handleRefs.set(handleId, refs);

        return;
    }

    // Refcount reached 0, trigger cleanup
    // CRITICAL: Delete from tables BEFORE calling close()
    // This prevents use-after-close if another operation is in flight
    const handle = self.handles.get(handleId);

    self.handles.delete(handleId);
    self.handleRefs.delete(handleId);

    // If handle exists, close it (async, fire-and-forget)
    if (handle) {
        // Fire-and-forget: Don't await, don't propagate errors
        // WHY: Prevents blocking kernel on slow I/O cleanup
        handle.close().catch(err => {
            // Log failure but don't propagate (handle is already gone)
            printk(
                self,
                'cleanup',
                `handle ${handleId} (${handle.type}) close failed: ${formatError(err)}`,
            );
        });
    }
    else {
        // INVARIANT VIOLATION: Refcount exists but handle doesn't
        // This indicates allocHandle() set refcount but didn't add handle,
        // or cleanup happened in wrong order
        printk(
            self,
            'warn',
            `Refcount for ${handleId} reached 0 but handle not found. ` +
            `Possible refcount bug or double-close.`,
        );
    }

    // Note: If refs < 0, we've already deleted everything above
    // This indicates more unrefs than refs (caller bug)
    if (refs < 0) {
        printk(
            self,
            'warn',
            `Handle ${handleId} refcount went negative (${refs}). ` +
            `This indicates more unrefs than refs (double-close or missing ref).`,
        );
    }
}
