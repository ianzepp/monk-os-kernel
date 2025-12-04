/**
 * Worker Send Syscall
 *
 * WHY: Sends a message to a leased worker, enabling bidirectional communication
 * between the owning process and the worker. Messages are structured (not serialized),
 * following Monk OS's message-first philosophy.
 *
 * SECURITY: Worker must be leased by calling process (validated by getLeasedWorker).
 *
 * @module kernel/kernel/send-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { getLeasedWorker } from './get-leased-worker.js';

/**
 * Send a message to a leased worker.
 *
 * ALGORITHM:
 * 1. Validate worker ownership (via getLeasedWorker)
 * 2. Delegate to LeasedWorker.send() for message delivery
 *
 * WHY: Messages are structured objects, not serialized bytes. This matches
 * Monk OS's philosophy: serialization only happens at true I/O boundaries
 * (disk, network). Worker communication is in-memory message passing.
 *
 * @param self - Kernel instance
 * @param proc - Process sending the message
 * @param workerId - Worker ID (must be leased by proc)
 * @param msg - Message to send (arbitrary structured data)
 * @throws EBADF if worker not leased by calling process
 */
export async function workerSend(
    self: Kernel,
    proc: Process,
    workerId: string,
    msg: unknown
): Promise<void> {
    // Step 1: Validate ownership and get worker
    const worker = getLeasedWorker(self, proc, workerId);

    // Step 2: Send message to worker
    // WHY: LeasedWorker.send() handles postMessage and async delivery
    await worker.send(msg);
}
