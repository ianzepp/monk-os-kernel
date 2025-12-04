/**
 * Handle stream ping (progress report from consumer).
 *
 * @module kernel/kernel/handle-stream-ping
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';

/**
 * Handle stream ping (progress report from consumer).
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param requestId - Request ID
 * @param processed - Number of items processed
 */
export function handleStreamPing(
    _self: Kernel,
    proc: Process,
    requestId: string,
    processed: number
): void {
    const handler = proc.streamPingHandlers.get(requestId);
    if (handler) {
        handler(processed);
    }
}
