/**
 * Get Parent Process ID - Return parent's PID in grandparent's namespace
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Returns the calling process's parent PID as it appears in the grandparent's
 * namespace. This requires traversing up two levels in the process tree:
 * 1. Find parent process
 * 2. Find grandparent process
 * 3. Search grandparent's children for parent's UUID
 * 4. Return corresponding PID
 *
 * Special cases:
 * - Init process (no parent): returns 0 (init has no parent)
 * - Parent is init: returns 1 (init's PID in its own namespace)
 * - Parent not found (orphaned): returns 1 (reparented to init)
 * - Grandparent not found: returns 1 (parent is init)
 *
 * INVARIANTS
 * ==========
 * INV-1: Init process (empty parent) returns 0
 *        VIOLATED BY: Init returning non-zero PPID
 * INV-2: Process with parent=init returns 1
 *        VIOLATED BY: Direct init child returning wrong PPID
 * INV-3: Function must always return (never throw)
 *        VIOLATED BY: Throwing on lookup failure
 *
 * CONCURRENCY MODEL
 * =================
 * getppid is synchronous and reads process state:
 * - No modifications to process state
 * - No async operations
 * - Safe to call concurrently from multiple processes
 *
 * NOTE: PPID can change if parent dies (we get reparented to init).
 * This is expected behavior.
 *
 * @module kernel/kernel/get-ppid
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';

/**
 * Get parent process ID in grandparent's namespace.
 *
 * WHY 0 FOR INIT: POSIX convention, init has no parent (PPID = 0).
 * WHY 1 FOR ORPHANS: Orphaned processes are reparented to init (PID 1).
 * WHY GRANDPARENT LOOKUP: PPID is in grandparent's namespace, not global.
 *
 * ALGORITHM:
 * 1. Check if process has parent (empty parent = init)
 * 2. If no parent, return 0 (init has no parent)
 * 3. Look up parent process by UUID
 * 4. If no parent found, return 1 (reparented to init)
 * 5. Look up grandparent process by parent's parent UUID
 * 6. If no grandparent found, return 1 (parent is init)
 * 7. Search grandparent's children for parent's UUID
 * 8. Return PID if found, 1 if not found
 *
 * SPECIAL CASES:
 * - Init (no parent): Returns 0
 * - Child of init (no grandparent): Returns 1
 * - Orphaned (parent died): Returns 1 (logically reparented)
 * - Not in grandparent's children: Returns 1 (assume parent is init)
 *
 * REPARENTING:
 * When a process's parent exits, the process is reparented to init. This
 * function returns 1 in that case (init's PID), which is correct.
 *
 * @param self - Kernel instance
 * @param proc - Current process (caller)
 * @returns Parent PID in grandparent's namespace, 0 for init, 1 if reparented
 */
export function getppid(self: Kernel, proc: Process): number {
    // =========================================================================
    // CASE 1: Init process (no parent)
    // =========================================================================

    // WHY: Init is the root, has no parent
    // POSIX: getppid() returns 0 for init
    if (!proc.parent) {
        return 0;
    }

    // =========================================================================
    // CASE 2: Parent exists, find parent's PID
    // =========================================================================

    // Look up parent process
    const parent = self.processes.get(proc.parent);
    if (!parent) {
        // Parent died, we're orphaned (reparented to init)
        // WHY 1: Init's PID is always 1
        return 1;
    }

    // =========================================================================
    // CASE 3: Parent is init (no grandparent)
    // =========================================================================

    // Look up grandparent process
    const grandparent = self.processes.get(parent.parent);
    if (!grandparent) {
        // Parent is init (or orphaned)
        // WHY 1: Parent's PID is 1 in its namespace
        return 1;
    }

    // =========================================================================
    // CASE 4: Normal case - find parent's PID in grandparent's namespace
    // =========================================================================

    // Search grandparent's children for parent's UUID
    // WHY LINEAR SEARCH: Map is keyed by PID, need to find PID for UUID
    for (const [pid, id] of grandparent.children) {
        if (id === parent.id) {
            return pid;
        }
    }

    // =========================================================================
    // CASE 5: Parent not in grandparent's children (orphaned)
    // =========================================================================

    // This can happen if parent was reparented after we were created
    // WHY 1: Assume parent is logically init
    return 1;
}
