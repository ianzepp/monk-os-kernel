/**
 * Handle Redirect - Point one fd to another's resource
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Redirects a file descriptor to point to another fd's handle, similar to dup2().
 * Used for I/O redirection (e.g., piping stdout to a file, redirecting stderr
 * to stdout). The target fd effectively becomes an alias for the source fd.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Both source and target fds must exist before redirect
 *        VIOLATED BY: Redirecting non-existent fds, redirecting after close
 * INV-2: Source handle refcount is incremented exactly once
 *        VIOLATED BY: Missing refHandle() call, double-increment
 * INV-3: Target fd's original handle is saved and returned
 *        VIOLATED BY: Losing saved handle ID (prevents restore)
 * INV-4: After redirect, both fds point to source's handle
 *        VIOLATED BY: Incorrect mapping update, swapping source/target
 *
 * CONCURRENCY MODEL
 * =================
 * Single-threaded: All handle operations run in main kernel thread.
 * No async points, no race conditions.
 *
 * REDIRECT SEMANTICS (dup2-like behavior)
 * ========================================
 * redirectHandle(target, source) makes target point to source's resource:
 *
 * Before:
 *   fd 1 → handle A (stdout to console)
 *   fd 3 → handle B (file "/tmp/out")
 *
 * After redirectHandle(1, 3):
 *   fd 1 → handle B (stdout now goes to file)
 *   fd 3 → handle B (same)
 *   handle B refcount: 2 (shared)
 *   handle A refcount: 1 (orphaned but saved for restore)
 *
 * MEMORY MANAGEMENT
 * =================
 * Redirect increases handle sharing:
 * 1. Source handle refcount increases (now referenced by both fds)
 * 2. Target handle refcount stays same (still owned by process, just inactive)
 * 3. Caller must save returned handle ID for restoreHandle()
 * 4. Failing to restore leaks the original handle (refcount never decrements)
 *
 * WHY not close original handle:
 * Redirect is temporary. Caller will restore later, reactivating original handle.
 * If we closed it, restore would fail.
 *
 * @module kernel/kernel/redirect-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EBADF } from '../errors.js';
import { refHandle } from './ref-handle.js';

/**
 * Redirect a handle to point to another handle's resource.
 *
 * ALGORITHM:
 * 1. Validate source fd exists and lookup its handle ID
 * 2. Validate target fd exists and save its handle ID
 * 3. Update target fd to point to source's handle ID
 * 4. Increment refcount on source's handle (now shared)
 * 5. Return saved handle ID (for later restore)
 *
 * WHY increment source refcount:
 * Source handle is now referenced by both source fd and target fd.
 * Must keep handle alive until both fds are closed or restore happens.
 *
 * WHY save target's original handle:
 * Allows undoing the redirect via restoreHandle(). Without this, original
 * handle would be lost forever (memory leak).
 *
 * ERROR HANDLING:
 * Throws EBADF if either fd doesn't exist. This prevents:
 * - Redirecting to/from closed fds
 * - Redirecting non-existent fds (would corrupt handle table)
 * - Partial redirect (e.g., source valid but target invalid)
 *
 * USAGE PATTERN (I/O redirection):
 * ```typescript
 * // Redirect stdout to file
 * const outFile = await open('/tmp/output', { write: true, create: true });
 * const saved = redirectHandle(kernel, proc, 1, outFile); // fd 1 is stdout
 *
 * // Run command (stdout goes to file)
 * await executeCommand(...);
 *
 * // Restore stdout
 * restoreHandle(kernel, proc, 1, saved);
 * await close(outFile);
 * ```
 *
 * RACE CONDITION: Redirect during I/O
 * ====================================
 * If redirect happens while target fd has pending I/O:
 * - Pending reads/writes will complete on original handle
 * - New operations will use redirected handle
 * - This is correct behavior (matches UNIX dup2 semantics)
 *
 * MITIGATION: None needed. I/O operations hold handle reference while active,
 * so original handle won't be closed until I/O completes.
 *
 * @param self - Kernel instance
 * @param proc - Process owning both fds
 * @param targetH - Target handle number (fd) to redirect
 * @param sourceH - Source handle number (fd) to redirect to
 * @returns Saved handle ID for later restoration
 * @throws EBADF if either fd doesn't exist
 */
export function redirectHandle(
    self: Kernel,
    proc: Process,
    targetH: number,
    sourceH: number
): string {
    // Validate source fd and get its handle ID
    const sourceHandleId = proc.handles.get(sourceH);
    if (!sourceHandleId) {
        throw new EBADF(`Bad source file descriptor: ${sourceH}`);
    }

    // Validate target fd and save its handle ID
    const savedHandleId = proc.handles.get(targetH);
    if (!savedHandleId) {
        throw new EBADF(`Bad target file descriptor: ${targetH}`);
    }

    // Point target to source's handle
    // After this, both targetH and sourceH reference the same handle
    proc.handles.set(targetH, sourceHandleId);

    // Increment refcount on source's handle
    // WHY: Handle is now shared between targetH and sourceH
    refHandle(self, sourceHandleId);

    // Return saved handle ID for later restore
    // CRITICAL: Caller must store this to prevent handle leak
    // If restore never happens, original handle stays alive until process exit
    return savedHandleId;
}
