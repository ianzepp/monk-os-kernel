/**
 * Interrupt Process - Abort streams and close handles to unblock syscalls
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * When a process is blocked in a syscall (e.g., waiting on port.recv()), it
 * cannot process signals delivered via postMessage. This function interrupts
 * the blocked syscall by:
 * 1. Aborting all active streams (sets abort signal)
 * 2. Closing all handles (causes blocking operations to fail)
 *
 * After interruption, the blocked syscall returns an error to userspace,
 * freeing the event loop to process pending signals.
 *
 * WHY: POSIX kernels interrupt blocked syscalls when signals arrive, returning
 * EINTR. We achieve similar behavior by closing the underlying resources.
 *
 * INVARIANTS
 * ==========
 * INV-1: All active streams must be aborted
 * INV-2: All handles must be closed (awaited, not fire-and-forget)
 * INV-3: Process handle maps must be cleared after closing
 *
 * @module kernel/kernel/interrupt-process
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Interrupt a process by aborting streams and closing handles.
 *
 * This unblocks any syscalls the process is waiting on, allowing it to
 * process pending signals.
 *
 * WHY AWAIT CLOSES: Fire-and-forget closes don't guarantee the blocking
 * operation is interrupted before we return. We must await to ensure the
 * process is actually unblocked.
 *
 * WHY CLEAR MAPS: After closing, handles are invalid. Clear the maps to
 * prevent use-after-close and ensure forceExit doesn't double-close.
 *
 * @param self - Kernel instance
 * @param proc - Process to interrupt
 */
export async function interruptProcess(self: Kernel, proc: Process): Promise<void> {
    // =========================================================================
    // STEP 1: Abort all active streams
    // =========================================================================

    // WHY: Sets abort signal on pending syscalls. The dispatcher checks this
    // after each await and will exit the loop when it sees the signal.
    for (const abort of proc.activeStreams.values()) {
        abort.abort();
    }

    // WHY: Prevents timeout handlers from firing after abort
    proc.streamPingHandlers.clear();

    // =========================================================================
    // STEP 2: Close all handles
    // =========================================================================

    // WHY: Closing handles causes blocking operations (like port.recv()) to
    // throw errors, unblocking the syscall handler and allowing the dispatcher
    // to exit.

    // Collect handles before clearing the map
    const handleIds = Array.from(proc.handles.values());

    // Close all handles, awaiting each one
    // WHY AWAIT ALL: We need all closes to complete before returning, but we
    // can close them in parallel for efficiency.
    const closePromises = handleIds.map(async handleId => {
        const handle = self.handles.get(handleId);

        if (handle) {
            try {
                await handle.close();
            }
            catch (err) {
                // Log but don't throw - we want to close all handles even if some fail
                printk(self, 'cleanup', `Failed to close handle ${handleId}: ${formatError(err)}`);
            }

            // Clean up kernel tables
            self.handles.delete(handleId);
            self.handleRefs.delete(handleId);
        }
    });

    await Promise.all(closePromises);

    // Clear process handle map
    // WHY: Handles are now invalid, prevent use-after-close
    proc.handles.clear();

    // Clear active streams (already aborted, but clear the map)
    proc.activeStreams.clear();

    printk(self, 'signal', `Interrupted ${proc.cmd}: closed ${handleIds.length} handles`);
}
