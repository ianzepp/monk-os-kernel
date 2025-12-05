/**
 * Handle Reference Increment - Increase handle refcount
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Increments the reference count for a handle when a new fd is created that
 * points to an existing handle. Used by redirect (dup) and handle sharing
 * across processes.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: refHandle() is called exactly once per new reference
 *        VIOLATED BY: Forgetting to ref on dup/redirect, double-refing
 * INV-2: Every refHandle() must be balanced by exactly one unrefHandle()
 *        VIOLATED BY: Missing close, double-close
 * INV-3: Refcount never goes negative
 *        VIOLATED BY: More unrefs than refs (indicates missing ref call)
 * INV-4: Handle must exist in kernel.handles when refcount > 0
 *        VIOLATED BY: Refing a handle that was never allocated
 *
 * CONCURRENCY MODEL
 * =================
 * Single-threaded: All handle operations run in main kernel thread.
 * No async points, no race conditions.
 *
 * MEMORY MANAGEMENT
 * =================
 * Reference counting ensures handles are kept alive while in use:
 * - allocHandle() sets refcount=1 (first reference)
 * - refHandle() increments refcount (additional references)
 * - unrefHandle() decrements refcount, closes at 0
 *
 * WHY reference counting:
 * Multiple fds can point to the same handle (dup, redirect). Handle must
 * stay alive until all references are closed. Refcount tracks this.
 *
 * @module kernel/kernel/ref-handle
 */

import type { Kernel } from '../kernel.js';

/**
 * Increment reference count for a handle.
 *
 * ALGORITHM:
 * 1. Lookup current refcount (default to 1 if missing)
 * 2. Increment refcount
 * 3. Store updated refcount
 *
 * WHY default to 1:
 * Defensive programming. If caller forgot to allocHandle() first, this
 * prevents refcount going to 0 prematurely. However, this is still a bug
 * that should be caught in testing.
 *
 * SAFETY:
 * This function doesn't validate that the handle exists in kernel.handles.
 * Caller must ensure handle was properly allocated first. If handle doesn't
 * exist, refcount will be orphaned and leak memory (but won't crash).
 *
 * USAGE PATTERN:
 * - redirectHandle() calls this after creating new fd → handle mapping
 * - spawn() calls this when passing handle to child process
 * - dup() calls this when duplicating fd
 *
 * @param self - Kernel instance
 * @param handleId - Handle ID to reference
 */
export function refHandle(self: Kernel, handleId: string): void {
    const refs = self.handleRefs.get(handleId) ?? 1;

    self.handleRefs.set(handleId, refs + 1);

    // INVARIANT: Handle should exist if we're refing it
    // This check is not enforced here for performance, but violations
    // will be caught later when handle is used (getHandle will fail)
}
