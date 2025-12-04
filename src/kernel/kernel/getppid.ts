/**
 * Get parent process ID (in grandparent's namespace).
 *
 * @module kernel/kernel/getppid
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';

/**
 * Get parent process ID.
 *
 * @param self - Kernel instance
 * @param proc - Current process
 * @returns Parent PID, or 0 for init (no parent), or 1 if reparented
 */
export function getppid(self: Kernel, proc: Process): number {
    // Init has no parent
    if (!proc.parent) {
        return 0;
    }

    const parent = self.processes.get(proc.parent);
    if (!parent) {
        return 1; // Reparented to init
    }

    // Find parent's PID in grandparent's namespace
    const grandparent = self.processes.get(parent.parent);
    if (!grandparent) {
        return 1; // Parent is init
    }

    for (const [pid, id] of grandparent.children) {
        if (id === parent.id) {
            return pid;
        }
    }

    return 1;
}
