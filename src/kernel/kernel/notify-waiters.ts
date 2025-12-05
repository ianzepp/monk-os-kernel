/**
 * Waiter Notification - Notify all processes waiting on child exit
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * When a process exits (via exit() or forceExit()), this function notifies
 * all parent processes blocked in wait() syscalls for that child. The
 * notification invokes their callbacks with the exit status, allowing the
 * wait() Promise to resolve.
 *
 * This is the coordination point between exiting children and waiting parents.
 * Without this notification, wait() would hang forever.
 *
 * INVARIANTS
 * ==========
 * INV-1: All waiters must be notified when process exits
 *        VIOLATED BY: Exiting without calling notifyWaiters
 * INV-2: Waiters list must be cleared after notification
 *        VIOLATED BY: Leaving waiters in map after notification
 * INV-3: Exit status must include exit code
 *        VIOLATED BY: Not setting proc.exitCode before calling
 *
 * CONCURRENCY MODEL
 * =================
 * Notification is synchronous and runs in exiting process's context:
 * - Called from exit() or forceExit() (main thread)
 * - Iterates waiter callbacks synchronously
 * - Each callback resolves a wait() Promise
 * - No async operations (immediate notification)
 *
 * NOTE: Callbacks run synchronously to ensure prompt notification before
 * process is fully cleaned up.
 *
 * @module kernel/kernel/notify-waiters
 */

import type { Kernel } from '../kernel.js';
import type { Process, ExitStatus } from '../types.js';

/**
 * Notify all processes waiting on this process's exit.
 *
 * WHY SYNCHRONOUS: Ensure waiters notified before cleanup completes.
 * WHY PID ZERO: Waiter callback sets correct PID from their namespace.
 * WHY CLEAR LIST: Prevent callbacks from being invoked multiple times.
 *
 * ALGORITHM:
 * 1. Lookup waiters list for exiting process (by UUID)
 * 2. If no waiters, return immediately
 * 3. Create exit status with code (PID set by callback)
 * 4. Invoke each waiter callback with status
 * 5. Clear waiters list from global map
 *
 * PID HANDLING:
 * Exit status has pid=0 because each waiter knows the PID in their own
 * namespace. The waiter callback sets the correct PID before resolving.
 *
 * MEMORY:
 * Waiter list is deleted after notification to free memory. Each waiter
 * callback is responsible for cleanup (reaping zombie, clearing timeout).
 *
 * @param self - Kernel instance
 * @param proc - Process that exited
 */
export function notifyWaiters(self: Kernel, proc: Process): void {
    // Lookup waiters for this process (keyed by UUID)
    const waiters = self.waiters.get(proc.id);

    if (!waiters) {
        // No one waiting, nothing to do
        return;
    }

    // Create exit status with code
    // WHY PID ZERO: Each waiter sets correct PID from their namespace
    const status: ExitStatus = {
        pid: 0,
        code: proc.exitCode ?? 0,
    };

    // Notify all waiters synchronously
    // WHY SYNC: Ensures notification happens before cleanup completes
    for (const waiter of waiters) {
        waiter.callback(status);
    }

    // Clear waiters list to free memory
    // WHY: Prevent double-notification if notifyWaiters called again
    self.waiters.delete(proc.id);
}
