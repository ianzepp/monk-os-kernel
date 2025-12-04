/**
 * Process Wait - Wait for child process to exit (wait syscall)
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Implements the wait() syscall which blocks the caller until a child process
 * exits. Supports optional timeout for non-blocking scenarios. The function
 * handles two paths:
 * 1. Fast path: Child already zombie (return immediately)
 * 2. Slow path: Child still running (register callback and wait)
 *
 * Wait is critical for preventing zombie process leaks - parents must wait()
 * on children to reap their exit status and free process table entries.
 *
 * INVARIANTS
 * ==========
 * INV-1: Can only wait on child processes
 *        VIOLATED BY: Waiting on non-child (sibling, grandchild, etc.)
 * INV-2: Zombie must be reaped after wait returns
 *        VIOLATED BY: Not calling reapZombie in success path
 * INV-3: Waiter callback must be removed on timeout
 *        VIOLATED BY: Not calling cleanup() in timeout handler
 * INV-4: Timeout must be cleared on successful wait
 *        VIOLATED BY: Not calling clearTimeout in callback
 * INV-5: Wait must return ExitStatus with correct PID
 *        VIOLATED BY: Returning wrong PID or missing exit code
 *
 * CONCURRENCY MODEL
 * =================
 * Wait involves async coordination between caller and child:
 *
 * FAST PATH:
 * 1. Synchronously check if child is zombie
 * 2. Synchronously reap zombie and return status
 *
 * SLOW PATH:
 * 1. Create waiter entry with callback and cleanup functions
 * 2. Add to global waiters map (keyed by child UUID)
 * 3. Setup optional timeout handler
 * 4. Async wait for child to call notifyWaiters (in exit/forceExit)
 * 5. Callback invoked with exit status, reaps zombie
 * 6. Promise resolves, syscall completes
 *
 * NOTE: Waiter callbacks are invoked synchronously from notifyWaiters which
 * runs in the exiting process's context. This ensures prompt notification.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check zombie state before registering waiter
 *       WHY: Child may exit between permission check and wait registration
 *       EFFECT: Fast path avoids unnecessary waiter registration
 * RC-2: Waiter cleanup removes callback from list
 *       WHY: Timeout may fire before child exits
 *       EFFECT: Prevents memory leak of abandoned waiter callbacks
 * RC-3: Timeout cleared in success callback
 *       WHY: Child may exit before timeout fires
 *       EFFECT: Prevents timeout from firing after successful wait
 * RC-4: Cleanup called before rejecting on timeout
 *       WHY: Promise rejection doesn't prevent memory leak
 *       EFFECT: Ensures waiter removed from list before error propagates
 *
 * MEMORY MANAGEMENT
 * =================
 * Resources created:
 * - Waiter entry (callback + cleanup) in global waiters map
 * - Optional timeout handler (cleared on success or timeout)
 * - Promise (GC'd after resolution)
 *
 * Cleanup paths:
 * - Success: Timeout cleared, zombie reaped, waiter implicitly removed
 * - Timeout: Cleanup called, timeout fires, waiter removed, promise rejected
 * - Child exit: notifyWaiters removes all waiters for that child
 *
 * TESTABILITY
 * ===========
 * - deps.setTimeout injectable for testing timeout behavior
 * - deps.clearTimeout injectable for verifying cleanup
 * - reapZombie is separate function (testable)
 * - Fast path testable by waiting on pre-zombie process
 * - Slow path testable by waiting on running process
 * - Timeout path testable by setting short timeout
 *
 * @module kernel/kernel/wait
 */

import type { Kernel } from '../kernel.js';
import type { Process, ExitStatus } from '../types.js';
import { ESRCH, ECHILD, ETIMEDOUT } from '../errors.js';
import { reapZombie } from './reap-zombie.js';

