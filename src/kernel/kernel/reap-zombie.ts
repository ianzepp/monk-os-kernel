/**
 * Reap a zombie process (remove from process table).
 *
 * @module kernel/kernel/reap-zombie
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { printk } from './printk.js';

/**
 * Reap a zombie process.
 *
 * @param self - Kernel instance
 * @param parent - Parent process
 * @param pid - PID in parent's namespace
 * @param zombie - Zombie process to reap
 */
export function reapZombie(
    self: Kernel,
    parent: Process,
    pid: number,
    zombie: Process
): void {
    parent.children.delete(pid);
    self.processes.unregister(zombie.id);
    printk(self, 'reap', `Reaped zombie ${zombie.cmd} (PID ${pid})`);
}
