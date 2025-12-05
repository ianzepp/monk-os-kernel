/**
 * Stream Cancel Handler (Consumer Abort)
 *
 * WHY: Handles stream_cancel messages from processes, allowing consumers to
 * abort streaming syscalls early (e.g., readdir when only first N entries needed).
 * Triggers AbortSignal in the syscall generator, causing it to cleanup and exit.
 *
 * STREAM LIFECYCLE:
 * 1. Syscall starts → register AbortController in proc.activeStreams
 * 2. Consumer receives items → sends stream_ping for backpressure
 * 3. Consumer done early → sends stream_cancel
 * 4. Kernel calls abort.abort() → syscall sees signal and cleanups
 * 5. Kernel removes stream from activeStreams and streamPingHandlers
 *
 * @module kernel/kernel/on-stream-cancel
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';

/**
 * Handle stream_cancel message from process (consumer abort).
 *
 * WHY: Allows processes to stop streaming syscalls early without waiting for
 * natural completion. Examples: head(1) reading first N lines, or database
 * query with LIMIT that stops after N rows.
 *
 * CLEANUP ORDER:
 * 1. Signal abort to syscall generator (abort.abort())
 * 2. Remove AbortController from activeStreams (prevents double-abort)
 * 3. Remove ping handler from streamPingHandlers (prevents stale callbacks)
 *
 * WHY: We delete stream entries before syscall fully cleans up. This prevents
 * race conditions where a second cancel arrives while first is processing.
 * Double-abort is safe (AbortController is idempotent), but we avoid it anyway.
 *
 * INVARIANT: Every active stream has entries in both Maps
 * VIOLATED BY: Stream completion that doesn't cleanup (memory leak)
 *
 * @param _self - Kernel instance (unused - state is on Process)
 * @param proc - Process that sent the cancel
 * @param requestId - Request ID (matches original syscall)
 */
export function handleStreamCancel(
    _self: Kernel,
    proc: Process,
    requestId: string,
): void {
    const abort = proc.activeStreams.get(requestId);

    if (abort) {
        // Signal syscall to abort (triggers AbortSignal listeners)
        abort.abort();

        // Remove from tracking Maps (prevents double-abort, releases memory)
        // WHY: Delete before syscall cleanup completes to prevent race with
        // second cancel message arriving during cleanup.
        proc.activeStreams.delete(requestId);
        proc.streamPingHandlers.delete(requestId);
    }
    // WHY: Ignore cancel for non-existent streams. This can happen if:
    // - Stream already completed naturally
    // - Second cancel arrived after first
    // Both are harmless - AbortController.abort() is idempotent.
}
