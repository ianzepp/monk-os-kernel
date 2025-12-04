/**
 * Wait for a child process to exit.
 *
 * RACE CONDITION MITIGATIONS:
 * 1. Check zombie state first (process may have already exited)
 * 2. Waiter cleanup function removes callback on timeout
 * 3. Clear timeout on successful wait
 *
 * @module kernel/kernel/wait
 */

import type { Kernel } from '../kernel.js';
import type { Process, ExitStatus } from '../types.js';
import { ESRCH, ECHILD, ETIMEDOUT } from '../errors.js';
import { reapZombie } from './reap-zombie.js';

/**
 * Wait for a child process to exit.
 *
 * @param self - Kernel instance
 * @param caller - Calling process
 * @param pid - PID to wait for
 * @param timeout - Optional timeout in milliseconds
 * @returns Exit status
 * @throws ESRCH if process doesn't exist
 * @throws ECHILD if process is not a child
 * @throws ETIMEDOUT if timeout exceeded
 */
export async function wait(
    self: Kernel,
    caller: Process,
    pid: number,
    timeout?: number
): Promise<ExitStatus> {
    const target = self.processes.resolvePid(caller, pid);
    if (!target) {
        throw new ESRCH(`No such process: ${pid}`);
    }

    // Permission check: can only wait on children
    if (target.parent !== caller.id) {
        throw new ECHILD(`Process ${pid} is not a child`);
    }

    // Fast path: already zombie
    if (target.state === 'zombie') {
        const status: ExitStatus = { pid, code: target.exitCode ?? 0 };
        reapZombie(self, caller, pid, target);
        return status;
    }

    // Slow path: wait for exit
    return new Promise<ExitStatus>((resolve, reject) => {
        // Timeout handling
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        // Create waiter entry with cleanup
        const waiterEntry = {
            callback: (status: ExitStatus) => {
                // Clear timeout if set
                if (timeoutId !== undefined) {
                    self.deps.clearTimeout(timeoutId);
                }
                // Reap zombie
                reapZombie(self, caller, pid, target);
                resolve({ ...status, pid });
            },
            cleanup: () => {
                // Remove this waiter from the list
                const waiters = self.waiters.get(target.id);
                if (waiters) {
                    const idx = waiters.indexOf(waiterEntry);
                    if (idx !== -1) {
                        waiters.splice(idx, 1);
                    }
                    if (waiters.length === 0) {
                        self.waiters.delete(target.id);
                    }
                }
            },
        };

        // Add to waiters list
        const waiters = self.waiters.get(target.id) ?? [];
        waiters.push(waiterEntry);
        self.waiters.set(target.id, waiters);

        // Setup timeout if specified
        if (timeout !== undefined && timeout > 0) {
            timeoutId = self.deps.setTimeout(() => {
                // Clean up waiter before rejecting
                // RACE FIX: This prevents memory leak if timeout fires
                waiterEntry.cleanup();
                reject(new ETIMEDOUT(`wait() timed out after ${timeout}ms`));
            }, timeout);
        }
    });
}
