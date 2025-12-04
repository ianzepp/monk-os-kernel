/**
 * Load a script into a leased worker.
 *
 * @module kernel/kernel/load-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { getLeasedWorker } from './get-leased-worker.js';

/**
 * Load a script into a leased worker.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param workerId - Worker ID
 * @param path - Script path
 */
export async function workerLoad(
    self: Kernel,
    proc: Process,
    workerId: string,
    path: string
): Promise<void> {
    const worker = getLeasedWorker(self, proc, workerId);
    await worker.load(path);
}
