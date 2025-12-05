/**
 * Worker Pool Release Syscall
 *
 * WHY: Returns a leased worker to its pool, making it available for other
 * processes. Cleans up tracking state to prevent memory leaks. Called explicitly
 * by processes, or automatically during process cleanup on exit.
 *
 * RESOURCE CLEANUP:
 * 1. Validate worker ownership (via tracking Map)
 * 2. Call worker.release() to return to pool
 * 3. Remove from per-process tracking Map
 * 4. If process has no more workers, delete outer Map entry
 *
 * INVARIANT: Releasing a worker removes it from both tracking and pool state
 * VIOLATED BY: Release failure that leaves worker in tracking (double-release risk)
 *
 * @module kernel/kernel/release-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EBADF } from '../errors.js';

/**
 * Release a leased worker back to its pool.
 *
 * ALGORITHM:
 * 1. Look up process's worker Map
 * 2. If process has no workers, throw EBADF
 * 3. Look up worker in Map
 * 4. If worker not found, throw EBADF
 * 5. Call worker.release() (async - may cleanup worker state)
 * 6. Remove from tracking Map
 * 7. If Map now empty, delete outer entry (prevent memory leak)
 *
 * WHY: We lookup before releasing to validate ownership. A process cannot
 * release workers leased by other processes. Error codes match get-leased-worker
 * for consistency.
 *
 * MEMORY MANAGEMENT: Step 7 prevents outer Map growth. If we didn't delete
 * empty inner Maps, Kernel.leasedWorkers would grow unbounded as processes
 * lease and release workers.
 *
 * RACE CONDITION: Process may exit while release is in progress. This is safe
 * because process cleanup (cleanup-process.ts) also calls worker.release(), and
 * LeasedWorker.release() is idempotent.
 *
 * @param self - Kernel instance
 * @param proc - Process releasing worker
 * @param workerId - Worker ID to release
 * @throws EBADF if process has no leased workers
 * @throws EBADF if worker ID not found in process's workers
 */
export async function workerRelease(
    self: Kernel,
    proc: Process,
    workerId: string,
): Promise<void> {
    // Step 1: Look up process's worker Map
    const procWorkers = self.leasedWorkers.get(proc.id);

    if (!procWorkers) {
        throw new EBADF(`No workers leased by process ${proc.id}`);
    }

    // Step 2: Look up worker in Map (validates ownership)
    const worker = procWorkers.get(workerId);

    if (!worker) {
        throw new EBADF(`Worker not found: ${workerId}`);
    }

    // Step 3: Release worker back to pool (async cleanup)
    // WHY: LeasedWorker.release() is idempotent, safe if called multiple times
    await worker.release();

    // Step 4: Remove from tracking Map (prevents double-release)
    procWorkers.delete(workerId);

    // Step 5: Clean up outer Map entry if process has no more workers
    // WHY: Prevents memory leak from empty Maps accumulating in leasedWorkers
    if (procWorkers.size === 0) {
        self.leasedWorkers.delete(proc.id);
    }
}
