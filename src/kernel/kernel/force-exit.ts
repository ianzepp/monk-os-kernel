/**
 * Force Exit - Immediate process termination without async cleanup
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Implements immediate process termination for scenarios where graceful
 * cleanup is not possible or not desired:
 * - SIGKILL signal (immediate kill)
 * - SIGTERM grace period expiry (process didn't respond)
 * - Worker errors (process in invalid state)
 * - Kernel shutdown (system going down)
 *
 * Unlike exit() which awaits handle cleanup, forceExit() is synchronous and
 * uses reference counting for handle cleanup. This prevents hangs from
 * unresponsive I/O operations.
 *
 * STATE MACHINE
 * =============
 * Force exit transitions process to zombie state immediately:
 *   running --> zombie --> [reaped]
 *   stopped --> zombie --> [reaped]
 *              ^^^^^^^
 *              Transitions here
 *
 * INVARIANTS
 * ==========
 * INV-1: Idempotent - multiple calls must be safe
 *        VIOLATED BY: Not checking proc.state === 'zombie'
 * INV-2: Worker must be terminated immediately
 *        VIOLATED BY: Awaiting any operation before worker.terminate()
 * INV-3: Handles must be released via refcounting (not async close)
 *        VIOLATED BY: Awaiting handle.close()
 * INV-4: Waiters must be notified to prevent deadlock
 *        VIOLATED BY: Not calling notifyWaiters()
 * INV-5: Active streams must be aborted
 *        VIOLATED BY: Not aborting activeStreams
 *
 * CONCURRENCY MODEL
 * =================
 * This function is synchronous and designed for emergency cleanup:
 *
 * 1. SAFE: Idempotency check (zombie guard)
 * 2. SAFE: State transition (synchronous assignment)
 * 3. SAFE: Worker termination (synchronous, no await)
 * 4. SAFE: Stream abortion (synchronous, no await)
 * 5. SAFE: Handle cleanup (synchronous refcount decrement)
 * 6. SAFE: Worker pool release (async but fire-and-forget)
 * 7. SAFE: Reparenting (synchronous)
 * 8. SAFE: Waiter notification (synchronous)
 *
 * NOTE: No async operations block this function. Cleanup that needs async
 * (like handle.close()) is deferred to background via refcounting.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Idempotency guard at start (check state === 'zombie')
 *       WHY: Multiple threads may call forceExit concurrently
 *       EFFECT: First call wins, subsequent calls are no-ops
 * RC-2: Stream abortion before handle cleanup
 *       WHY: Streams may be blocked on I/O operations
 *       EFFECT: Unblocks any syscalls waiting for stream completion
 * RC-3: Handle cleanup uses unrefHandle, not async close()
 *       WHY: Async close might hang on unresponsive I/O
 *       EFFECT: Refcount decrements immediately, actual close happens later
 * RC-4: Worker release is fire-and-forget
 *       WHY: Pool release shouldn't block process cleanup
 *       EFFECT: Errors logged but don't prevent cleanup
 *
 * MEMORY MANAGEMENT
 * =================
 * Resources cleaned up synchronously:
 * - Worker thread terminated (thread destroyed)
 * - Active streams aborted (AbortController signals)
 * - Stream ping handlers cleared (timeout IDs cancelled)
 * - Handle refcounts decremented (actual close happens async)
 * - Process handles map cleared
 *
 * Resources cleaned up asynchronously (fire-and-forget):
 * - Worker pool workers released (logged on error)
 * - Handle close operations (background, may fail)
 *
 * Resources not cleaned up (parent's responsibility):
 * - Process table entry (removed in reapZombie)
 * - Parent's child map entry (removed in reapZombie)
 *
 * TESTABILITY
 * ===========
 * - Idempotency testable by calling twice
 * - unrefHandle is separate function (testable)
 * - notifyWaiters is separate function (testable)
 * - No hidden state mutations (all operations visible)
 *
 * @module kernel/kernel/force-exit
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { unrefHandle } from './unref-handle.js';
import { releaseProcessWorkers } from './release-process-workers.js';
import { notifyWaiters } from './notify-waiters.js';
import { printk } from './printk.js';

/**
 * Force exit a process immediately without async cleanup.
 *
 * WHY SYNCHRONOUS: Emergency shutdown can't wait for I/O operations.
 * WHY IDEMPOTENT: May be called multiple times (SIGKILL, timeout, error).
 * WHY REFCOUNTING: Async close might hang, refcount allows background cleanup.
 * WHY ABORT STREAMS: Unblocks syscalls waiting for response.
 *
 * ALGORITHM:
 * 1. Check if already zombie (idempotency guard)
 * 2. Set exit code and transition to zombie state
 * 3. Terminate worker thread immediately
 * 4. Abort all active syscall streams
 * 5. Clear stream ping handlers
 * 6. Decrement handle refcounts (async close happens in background)
 * 7. Clear process handle map
 * 8. Release worker pool workers (fire-and-forget)
 * 9. Reparent orphaned children to init
 * 10. Notify waiting parents
 *
 * IDEMPOTENCY:
 * Multiple calls are safe due to state === 'zombie' guard.
 * This is critical because forceExit can be triggered from:
 * - SIGKILL handler
 * - SIGTERM timeout
 * - Worker error handler
 * - Kernel shutdown
 *
 * CLEANUP STRATEGY:
 * Handles are cleaned via unrefHandle which decrements refcount and schedules
 * async close in background. This prevents hang if handle.close() blocks on
 * unresponsive I/O (e.g., network timeout, disk error).
 *
 * @param self - Kernel instance
 * @param proc - Process to force exit
 * @param code - Exit code (typically 128 + signal number)
 */
