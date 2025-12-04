/**
 * Zombie Reaping - Remove zombie process from process table
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Final cleanup step for a process. After a parent successfully wait()s on
 * a child, the zombie process is reaped:
 * 1. Removed from parent's child map (PID freed)
 * 2. Removed from global process table (UUID freed)
 * 3. Process object becomes eligible for garbage collection
 *
 * Without reaping, zombie processes accumulate in the process table,
 * eventually exhausting the system.
 *
 * INVARIANTS
 * ==========
 * INV-1: Zombie must be in parent's child map
 *        VIOLATED BY: Reaping process that's not a child
 * INV-2: Zombie must be in global process table
 *        VIOLATED BY: Double-reaping same zombie
 * INV-3: Zombie state must be 'zombie'
 *        VIOLATED BY: Reaping running/stopped process
 *
 * CONCURRENCY MODEL
 * =================
 * Reaping is synchronous and safe:
 * - Zombie processes are immutable (state='zombie', can't change)
 * - Parent owns PID namespace (exclusive access)
 * - Process table operations are synchronous
 *
 * NOTE: No race conditions because zombies can't transition to other states.
 *
 * @module kernel/kernel/reap-zombie
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { printk } from './printk.js';

/**
 * Reap a zombie process (final cleanup).
 *
 * WHY SEPARATE FUNCTION: Called from both wait() paths (fast and slow).
 * WHY DELETE FROM PARENT: Frees PID for reuse in parent's namespace.
 * WHY UNREGISTER: Removes from global process table, allows GC.
 *
 * ALGORITHM:
 * 1. Remove from parent's child map (frees PID)
 * 2. Unregister from global process table (frees UUID)
 * 3. Log reap event for debugging
 *
 * CLEANUP RESPONSIBILITY:
 * Reaping is the FINAL cleanup step. Prior cleanup happens in:
 * - exit(): Handle cleanup, worker termination
 * - forceExit(): Emergency cleanup, worker termination
 * - wait(): Timeout cleanup, waiter removal
 *
 * After reaping:
 * - Process object has no references
 * - Garbage collector will free memory
 * - PID can be reused by parent
 * - UUID will never be reused (unique forever)
 *
 * @param self - Kernel instance
 * @param parent - Parent process that waited
 * @param pid - PID in parent's namespace
 * @param zombie - Zombie process to reap
 */
export function reapZombie(
    self: Kernel,
    parent: Process,
    pid: number,
    zombie: Process
): void {
    // Remove from parent's child map
    // WHY: Frees PID for reuse in parent's namespace
    parent.children.delete(pid);

    // Remove from global process table
    // WHY: Process no longer queryable, ready for GC
    self.processes.unregister(zombie.id);

    // Log reap event for debugging
    printk(self, 'reap', `Reaped zombie ${zombie.cmd} (PID ${pid})`);
}
