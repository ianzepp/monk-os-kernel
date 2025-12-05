/**
 * Get Process ID - Return process's PID in parent's namespace
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Returns the calling process's PID as it appears in the parent's namespace.
 * Each parent maintains its own PID namespace via a Map<number, string> from
 * PID to child UUID. To find our PID, we must:
 * 1. Look up parent process
 * 2. Search parent's children map for our UUID
 * 3. Return the corresponding PID
 *
 * Special cases:
 * - Init process has no parent: returns 1 (PID 1 by convention)
 * - Parent not found (orphaned): returns 1 (reparented to init)
 * - Not in parent's children (invariant violation): returns -1 and logs error
 *
 * INVARIANTS
 * ==========
 * INV-1: Process must exist in parent's children map
 *        VIOLATED BY: Parent removed child but child still running
 * INV-2: Init process (no parent) always returns PID 1
 *        VIOLATED BY: Init having non-empty parent field
 * INV-3: Function must always return (never throw)
 *        VIOLATED BY: Throwing on lookup failure
 *
 * CONCURRENCY MODEL
 * =================
 * getpid is synchronous and reads process state:
 * - No modifications to process state
 * - No async operations
 * - Safe to call concurrently from multiple processes
 *
 * NOTE: PID can change if process is reparented (parent dies, init adopts).
 * This is rare but possible.
 *
 * @module kernel/kernel/get-pid
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { printk } from './printk.js';

/**
 * Get current process ID in parent's namespace.
 *
 * WHY -1 ON ERROR: Unlike 0 (which could be confused with valid PID in some
 * contexts), -1 clearly indicates an error condition.
 * WHY SEARCH: PID is not stored on process, must reverse-lookup in parent.
 * WHY INIT=1: POSIX convention, init is always PID 1.
 *
 * ALGORITHM:
 * 1. Check if process has parent (empty parent = init)
 * 2. If no parent, return 1 (init's PID)
 * 3. Look up parent process by UUID
 * 4. If no parent found, return 1 (reparented to init)
 * 5. Search parent's children map for our UUID
 * 6. Return PID if found, -1 if not found (error)
 *
 * SPECIAL CASES:
 * - Init (no parent): Returns 1
 * - Orphaned (parent died): Returns 1 (logically reparented)
 * - Not in parent's children: Returns -1 and logs error
 *
 * ERROR CONDITION:
 * Returning -1 indicates an invariant violation - process should always be
 * in parent's children map if parent exists. This should never happen in
 * correct code, but we handle gracefully and log for debugging.
 *
 * @param self - Kernel instance
 * @param proc - Current process (caller)
 * @returns PID in parent's namespace, 1 for init, -1 on error
 */
export function getpid(self: Kernel, proc: Process): number {
    // =========================================================================
    // CASE 1: Init process (no parent)
    // =========================================================================

    // WHY: Init is the root of the process tree, has no parent
    // CONVENTION: Init is always PID 1 in POSIX systems
    const parent = self.processes.get(proc.parent);

    if (!parent) {
        return 1;
    }

    // =========================================================================
    // CASE 2: Normal process (has parent)
    // =========================================================================

    // Search parent's children map for our UUID
    // WHY LINEAR SEARCH: Map is keyed by PID, need to find PID for UUID
    // PERFORMANCE: Typically small number of children per parent
    for (const [pid, id] of parent.children) {
        if (id === proc.id) {
            return pid;
        }
    }

    // =========================================================================
    // CASE 3: Error - not in parent's children (should never happen)
    // =========================================================================

    // This indicates an invariant violation:
    // - Process has parent, but parent doesn't have this child
    // - May happen if parent cleanup runs before child cleanup
    // - Should be impossible with correct process lifecycle
    printk(self, 'warn', `getpid: process ${proc.id} not found in parent's children`);

    return -1;
}
