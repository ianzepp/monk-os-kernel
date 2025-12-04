/**
 * Worker Lookup Helper
 *
 * WHY: Validates that a worker ID belongs to the calling process and returns
 * the LeasedWorker object. Used by all worker syscalls (load, send, recv, release)
 * to enforce ownership before operations.
 *
 * SECURITY: Prevents processes from accessing workers leased by other processes.
 * Worker IDs are UUIDs and globally unique, but we check ownership to prevent
 * accidental or malicious cross-process worker access.
 *
 * @module kernel/kernel/get-leased-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { LeasedWorker } from '../pool.js';
import { EBADF } from '../errors.js';

/**
 * Get a leased worker by ID, validating ownership.
 *
 * ALGORITHM:
 * 1. Look up process's worker Map in Kernel.leasedWorkers
 * 2. If process has no workers, throw EBADF
 * 3. Look up worker in process's Map
 * 4. If worker not found, throw EBADF
 * 5. Return LeasedWorker object
 *
 * WHY: Two-step lookup (process → worker) enforces ownership. A process cannot
 * access workers leased by other processes, even if it knows the worker UUID.
 *
 * ERROR HANDLING:
 * - EBADF if worker not found (analogous to "bad file descriptor")
 * - Specific error message distinguishes "no workers" vs "worker not found"
 *
 * @param self - Kernel instance
 * @param proc - Process requesting access
 * @param workerId - Worker ID to look up
 * @returns LeasedWorker object
 * @throws EBADF if process has no leased workers
 * @throws EBADF if worker ID not found in process's workers
 */
export function getLeasedWorker(
    self: Kernel,
    proc: Process,
    workerId: string
): LeasedWorker {
    // Step 1: Look up process's worker Map
    const procWorkers = self.leasedWorkers.get(proc.id);
    if (!procWorkers) {
        // Process has never leased any workers
        throw new EBADF(`No workers leased by process ${proc.id}`);
    }

    // Step 2: Look up worker in process's Map
    const worker = procWorkers.get(workerId);
    if (!worker) {
        // Worker ID not found (may belong to another process, or already released)
        throw new EBADF(`Worker not found: ${workerId}`);
    }

    return worker;
}
