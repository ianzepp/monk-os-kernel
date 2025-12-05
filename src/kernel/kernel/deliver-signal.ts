/**
 * Signal Delivery - Send signal message to process worker
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Delivers a signal to a process by sending a message to its worker thread.
 * The worker receives the signal via its message handler and can respond
 * appropriately (e.g., graceful shutdown on SIGTERM).
 *
 * This is a thin wrapper around worker.postMessage that handles errors
 * gracefully. Signal delivery is best-effort - if the worker is dead or
 * terminating, the message may not arrive, but we log the failure.
 *
 * INVARIANTS
 * ==========
 * INV-1: Signal message must have correct format
 *        VIOLATED BY: Incorrect message structure
 * INV-2: Errors must be logged, not thrown
 *        VIOLATED BY: Allowing postMessage errors to propagate
 *
 * CONCURRENCY MODEL
 * =================
 * Signal delivery crosses thread boundaries:
 * - MAIN THREAD: This function runs in kernel (main thread)
 * - WORKER THREAD: Message is delivered to process worker thread
 * - postMessage uses structured clone (safe cross-thread communication)
 *
 * NOTE: postMessage may fail if worker is terminating. This is expected
 * and logged, not treated as fatal error.
 *
 * @module kernel/kernel/deliver-signal
 */

import type { Kernel } from '../kernel.js';
import type { Process, SignalMessage } from '../types.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Deliver a signal to a process worker thread.
 *
 * WHY CATCH ERRORS: Worker may be terminating, postMessage can throw.
 * WHY LOG NOT THROW: Signal delivery is best-effort, failure is expected.
 * WHY STRUCTURED MESSAGE: Worker expects specific message format.
 *
 * ALGORITHM:
 * 1. Create signal message with type and signal number
 * 2. Send to worker via postMessage (cross-thread communication)
 * 3. Catch and log any errors (worker may be dead)
 *
 * ERROR HANDLING:
 * postMessage can fail if:
 * - Worker is terminating
 * - Worker has already terminated
 * - Message cannot be cloned
 *
 * All errors are logged but not propagated. Signal delivery is best-effort
 * because the process may already be in the process of exiting.
 *
 * @param self - Kernel instance
 * @param proc - Target process
 * @param signal - Signal number (SIGTERM, SIGKILL, etc.)
 */
export function deliverSignal(self: Kernel, proc: Process, signal: number): void {
    // Construct signal message for worker
    const msg: SignalMessage = {
        type: 'signal',
        signal,
    };

    // Attempt delivery (best-effort)
    try {
        proc.worker.postMessage(msg);
    }
    catch (err) {
        // Log failure but don't throw
        // WHY: Worker may be terminating, this is expected
        printk(self, 'warn', `Failed to deliver signal to ${proc.cmd}: ${formatError(err)}`);
    }
}
