/**
 * Release all workers when a process exits.
 *
 * @module kernel/kernel/release-process-workers
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Release all workers when a process exits.
 *
 * @param self - Kernel instance
 * @param proc - Process that is exiting
 */
export function releaseProcessWorkers(self: Kernel, proc: Process): void {
    const procWorkers = self.leasedWorkers.get(proc.id);
    if (procWorkers) {
        for (const [workerId, worker] of procWorkers.entries()) {
            worker.release().catch((err: unknown) => {
                printk(self, 'cleanup', `worker ${workerId} release failed: ${formatError(err)}`);
            });
        }
        self.leasedWorkers.delete(proc.id);
    }
}