/**
 * Wait for a child process to exit (wait syscall implementation).
 *
 * WHY ASYNC: May need to wait indefinitely for child to exit.
 * WHY PERMISSION CHECK: Prevents waiting on non-child processes.
 * WHY FAST PATH: Avoid waiter registration if child already zombie.
 * WHY CLEANUP FUNCTION: Ensures waiter removed on timeout.
 *
 * ALGORITHM:
 * 1. Resolve PID to process UUID via caller's child map
 * 2. Verify target is a child (permission check)
 * 3. Fast path: If already zombie, reap and return immediately
 * 4. Slow path: Register waiter callback
 * 5. Setup optional timeout handler
 * 6. Wait for child to exit (callback invoked by notifyWaiters)
 * 7. Reap zombie and return exit status
 *
 * FAST PATH (child already zombie):
 * - Happens when parent calls wait() after child exit() completes
 * - Avoids waiter registration and Promise creation
 * - Immediate reap and return
 *
 * SLOW PATH (child still running):
 * - Happens when parent calls wait() before child exits
 * - Registers callback in global waiters map
 * - Callback invoked when child calls exit() or forceExit()
 * - Promise resolves with exit status
 *
 * TIMEOUT BEHAVIOR:
 * - If timeout specified and fires: ETIMEDOUT thrown
 * - Waiter is removed from list before throwing (prevents leak)
 * - Child continues running (timeout doesn't kill it)
 *
 * @param self - Kernel instance
 * @param caller - Process making the wait() syscall
 * @param pid - PID to wait for (in caller's namespace)
 * @param timeout - Optional timeout in milliseconds
 * @returns Exit status (PID and exit code)
 *
 * @throws ESRCH - No such process (PID not found)
 * @throws ECHILD - Process is not a child (permission denied)
 * @throws ETIMEDOUT - Wait timeout exceeded
 */
export async function wait(
    self: Kernel,
    caller: Process,
    pid: number,
    timeout?: number
): Promise<ExitStatus> {
    // =========================================================================
    // STEP 1: Resolve PID to process UUID
    // =========================================================================

    // WHY: PID is in caller's namespace, need global UUID
    // THROWS: ESRCH if PID not found in caller's children
    const target = self.processes.resolvePid(caller, pid);
    if (!target) {
        throw new ESRCH(`No such process: ${pid}`);
    }

    // =========================================================================
    // STEP 2: Permission check
    // =========================================================================

    // WHY: Can only wait on direct children (prevents wait on arbitrary process)
    // EFFECT: ECHILD thrown if target is not caller's child
    if (target.parent !== caller.id) {
        throw new ECHILD(`Process ${pid} is not a child`);
    }

    // =========================================================================
    // STEP 3: Fast path - child already zombie
    // =========================================================================

    // WHY: Avoid waiter registration if child already exited
    // OPTIMIZATION: Common case when parent waits after child finishes
    if (target.state === 'zombie') {
        const status: ExitStatus = { pid, code: target.exitCode ?? 0 };
        reapZombie(self, caller, pid, target);
        return status;
    }

    // =========================================================================
    // STEP 4: Slow path - register waiter and wait for exit
    // =========================================================================

    return new Promise<ExitStatus>((resolve, reject) => {
        // Timeout tracking (cleared on success or fires on timeout)
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        // Create waiter entry with callback and cleanup
        const waiterEntry = {
            /**
             * Invoked by notifyWaiters when child exits.
             * Receives exit status, clears timeout, reaps zombie, resolves promise.
             */
            callback: (status: ExitStatus) => {
                // Clear timeout if it was set
                // RACE FIX: Child may exit before timeout fires
                if (timeoutId !== undefined) {
                    self.deps.clearTimeout(timeoutId);
                }

                // Reap zombie to free process table entry
                // WHY: Parent's responsibility to clean up child
                reapZombie(self, caller, pid, target);

                // Resolve promise with correct PID (status has pid=0 from notifyWaiters)
                resolve({ ...status, pid });
            },

            /**
             * Removes this waiter from the waiters list.
             * Called on timeout to prevent memory leak.
             */
            cleanup: () => {
                const waiters = self.waiters.get(target.id);
                if (waiters) {
                    const idx = waiters.indexOf(waiterEntry);
                    if (idx !== -1) {
                        waiters.splice(idx, 1);
                    }
                    // Clean up empty waiter lists
                    if (waiters.length === 0) {
                        self.waiters.delete(target.id);
                    }
                }
            },
        };

        // Add to global waiters map (keyed by child UUID)
        // WHY: Child exit() needs to find waiters to notify
        const waiters = self.waiters.get(target.id) ?? [];
        waiters.push(waiterEntry);
        self.waiters.set(target.id, waiters);

        // Setup timeout if specified
        if (timeout !== undefined && timeout > 0) {
            timeoutId = self.deps.setTimeout(() => {
                // Clean up waiter before rejecting
                // RACE FIX: This prevents memory leak if timeout fires
                waiterEntry.cleanup();

                // Reject promise with timeout error
                // NOTE: Child continues running, timeout doesn't kill it
                reject(new ETIMEDOUT(`wait() timed out after ${timeout}ms`));
            }, timeout);
        }

        // Promise remains pending until:
        // - Child calls exit/forceExit (callback invoked, promise resolves)
        // - Timeout fires (cleanup called, promise rejected)
    });
}
