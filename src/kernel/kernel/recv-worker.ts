/**
 * Receive message from a leased worker.
 *
 * @module kernel/kernel/recv-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { getLeasedWorker } from './get-leased-worker.js';

/**
 * Receive message from a leased worker.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param workerId - Worker ID
 * @returns Message from worker
 */
export async function workerRecv(
    self: Kernel,
    proc: Process,
    workerId: string
): Promise<unknown> {
    const worker = getLeasedWorker(self, proc, workerId);
    return worker.recv();
}
