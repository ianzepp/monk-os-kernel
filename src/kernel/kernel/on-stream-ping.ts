/**
 * Stream Ping Handler (Backpressure Acknowledgement)
 *
 * WHY: Handles stream_ping messages from processes, implementing the consumer
 * side of the backpressure protocol. Processes send stream_ping every 100ms
 * with the count of items processed, allowing the kernel to resume sending
 * if it was throttled at high-water mark.
 *
 * BACKPRESSURE PROTOCOL:
 * 1. Kernel tracks items sent vs. acknowledged per stream
 * 2. Kernel pauses at STREAM_HIGH_WATER (1000 items unacknowledged)
 * 3. Process sends stream_ping with processed count every 100ms
 * 4. Kernel resumes at STREAM_LOW_WATER (100 items unacknowledged)
 * 5. Kernel aborts stream if no ping received for 5s (consumer dead)
 *
 * @module kernel/kernel/on-stream-ping
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';

/**
 * Handle stream_ping message from process (backpressure acknowledgement).
 *
 * WHY: Delegates to per-stream ping handler registered during syscall dispatch.
 * Each active stream has a callback that updates the acknowledged item count,
 * allowing the stream generator to resume if it was paused.
 *
 * INVARIANT: streamPingHandlers entry exists for every active stream
 * VIOLATED BY: Stream cleanup that doesn't remove handler, or ping arriving
 *              after stream completion (harmless - we just ignore it)
 *
 * @param _self - Kernel instance (unused - handler is on Process)
 * @param proc - Process that sent the ping
 * @param requestId - Request ID (matches original syscall)
 * @param processed - Number of items processed by consumer so far
 */
export function handleStreamPing(
    _self: Kernel,
    proc: Process,
    requestId: string,
    processed: number,
): void {
    const handler = proc.streamPingHandlers.get(requestId);

    if (handler) {
        // Update acknowledged count, potentially resuming paused stream
        handler(processed);
    }
    // WHY: Ignore pings for non-existent streams. This can happen if:
    // - Stream completed and handler was cleaned up
    // - Ping message arrived after stream_cancel
    // Both are harmless race conditions during cleanup.
}
