/**
 * Send Response to Process
 *
 * WHY: Centralizes error handling for worker.postMessage() calls. Worker
 * termination creates a race condition where responses may be sent to dead
 * workers. This wrapper catches and logs those errors instead of propagating
 * them up, since they're expected during process cleanup.
 *
 * RACE CONDITION: Worker may terminate between state check and postMessage.
 * We catch errors from postMessage rather than pre-checking worker state
 * because pre-checking would be a TOCTOU bug (worker could die between check
 * and send).
 *
 * @module kernel/kernel/send-response
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Response } from '../../message.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Send a response to a process via worker.postMessage().
 *
 * SAFETY: Catches and logs errors from postMessage. This can happen if:
 * - Worker is terminating (state transition in progress)
 * - Worker has been terminated (state is 'zombie')
 * - postMessage itself fails (malformed data, though this should be rare)
 *
 * WHY: We log but don't throw because the kernel continues operating even
 * when individual processes fail. Throwing would abort syscall processing.
 *
 * @param self - Kernel instance
 * @param proc - Target process
 * @param requestId - Request ID for correlation (matches syscall request)
 * @param response - Response to send
 */
export function sendResponse(
    self: Kernel,
    proc: Process,
    requestId: string,
    response: Response
): void {
    try {
        // RACE CONDITION: Worker may be terminating here
        // We catch the error below rather than pre-checking state
        proc.worker.postMessage({
            type: 'response',
            id: requestId,
            result: response,
        });
    } catch (err) {
        // Expected during worker termination - log but don't throw
        // WHY: Kernel must continue processing even when individual workers fail
        printk(self, 'warn', `Failed to send response to ${proc.cmd}: ${formatError(err)}`);
    }
}
