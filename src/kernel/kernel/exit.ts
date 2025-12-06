/**
 * Process Exit - Graceful process termination with cleanup
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Implements graceful process exit with full resource cleanup. This is the
 * standard path for normal process termination (when a process calls the
 * exit() syscall). The process transitions to zombie state and performs
 * cleanup in order:
 * 1. Set exit code and zombie state
 * 2. Close all file descriptors (async, may flush buffers)
 * 3. Terminate worker thread
 * 4. Reparent orphaned children to init
 * 5. Notify waiting parents
 * 6. Signal syscall handler (throw ProcessExited)
 *
 * Compare with forceExit() which skips async cleanup for immediate shutdown.
 *
 * STATE MACHINE
 * =============
 * Exit transitions process to zombie state:
 *   running --> zombie --> [reaped]
 *              ^^^^^^^
 *              Transitions here
 *
 * Zombie processes remain in process table until parent reaps them via wait().
 * If parent exits before reaping, init inherits and reaps the zombie.
 *
 * INVARIANTS
 * ==========
 * INV-1: Process must transition to zombie before cleanup starts
 *        VIOLATED BY: Starting cleanup while state is still 'running'
 * INV-2: All handles must be closed before worker terminates
 *        VIOLATED BY: Terminating worker with open handles
 * INV-3: Children must be reparented before notifying waiters
 *        VIOLATED BY: Leaving orphaned children with no parent
 * INV-4: Waiters must be notified so they don't block forever
 *        VIOLATED BY: Not calling notifyWaiters()
 * INV-5: Function must throw ProcessExited (never returns)
 *        VIOLATED BY: Returning normally from exit()
 *
 * CONCURRENCY MODEL
 * =================
 * Exit is async and must handle cleanup with potential failures:
 *
 * 1. State transition is synchronous (zombie immediately)
 * 2. Handle closing is async (may need to flush buffers)
 * 3. Worker termination is synchronous (just sends signal)
 * 4. Reparenting is synchronous (updates process table)
 * 5. Waiter notification is synchronous (calls callbacks)
 *
 * NOTE: Once zombie state is set, process cannot receive new syscalls.
 * Any in-flight syscalls will complete or be aborted.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: State set to zombie BEFORE cleanup starts
 *       WHY: Prevents new syscalls from starting during cleanup
 *       EFFECT: Syscall dispatcher rejects calls from zombie processes
 * RC-2: Handle close errors are logged but don't stop cleanup
 *       WHY: One bad handle shouldn't prevent other cleanup
 *       SAFETY: Continue even if individual handle.close() throws
 * RC-3: Worker terminated AFTER handles closed
 *       WHY: Worker termination is immediate, handles may need async flush
 *       ORDERING: Ensures buffers are flushed before killing thread
 * RC-4: Throws ProcessExited to abort syscall handler
 *       WHY: Syscall must not return normally after exit
 *       EFFECT: Dispatcher catches and stops response stream
 *
 * MEMORY MANAGEMENT
 * =================
 * Resources cleaned up in exit():
 * - File descriptors closed (proc.handles cleared)
 * - Worker thread terminated (thread destroyed)
 * - Active streams aborted (implicit via worker termination)
 * - Waiter callbacks invoked (waiters list cleared in notifyWaiters)
 *
 * Resources NOT cleaned up (parent's responsibility):
 * - Process table entry (removed in reapZombie)
 * - Parent's child map entry (removed in reapZombie)
 * - Zombie process object (GC'd after reaping)
 *
 * TESTABILITY
 * ===========
 * - closeHandle is a separate function (testable in isolation)
 * - notifyWaiters is a separate function (testable in isolation)
 * - Exit throws predictably (testable by catching ProcessExited)
 * - Error handling logs failures (verifiable in test output)
 *
 * @module kernel/kernel/exit
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { ProcessExited } from '../errors.js';
import { closeHandle } from './close-handle.js';
import { notifyWaiters } from './notify-waiters.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Exit the current process gracefully with full cleanup.
 *
 * WHY ASYNC: Handle closing may need to flush buffers to disk/network.
 * WHY ZOMBIE: Process must remain queryable until parent reaps it.
 * WHY REPARENT: Orphaned children need init as new parent.
 * WHY THROW: Syscall handler must not return normally after exit.
 *
 * ALGORITHM:
 * 1. Set exit code and transition to zombie state (atomic)
 * 2. Log exit event for debugging
 * 3. Close all file descriptors (async, may flush buffers)
 * 4. Terminate worker thread (sync, just sends signal)
 * 5. Reparent children to init (sync)
 * 6. Notify waiting parents (sync, calls callbacks)
 * 7. Throw ProcessExited to abort syscall handler
 *
 * CLEANUP ORDER:
 * Handles closed BEFORE worker terminated because:
 * - Handle close may need to send final messages to worker
 * - Worker termination is immediate and irreversible
 * - Flushing buffers requires worker to still be alive
 *
 * ERROR HANDLING:
 * Individual handle close errors are logged but don't stop cleanup.
 * This prevents one corrupted handle from leaking other resources.
 *
 * @param self - Kernel instance
 * @param proc - Process to exit (caller)
 * @param code - Exit code (0 = success, non-zero = failure)
 * @returns Never returns (throws ProcessExited)
 *
 * @throws ProcessExited - Always thrown to signal exit to syscall dispatcher
 */
