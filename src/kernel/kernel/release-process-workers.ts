/**
 * Worker Pool Release - Release all workers when process exits
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * When a process exits, any workers it leased from worker pools must be
 * released back to their pools for reuse. This function:
 * 1. Looks up all workers leased by the process
 * 2. Releases each worker back to its pool
 * 3. Logs any release failures
 * 4. Removes the process from the leased workers map
 *
 * Worker pools provide reusable worker threads for compute tasks. Without
 * proper cleanup, exiting processes would leak workers, exhausting the pools.
 *
 * INVARIANTS
 * ==========
 * INV-1: All leased workers must be released on process exit
 *        VIOLATED BY: Exiting without calling releaseProcessWorkers
 * INV-2: Release errors must be logged, not thrown
 *        VIOLATED BY: Allowing release() errors to propagate
 * INV-3: Process entry must be removed from leasedWorkers map
 *        VIOLATED BY: Leaving stale entry in map after cleanup
 *
 * CONCURRENCY MODEL
 * =================
 * Release is synchronous with async consequences:
 * - Iterates worker map synchronously
 * - Calls worker.release() which returns Promise
 * - Fire-and-forget: Errors logged but don't block cleanup
 * - Map deletion synchronous
 *
 * NOTE: worker.release() is async but we don't await it because:
 * - Process is exiting (can't wait for cleanup)
 * - Pool will handle release asynchronously
 * - Errors are logged for debugging
 *
 * @module kernel/kernel/release-process-workers
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Release all workers leased by a process.
 *
 * WHY FIRE-AND-FORGET: Process is exiting, can't wait for async release.
 * WHY LOG ERRORS: Release failures should be visible for debugging.
 * WHY DELETE ENTRY: Prevent memory leak of stale worker map entries.
 *
 * ALGORITHM:
 * 1. Look up workers leased by process (by UUID)
 * 2. If no workers, return immediately
 * 3. Iterate each worker and call release() (async)
 * 4. Catch and log any release errors
 * 5. Remove process entry from leasedWorkers map
 *
 * FIRE-AND-FORGET:
 * worker.release() returns a Promise but we don't await it because:
 * - Called from exit/forceExit which need immediate cleanup
 * - Pool handles async release internally
 * - Errors logged via catch handler (async)
 *
 * ERROR HANDLING:
 * Release can fail if:
 * - Worker pool was shut down
 * - Worker is in invalid state
 * - Worker already released (double-release)
 *
 * All errors are logged but don't prevent process cleanup. Worker pools
 * are resilient to double-release and invalid state.
 *
 * @param self - Kernel instance
 * @param proc - Process that is exiting
 */
export function releaseProcessWorkers(self: Kernel, proc: Process): void {
    // Look up workers leased by this process (keyed by UUID)
    const procWorkers = self.leasedWorkers.get(proc.id);

    if (!procWorkers) {
        // No workers leased, nothing to do
        return;
    }

    // -------------------------------------------------------------------------
    // FIRE-AND-FORGET: worker.release()
    // -------------------------------------------------------------------------
    //
    // WHAT: Release workers back to pool without awaiting. Each release runs
    // in background and we continue immediately.
    //
    // WHY: This is called from forceExit() which must be synchronous. The
    // process is already dead - we're just returning borrowed resources.
    //
    // TRADE-OFF: If release fails, the worker may be "leaked" from the pool's
    // perspective (marked as leased but never returned). This could eventually
    // exhaust the pool if it happens repeatedly.
    //
    // MITIGATION: Errors are logged so pool exhaustion can be diagnosed. The
    // pool itself has a maximum size, so exhaustion will surface as spawn
    // failures rather than silent resource leak.
    //
    // TODO: Consider adding a background cleanup queue that retries failed
    // releases, or a pool health check that reclaims orphaned workers.
    //
    for (const [workerId, worker] of procWorkers.entries()) {
        worker.release().catch((err: unknown) => {
            printk(self, 'cleanup', `worker ${workerId} release failed: ${formatError(err)}`);
        });
    }

    // Remove process entry from leasedWorkers map
    // WHY: Prevent memory leak of stale entries
    self.leasedWorkers.delete(proc.id);
}