export function forceExit(self: Kernel, proc: Process, code: number): void {
    // =========================================================================
    // STEP 1: Idempotency guard
    // =========================================================================

    // WHY: Multiple code paths may call forceExit (SIGKILL, timeout, error)
    // SAFETY: First call wins, cleanup runs exactly once
    if (proc.state === 'zombie') {
        return;
    }

    printk(self, 'exit', `Force exiting ${proc.cmd} with code ${code}`);

    // =========================================================================
    // STEP 2: Transition to zombie state
    // =========================================================================

    // WHY FIRST: Prevents new syscalls from starting
    // WHY ZOMBIE: Parent can query exit status via wait()
    proc.exitCode = code;
    proc.state = 'zombie';

    // =========================================================================
    // STEP 3: Terminate worker thread immediately
    // =========================================================================

    // WHY IMMEDIATE: Don't wait for I/O or cleanup
    // EFFECT: Worker thread stops executing, memory released
    // NOTE: Synchronous operation, just sends termination signal
    // VIRTUAL: Skip for virtual processes - they share parent's Worker
    // KERNEL: Skip for kernel process - it has no Worker
    if (!proc.virtual && proc.worker) {
        proc.worker.terminate();
    }

    // =========================================================================
    // STEP 4: Abort all active syscall streams
    // =========================================================================

    // WHY: Streams may be blocked on await, abort signals them to stop
    // EFFECT: Any syscall waiting for next response will abort
    // CRITICAL: Must happen before handle cleanup to unblock I/O
    for (const abort of proc.activeStreams.values()) {
        abort.abort();
    }

    proc.activeStreams.clear();

    // =========================================================================
    // STEP 5: Clear stream ping handlers
    // =========================================================================

    // WHY: Prevents timeout handlers from firing after process is dead
    // MEMORY: Prevents leak of timeout objects
    proc.streamPingHandlers.clear();

    // =========================================================================
    // STEP 6: Clean up handles with refcounting
    // =========================================================================

    // -------------------------------------------------------------------------
    // FIRE-AND-FORGET: unrefHandle -> handle.close()
    // -------------------------------------------------------------------------
    //
    // WHAT: unrefHandle decrements refcount synchronously, then calls
    // handle.close() without awaiting. Close runs in background.
    //
    // WHY: forceExit must be synchronous and non-blocking. This function is
    // called in emergency situations:
    // - SIGKILL (immediate termination)
    // - SIGTERM grace period expired (process unresponsive)
    // - Worker errors (process in invalid state)
    // - Kernel shutdown
    //
    // If we awaited close(), a stuck I/O operation could hang the kernel
    // indefinitely. Since the worker is already terminated (step 3), there's
    // no process to use these handles anyway.
    //
    // TRADE-OFF: Handles may not be fully closed when forceExit returns.
    // This is acceptable because:
    // 1. Worker is terminated - no code can use the handles
    // 2. Handles are removed from tables - no new references possible
    // 3. OS will clean up leaked resources on kernel exit
    // 4. For graceful shutdown (SIGTERM), use interruptProcess() first
    //
    for (const handleId of proc.handles.values()) {
        unrefHandle(self, handleId);
    }

    proc.handles.clear();

    // =========================================================================
    // STEP 7: Release worker pool workers
    // =========================================================================

    // WHY: Process may have leased workers from pool
    // FIRE-AND-FORGET: Errors logged but don't block cleanup
    // MEMORY: Returns workers to pool for reuse
    releaseProcessWorkers(self, proc);

    // =========================================================================
    // STEP 8: Reparent orphaned children to init
    // =========================================================================

    // WHY: Children need a parent to reap them when they exit
    // WHO: init process is designated as universal orphan collector
    // EFFECT: Updates child.parent to point to init's UUID
    self.processes.reparentOrphans(proc.id);

    // =========================================================================
    // STEP 9: Notify waiting parents
    // =========================================================================

    // WHY: Parent may be blocked in wait() syscall
    // EFFECT: Calls waiter callbacks with exit status
    // CLEANUP: Waiter list is cleared in notifyWaiters
    notifyWaiters(self, proc);
}
