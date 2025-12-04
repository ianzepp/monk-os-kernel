/**
 * Exit the current process (syscall handler).
 *
 * CLEANUP PERFORMED:
 * 1. Set exit code and state to zombie
 * 2. Close all handles
 * 3. Terminate worker
 * 4. Reparent children to init
 * 5. Notify waiters
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
 * Exit the current process.
 *
 * @param self - Kernel instance
 * @param proc - Process to exit
 * @param code - Exit code
 * @returns Never returns (throws ProcessExited)
 */
export async function exit(self: Kernel, proc: Process, code: number): Promise<never> {
    proc.exitCode = code;
    proc.state = 'zombie';

    printk(self, 'exit', `${proc.cmd} exiting with code ${code}`);

    // Close all handles
    // WHY AWAIT: Graceful close may need to flush buffers
    for (const [h] of proc.handles) {
        try {
            await closeHandle(self, proc, h);
        } catch (err) {
            // Log but continue - don't let one bad handle prevent cleanup
            printk(self, 'cleanup', `handle ${h} close failed: ${formatError(err)}`);
        }
    }

    // Terminate worker
    // NOTE: This is synchronous - just sends terminate signal
    proc.worker.terminate();

    // Reparent children to init
    self.processes.reparentOrphans(proc.id);

    // Notify waiters
    notifyWaiters(self, proc);

    // Signal to syscall handler that process has exited
    throw new ProcessExited(code);
}
