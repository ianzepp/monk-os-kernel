/**
 * Get a leased worker by ID.
 *
 * @module kernel/kernel/get-leased-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { LeasedWorker } from '../pool.js';
import { EBADF } from '../errors.js';

/**
 * Get a leased worker by ID.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param workerId - Worker ID
 * @returns Leased worker
 * @throws EBADF if worker not found
 */
export function getLeasedWorker(
    self: Kernel,
    proc: Process,
    workerId: string
): LeasedWorker {
    const procWorkers = self.leasedWorkers.get(proc.id);
    if (!procWorkers) {
        throw new EBADF(`No workers leased by process ${proc.id}`);
    }

    const worker = procWorkers.get(workerId);
    if (!worker) {
        throw new EBADF(`Worker not found: ${workerId}`);
    }

    return worker;
}
