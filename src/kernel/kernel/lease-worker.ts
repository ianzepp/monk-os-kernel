/**
 * Lease a worker from a pool.
 *
 * @module kernel/kernel/lease-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';

/**
 * Lease a worker from a pool.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param pool - Pool name (optional)
 * @returns Worker ID
 */
export async function leaseWorker(
    self: Kernel,
    proc: Process,
    pool?: string
): Promise<string> {
    const worker = await self.poolManager.lease(pool);

    let procWorkers = self.leasedWorkers.get(proc.id);
    if (!procWorkers) {
        procWorkers = new Map();
        self.leasedWorkers.set(proc.id, procWorkers);
    }
    procWorkers.set(worker.id, worker);

    return worker.id;
}
