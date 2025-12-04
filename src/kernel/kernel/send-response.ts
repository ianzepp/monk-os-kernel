/**
 * Send a response to a process.
 *
 * SAFETY: Catches and logs errors from postMessage.
 * This can happen if worker is terminating.
 *
 * @module kernel/kernel/send-response
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Response } from '../../message.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Send a response to a process.
 *
 * @param self - Kernel instance
 * @param proc - Target process
 * @param requestId - Request ID for correlation
 * @param response - Response to send
 */
export function sendResponse(
    self: Kernel,
    proc: Process,
    requestId: string,
    response: Response
): void {
    try {
        proc.worker.postMessage({
            type: 'response',
            id: requestId,
            result: response,
        });
    } catch (err) {
        // Worker may be terminating - log but don't throw
        printk(self, 'warn', `Failed to send response to ${proc.cmd}: ${formatError(err)}`);
    }
}
