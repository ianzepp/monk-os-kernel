/**
 * Release a leased worker.
 *
 * @module kernel/kernel/release-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EBADF } from '../errors.js';

/**
 * Release a leased worker.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param workerId - Worker ID
 */
export async function workerRelease(
    self: Kernel,
    proc: Process,
    workerId: string
): Promise<void> {
    const procWorkers = self.leasedWorkers.get(proc.id);
    if (!procWorkers) {
        throw new EBADF(`No workers leased by process ${proc.id}`);
    }

    const worker = procWorkers.get(workerId);
    if (!worker) {
        throw new EBADF(`Worker not found: ${workerId}`);
    }

    await worker.release();
    procWorkers.delete(workerId);

    if (procWorkers.size === 0) {
        self.leasedWorkers.delete(proc.id);
    }
}
