/**
 * Worker Receive Syscall
 *
 * WHY: Receives a message from a leased worker, completing the bidirectional
 * communication channel. Blocks until worker sends a message, enabling request-
 * response patterns between process and worker.
 *
 * SECURITY: Worker must be leased by calling process (validated by getLeasedWorker).
 *
 * @module kernel/kernel/recv-worker
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { getLeasedWorker } from './get-leased-worker.js';

/**
 * Receive a message from a leased worker.
 *
 * ALGORITHM:
 * 1. Validate worker ownership (via getLeasedWorker)
 * 2. Delegate to LeasedWorker.recv() to wait for message
 * 3. Return message when worker sends it
 *
 * WHY: This is a blocking operation (async/await). The calling process's syscall
 * will wait until the worker posts a message. This enables clean request-response
 * patterns without polling or callbacks.
 *
 * BLOCKING SEMANTICS: If worker never sends a message, this will hang indefinitely.
 * Callers should use timeouts or AbortSignal if they need bounded wait times.
 *
 * @param self - Kernel instance
 * @param proc - Process receiving the message
 * @param workerId - Worker ID (must be leased by proc)
 * @returns Message from worker (arbitrary structured data)
 * @throws EBADF if worker not leased by calling process
 */
export async function workerRecv(
    self: Kernel,
    proc: Process,
    workerId: string
): Promise<unknown> {
    // Step 1: Validate ownership and get worker
    const worker = getLeasedWorker(self, proc, workerId);

    // Step 2: Wait for message from worker (blocks until available)
    // WHY: LeasedWorker.recv() handles message queue and async waiting
    return worker.recv();
}