export async function exit(self: Kernel, proc: Process, code: number): Promise<never> {
    // =========================================================================
    // STEP 1: Transition to zombie state (atomic)
    // =========================================================================

    // WHY FIRST: Prevents new syscalls from starting during cleanup
    // WHY ZOMBIE: Parent can still query exit status via wait()
    proc.exitCode = code;
    proc.state = 'zombie';

    printk(self, 'exit', `${proc.cmd} exiting with code ${code}`);

    // =========================================================================
    // STEP 2: Close all file descriptors (async)
    // =========================================================================

    // WHY AWAIT: Graceful close may need to flush write buffers
    // ERROR HANDLING: Log failures but continue cleanup
    // MEMORY: Each successful close releases handle from global table
    for (const [h] of proc.handles) {
        try {
            await closeHandle(self, proc, h);
        }
        catch (err) {
            // Log but continue - don't let one bad handle prevent cleanup
            // WHY: One corrupted handle shouldn't leak all other handles
            printk(self, 'cleanup', `handle ${h} close failed: ${formatError(err)}`);
        }
    }

    // =========================================================================
    // STEP 3: Terminate worker thread (synchronous)
    // =========================================================================

    // WHY AFTER HANDLES: Handles may need worker alive for final operations
    // NOTE: terminate() is synchronous - just sends termination signal
    // EFFECT: Worker thread stops executing, memory is released
    // VIRTUAL: Skip for virtual processes - they share parent's Worker
    if (!proc.virtual) {
        proc.worker.terminate();
    }

    // =========================================================================
    // STEP 4: Reparent orphaned children to init (synchronous)
    // =========================================================================

    // WHY: Children need a parent to reap them when they exit
    // WHO: init process is designated as the universal orphan collector
    // EFFECT: Updates child.parent to point to init's UUID
    self.processes.reparentOrphans(proc.id);

    // =========================================================================
    // STEP 5: Notify waiting parents (synchronous)
    // =========================================================================

    // WHY: Parent may be blocked in wait() syscall
    // EFFECT: Calls waiter callbacks with exit status
    // CLEANUP: Waiter list is cleared in notifyWaiters
    notifyWaiters(self, proc);

    // =========================================================================
    // STEP 6: Signal syscall handler to abort
    // =========================================================================

    // WHY THROW: exit() syscall must not return normally
    // CAUGHT BY: Syscall dispatcher, which stops response stream
    // EFFECT: Process cannot make more syscalls after exit
    throw new ProcessExited(code);
}
