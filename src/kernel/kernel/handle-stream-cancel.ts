/**
 * Handle stream cancel (consumer wants to stop).
 *
 * @module kernel/kernel/handle-stream-cancel
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';

/**
 * Handle stream cancel (consumer wants to stop).
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param requestId - Request ID
 */
export function handleStreamCancel(
    _self: Kernel,
    proc: Process,
    requestId: string
): void {
    const abort = proc.activeStreams.get(requestId);
    if (abort) {
        abort.abort();
        proc.activeStreams.delete(requestId);
        proc.streamPingHandlers.delete(requestId);
    }
}
