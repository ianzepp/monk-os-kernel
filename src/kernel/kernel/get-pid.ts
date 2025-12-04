/**
 * Get current process ID (in parent's namespace).
 *
 * WHY -1 ON ERROR: Unlike 0 (which could be confused with a valid PID
 * in some contexts), -1 clearly indicates an error condition.
 *
 * @module kernel/kernel/get-pid
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { printk } from './printk.js';

/**
 * Get current process ID.
 *
 * @param self - Kernel instance
 * @param proc - Current process
 * @returns PID, or 1 for init, or -1 on error
 */
export function getpid(self: Kernel, proc: Process): number {
    // Init is always PID 1
    const parent = self.processes.get(proc.parent);
    if (!parent) {
        return 1;
    }

    // Find our PID in parent's children map
    for (const [pid, id] of parent.children) {
        if (id === proc.id) {
            return pid;
        }
    }

    // Should never happen if invariants hold
    printk(self, 'warn', `getpid: process ${proc.id} not found in parent's children`);
    return -1;
}
