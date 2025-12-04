/**
 * Notify all processes waiting on a process's exit.
 *
 * @module kernel/kernel/notify-waiters
 */

import type { Kernel } from '../kernel.js';
import type { Process, ExitStatus } from '../types.js';

/**
 * Notify all processes waiting on a process's exit.
 *
 * @param self - Kernel instance
 * @param proc - Process that exited
 */
export function notifyWaiters(self: Kernel, proc: Process): void {
    const waiters = self.waiters.get(proc.id);
    if (!waiters) {
        return;
    }

    const status: ExitStatus = {
        pid: 0, // Caller sets correct PID
        code: proc.exitCode ?? 0,
    };

    // Notify all waiters
    for (const waiter of waiters) {
        waiter.callback(status);
    }

    // Clear waiters list
    self.waiters.delete(proc.id);
}
