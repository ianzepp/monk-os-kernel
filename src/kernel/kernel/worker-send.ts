/**
 * Send message to a leased worker.
 *
 * @module kernel/kernel/worker-send
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { getLeasedWorker } from './get-leased-worker.js';

/**
 * Send message to a leased worker.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param workerId - Worker ID
 * @param msg - Message to send
 */
export async function workerSend(
    self: Kernel,
    proc: Process,
    workerId: string,
    msg: unknown
): Promise<void> {
    const worker = getLeasedWorker(self, proc, workerId);
    await worker.send(msg);
}
