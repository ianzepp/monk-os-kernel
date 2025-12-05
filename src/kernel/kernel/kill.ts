/**
 * Process Signaling - Send signals to processes (kill syscall)
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Implements the kill() syscall which sends signals to processes. Supports
 * SIGTERM (graceful termination) and SIGKILL (immediate termination). The
 * permission model allows:
 * - Process can signal itself
 * - Process can signal its children
 * - Init can signal anyone (superuser equivalent)
 *
 * SIGTERM provides a grace period for cleanup before forcing termination.
 * SIGKILL terminates immediately with no grace period.
 *
 * INVARIANTS
 * ==========
 * INV-1: Target process must exist in process table
 *        VIOLATED BY: Invalid PID passed to kill()
 * INV-2: Caller must have permission to signal target
 *        VIOLATED BY: Random process trying to kill system process
 * INV-3: SIGKILL must terminate immediately
 *        VIOLATED BY: Allowing process to handle SIGKILL
 * INV-4: SIGTERM must provide grace period before force kill
 *        VIOLATED BY: Immediate termination on SIGTERM
 * INV-5: Grace period timeout must cleanup zombie if process doesn't exit
 *        VIOLATED BY: Not calling forceExit after grace period
 *
 * CONCURRENCY MODEL
 * =================
 * Signal delivery is synchronous but has async consequences:
 *
 * 1. SYNCHRONOUS: Permission check and PID resolution
 * 2. SYNCHRONOUS: SIGKILL handler (calls forceExit)
 * 3. SYNCHRONOUS: SIGTERM delivery to process
 * 4. ASYNCHRONOUS: Grace period timeout (scheduled via setTimeout)
 *
 * NOTE: Grace period timeout is fire-and-forget. If process exits before
 * timeout, it transitions to zombie and the check in timeout handler sees
 * state !== 'running' and skips force kill.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Grace period check verifies state === 'running'
 *       WHY: Process may exit gracefully before timeout fires
 *       EFFECT: Prevents force kill of already-dead process
 * RC-2: Permission check before signal delivery
 *       WHY: Prevents privilege escalation via signal injection
 *       EFFECT: EPERM thrown if caller lacks permission
 * RC-3: SIGTERM timeout uses closure over target process
 *       WHY: Process reference must be valid when timeout fires
 *       EFFECT: Safe to check process state in timeout handler
 *
 * MEMORY MANAGEMENT
 * =================
 * Resources created:
 * - Timeout for SIGTERM grace period (auto-cancelled if process exits)
 *
 * Cleanup occurs:
 * - If process exits before grace period: timeout fires but no-ops
 * - If grace period expires: forceExit cleans up everything
 *
 * TESTABILITY
 * ===========
 * - deps.setTimeout injectable for testing grace period timing
 * - deliverSignal is separate function (testable)
 * - forceExit is separate function (testable)
 * - Permission model testable via different process hierarchies
 *
 * @module kernel/kernel/kill
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { SIGTERM, SIGKILL, TERM_GRACE_MS } from '../types.js';
import { ESRCH, EPERM } from '../errors.js';
import { forceExit } from './force-exit.js';
import { deliverSignal } from './deliver-signal.js';
import { printk } from './printk.js';

/**
 * Send signal to a process (kill syscall implementation).
 *
 * WHY PID NOT UUID: Caller uses PID from their namespace, not global UUID.
 * WHY PERMISSION CHECK: Prevents arbitrary process from killing system services.
 * WHY GRACE PERIOD: Gives process time to cleanup before force termination.
 * WHY STATE CHECK: Prevents force kill if process already exited gracefully.
 *
 * ALGORITHM:
 * 1. Resolve PID to process UUID via caller's child map
 * 2. Check permission (self, child, or init)
 * 3. If SIGKILL: Force exit immediately
 * 4. If SIGTERM: Deliver signal and schedule force kill timeout
 *
 * PERMISSION MODEL:
 * - Process can signal itself (any signal)
 * - Process can signal its direct children (any signal)
 * - Init process can signal anyone (superuser equivalent)
 * - All other combinations: EPERM
 *
 * GRACE PERIOD:
 * SIGTERM gives process TERM_GRACE_MS milliseconds to exit gracefully.
 * If process doesn't exit by then, forceExit is called.
 * Exit code for timeout: 128 + SIGTERM (standard convention).
 *
 * @param self - Kernel instance
 * @param caller - Process making the kill() syscall
 * @param targetPid - PID to signal (in caller's namespace)
 * @param signal - Signal number (default SIGTERM)
 *
 * @throws ESRCH - No such process (PID not found in caller's children)
 * @throws EPERM - Permission denied (caller can't signal target)
 */
export function kill(
    self: Kernel,
    caller: Process,
    targetPid: number,
    signal: number = SIGTERM,
): void {
    // =========================================================================
    // STEP 1: Resolve PID to process UUID
    // =========================================================================

    // WHY: PID is in caller's namespace, need global UUID
    // THROWS: ESRCH if PID not found in caller's children
    const target = self.processes.resolvePid(caller, targetPid);

    if (!target) {
        throw new ESRCH(`No such process: ${targetPid}`);
    }

    // =========================================================================
    // STEP 2: Permission check
    // =========================================================================

    // WHY: Prevent arbitrary process from killing system processes
    // ALLOWED: Self-signal, parent->child signal, init->anyone
    // DENIED: All other combinations (EPERM)
    if (target.parent !== caller.id && target.id !== caller.id) {
        const init = self.processes.getInit();

        if (caller !== init) {
            throw new EPERM(`Cannot signal process ${targetPid}`);
        }
    }

    printk(self, 'signal', `${caller.cmd} sending signal ${signal} to PID ${targetPid}`);

    // =========================================================================
    // STEP 3: Handle signal type
    // =========================================================================

    if (signal === SIGKILL) {
        // ---------------------------------------------------------------------
        // SIGKILL: Immediate termination (no grace period)
        // ---------------------------------------------------------------------

        // WHY IMMEDIATE: SIGKILL cannot be caught or ignored
        // EXIT CODE: 128 + SIGKILL (standard convention)
        forceExit(self, target, 128 + SIGKILL);
    }
    else if (signal === SIGTERM) {
        // ---------------------------------------------------------------------
        // SIGTERM: Graceful termination with grace period
        // ---------------------------------------------------------------------

        // Step 3a: Deliver signal to process
        // WHY: Gives process chance to cleanup gracefully
        deliverSignal(self, target, SIGTERM);

        // Step 3b: Schedule force kill after grace period
        // WHY: Process may ignore SIGTERM, we enforce termination
        // RACE FIX: Check state before forcing exit (process may exit early)
        self.deps.setTimeout(() => {
            if (target.state === 'running') {
                printk(self, 'signal', `Grace period expired for ${target.cmd}, force killing`);
                forceExit(self, target, 128 + SIGTERM);
            }
            // Otherwise: Process exited gracefully, no action needed
        }, TERM_GRACE_MS);
    }
    // NOTE: Other signals not yet implemented (SIGHUP, SIGINT, etc.)
}
